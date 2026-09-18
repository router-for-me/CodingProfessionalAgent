import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import Module from 'node:module'
import * as electron from 'electron'
import { UpdateStateStorage } from './services/update/updateStateStorage.js'
import { getBaseBinaryVersion } from './utils/version.js'

export interface ResolveMainEntryOptions {
    isPackaged?: boolean
    storage?: UpdateStateStorage
    existsSync?: (filePath: string) => boolean
    resourcesPath?: string
}

const fallbackModulePaths: string[] = []
let fallbackResolverInstalled = false

function isBareModuleRequest(request: string): boolean {
    return (
        typeof request === 'string' &&
        request.length > 0 &&
        !request.startsWith('.') &&
        !request.startsWith('node:') &&
        !path.isAbsolute(request)
    )
}

function isModuleNotFoundError(err: unknown): boolean {
    const code = (err as NodeJS.ErrnoException | undefined)?.code
    if (code === 'MODULE_NOT_FOUND') return true
    return /cannot find module/i.test(String((err as Error | undefined)?.message || ''))
}

/**
 * NODE_PATH / Module.globalPaths are ignored by Electron's CJS loader for files
 * living in app.asar.unpacked (and by ESM entirely). Patch Module._resolveFilename
 * so `require('bindings')` from unpacked better-sqlite3 can still resolve to the
 * copy shipped inside the base app.asar/node_modules.
 */
function installFallbackModuleResolver(pathsToAdd: string[]): void {
    for (const p of pathsToAdd) {
        if (p && !fallbackModulePaths.includes(p)) {
            fallbackModulePaths.push(p)
        }
    }
    if (fallbackResolverInstalled) return

    const originalResolveFilename = (Module as any)._resolveFilename
    if (typeof originalResolveFilename !== 'function') return

    fallbackResolverInstalled = true
    ;(Module as any)._resolveFilename = function cpaFallbackResolveFilename(
        request: string,
        parent: NodeModule | undefined,
        isMain: boolean,
        options: unknown,
    ) {
        try {
            return originalResolveFilename.call(this, request, parent, isMain, options)
        } catch (err) {
            if (!isModuleNotFoundError(err) || !isBareModuleRequest(request)) {
                throw err
            }
            for (const fallbackDir of fallbackModulePaths) {
                const candidate = path.join(fallbackDir, request)
                try {
                    return originalResolveFilename.call(this, candidate, parent, isMain, options)
                } catch {
                    // Try the next fallback directory
                }
            }
            throw err
        }
    }
}

/**
 * Configures fallback module lookup paths pointing to the base application's
 * resources/app.asar/node_modules and resources/app.asar.unpacked/node_modules.
 * Ensures native modules (node-pty, better-sqlite3) and base shared modules remain
 * discoverable when running from a patched ASAR.
 */
export function addFallbackModulePaths(fallbackPaths: string[]): void {
    if (!fallbackPaths || fallbackPaths.length === 0) return

    // 1. Add to Module.globalPaths
    const globalPaths = (Module as any).globalPaths
    if (Array.isArray(globalPaths)) {
        for (const p of fallbackPaths) {
            if (!globalPaths.includes(p)) {
                globalPaths.push(p)
            }
        }
    }

    // 2. Add to module.paths if accessible in current execution context
    try {
        if (typeof module !== 'undefined' && Array.isArray((module as any).paths)) {
            for (const p of fallbackPaths) {
                if (!(module as any).paths.includes(p)) {
                    (module as any).paths.push(p)
                }
            }
        }
    } catch {
        // Ignore in strict ESM contexts where module is undefined
    }

    // 3. Update NODE_PATH and trigger Node internal path reinitialization
    try {
        const currentEnvPaths = (process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean)
        let changed = false
        for (const p of fallbackPaths) {
            if (!currentEnvPaths.includes(p)) {
                currentEnvPaths.push(p)
                changed = true
            }
        }
        if (changed) {
            process.env.NODE_PATH = currentEnvPaths.join(path.delimiter)
            ;(Module as any)._initPaths?.()
        }
    } catch {
        // Ignore environment manipulation errors
    }

    // 4. Patch CJS resolution so unpacked native-module JS can find companion
    //    packages (bindings, file-uri-to-path) that remain inside app.asar.
    installFallbackModuleResolver(fallbackPaths)
}

/**
 * Resolves the primary JS/addon entry file for a module directory.
 */
function findModuleEntry(modDir: string): string | null {
    if (!fs.existsSync(modDir)) return null

    // 1. Check package.json main field
    const pkgJsonPath = path.join(modDir, 'package.json')
    if (fs.existsSync(pkgJsonPath)) {
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'))
            if (pkg.main) {
                const resolved = path.resolve(modDir, pkg.main)
                if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved
                if (fs.existsSync(`${resolved}.js`)) return `${resolved}.js`
                if (fs.existsSync(`${resolved}.cjs`)) return `${resolved}.cjs`
                const indexInResolved = path.join(resolved, 'index.js')
                if (fs.existsSync(indexInResolved)) return indexInResolved
            }
        } catch {}
    }

    // 2. Common entry points
    const candidates = [
        path.join(modDir, 'index.js'),
        path.join(modDir, 'index.cjs'),
        path.join(modDir, 'lib', 'index.js'),
        path.join(modDir, 'dist', 'index.js'),
        path.join(modDir, 'build', 'Release', `${path.basename(modDir)}.node`),
    ]
    for (const cand of candidates) {
        if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand
    }

    // 3. Fallback: find first .js / .cjs file in modDir
    try {
        const files = fs.readdirSync(modDir)
        for (const f of files) {
            if (f.endsWith('.js') || f.endsWith('.cjs')) {
                const fullPath = path.join(modDir, f)
                if (fs.statSync(fullPath).isFile()) {
                    return fullPath
                }
            }
        }
    } catch {}

    return null
}

/**
 * Ensures ESM native module bridges are created inside <runtimeDir>/node_modules/<module_name>.
 * Because Node.js ESM ignores Module._initPaths() and NODE_PATH, it resolves modules by walking
 * up the directory tree looking for node_modules.
 * When a patched ASAR is active, creating bridge packages in <runtimeDir>/node_modules/<module_name>
 * allows Node.js ESM to resolve native modules (e.g. node-pty, better-sqlite3) from the base app's
 * unpacked directory.
 */
export function ensureNativeModuleBridges(runtimeDir: string, resourcesPath?: string): string[] {
    const baseResourcesPath =
        resourcesPath || (typeof process !== 'undefined' ? (process as any).resourcesPath : undefined)
    if (!baseResourcesPath) return []

    const unpackedModulesDir = path.join(baseResourcesPath, 'app.asar.unpacked', 'node_modules')
    const asarModulesDir = path.join(baseResourcesPath, 'app.asar', 'node_modules')
    const directModulesDir = path.join(baseResourcesPath, 'node_modules')

    const candidateModules = new Set<string>(['better-sqlite3', 'node-pty'])
    for (const dir of [unpackedModulesDir, directModulesDir]) {
        if (fs.existsSync(dir)) {
            try {
                const entries = fs.readdirSync(dir)
                for (const entry of entries) {
                    if (!entry.startsWith('.') && fs.statSync(path.join(dir, entry)).isDirectory()) {
                        candidateModules.add(entry)
                    }
                }
            } catch {}
        }
    }

    const bridgedModules: string[] = []

    for (const modName of candidateModules) {
        try {
            const unpackedModDir = path.join(unpackedModulesDir, modName)
            const asarModDir = path.join(asarModulesDir, modName)
            const directModDir = path.join(directModulesDir, modName)

            // Prefer the asar JS wrapper: electron-builder unpacks native modules
            // without their CJS companion deps (better-sqlite3 requires `bindings`,
            // which lives in app.asar/node_modules). Loading JS from unpacked makes
            // require() walk unpacked/node_modules and fail with MODULE_NOT_FOUND.
            // Fall back to unpacked/direct JS when asar has no JS entry.
            const asarEntry = findModuleEntry(asarModDir)
            const unpackedEntry = findModuleEntry(unpackedModDir)
            const directEntry = findModuleEntry(directModDir)
            let targetEntry: string | null = null
            for (const candidate of [asarEntry, unpackedEntry, directEntry]) {
                if (candidate && !candidate.endsWith('.node')) {
                    targetEntry = candidate
                    break
                }
            }
            if (!targetEntry) {
                targetEntry = asarEntry || unpackedEntry || directEntry
            }

            if (!targetEntry) continue

            const bridgeDir = path.join(runtimeDir, 'node_modules', modName)
            fs.mkdirSync(bridgeDir, { recursive: true })

            const pkgJson = {
                name: modName,
                version: '1.0.0',
                type: 'module',
                main: './index.js',
            }
            fs.writeFileSync(path.join(bridgeDir, 'package.json'), JSON.stringify(pkgJson, null, 2), 'utf8')

            const targetUrl = pathToFileURL(targetEntry).href
            const bridgeJs = [
                `import m from ${JSON.stringify(targetUrl)};`,
                `export default m;`,
                `export * from ${JSON.stringify(targetUrl)};`,
            ].join('\n')

            fs.writeFileSync(path.join(bridgeDir, 'index.js'), bridgeJs, 'utf8')
            bridgedModules.push(modName)
        } catch (err) {
            console.warn(`[Bootstrapper] Failed to create native module bridge for ${modName}:`, err)
        }
    }

    return bridgedModules
}

/**
 * Resolves the main process JavaScript entry file path.
 * If running unpackaged (dev mode), returns baseDefaultMainPath.
 * In packaged mode, inspects update state for an active staged ASAR.
 * Automatically detects consecutive startup crashes and rolls back if threshold is reached.
 */
export function resolveMainEntry(baseDefaultMainPath: string, options?: ResolveMainEntryOptions): string {
    let resolvedBasePath = baseDefaultMainPath
    if (typeof baseDefaultMainPath === 'string' && baseDefaultMainPath.startsWith('file://')) {
        try {
            resolvedBasePath = fileURLToPath(baseDefaultMainPath)
        } catch {}
    }

    const isPackaged =
        options?.isPackaged !== undefined
            ? options.isPackaged
            : typeof electron !== 'undefined' && electron.app?.isPackaged !== undefined
              ? electron.app.isPackaged
              : false

    // If running in development mode or already inside active hot patch, load default entry directly
    if (!isPackaged || process.env.CPA_HOT_PATCH_ACTIVE === '1') {
        return resolvedBasePath
    }

    // Configure fallback module lookup paths for base app's resources
    const resourcesPath =
        options?.resourcesPath || (typeof process !== 'undefined' ? process.resourcesPath : undefined)
    if (resourcesPath) {
        addFallbackModulePaths([
            path.join(resourcesPath, 'app.asar', 'node_modules'),
            path.join(resourcesPath, 'app.asar.unpacked', 'node_modules'),
        ])
    }

    const baseVersion = getBaseBinaryVersion(resourcesPath)
    const storage =
        options?.storage ||
        new UpdateStateStorage({
            baseVersion,
        })

    // Guard against consecutive startup crashes
    if (storage.shouldRollback()) {
        console.warn('[Bootstrapper] Consecutive startup failures detected, rolling back to base version.')
        storage.rollbackToBase()
        return resolvedBasePath
    }

    const state = storage.loadState()
    if (state.activeAsarPath) {
        const runtimeDir = storage.getRuntimeDir()
        const absoluteAsarPath = path.isAbsolute(state.activeAsarPath)
            ? state.activeAsarPath
            : path.join(runtimeDir, state.activeAsarPath)

        const existsFn = options?.existsSync || fs.existsSync
        if (existsFn(absoluteAsarPath)) {
            const targetEntry = path.join(absoluteAsarPath, 'dist-electron', 'src', 'main', 'index.js')

            // Only increment failure if we are not already executing inside the target entry
            if (path.resolve(resolvedBasePath) !== path.resolve(targetEntry)) {
                // Mark potential crash before application enters main event loop
                storage.incrementFailure()
            }

            // Ensure native module bridges are in place for ESM directory tree resolution
            ensureNativeModuleBridges(runtimeDir, resourcesPath)
            const asarParentDir = path.dirname(path.dirname(absoluteAsarPath))
            if (path.resolve(asarParentDir) !== path.resolve(runtimeDir)) {
                ensureNativeModuleBridges(asarParentDir, resourcesPath)
            }

            if (state.activeVersion && typeof electron !== 'undefined' && typeof (electron.app as any)?.setVersion === 'function') {
                try {
                    ;(electron.app as any).setVersion(state.activeVersion)
                } catch {}
            }

            return targetEntry
        }
    }

    return resolvedBasePath
}

export const resolveMainScriptToExecute = resolveMainEntry
export { getBaseBinaryVersion } from './utils/version.js'
