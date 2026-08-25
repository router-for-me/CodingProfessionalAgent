#!/usr/bin/env node
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')

const BUNDLED_DIR = path.join(rootDir, 'plugins', 'bundled')
const MAIN_GENERATED_FILE = path.join(rootDir, 'src', 'main', 'plugins', 'generated', 'bundledPluginLoaders.ts')
const FRONTEND_GENERATED_FILE = path.join(rootDir, 'frontend', 'src', 'plugins', 'generated', 'bundledPluginLoaders.ts')

// Map plugin short name to import identifier
export function getPluginVarName(pluginId) {
    const shortName = pluginId.replace(/^cpa\.core\./, '')
    // e.g. session-manager -> sessionManagerPlugin
    return shortName.replace(/-([a-z])/g, (_, char) => char.toUpperCase()) + 'Plugin'
}

export function getPluginDirName(pluginId) {
    return pluginId.replace(/^cpa\.core\./, '')
}

/**
 * Checks if a real entry file exists relative to the package directory.
 */
export function findRealEntryFile(packageDir, entryRelPath) {
    if (!entryRelPath || !packageDir) {
        return null
    }
    const target = path.resolve(packageDir, entryRelPath)
    if (fs.existsSync(target) && fs.statSync(target).isFile()) {
        return target
    }

    const extensions = ['.tsx', '.ts', '.jsx', '.js']
    for (const ext of extensions) {
        const withExt = target + ext
        if (fs.existsSync(withExt) && fs.statSync(withExt).isFile()) {
            return withExt
        }
    }

    return null
}

/**
 * Discovers bundled plugin manifests from disk.
 */
export function discoverBundledManifests(bundledDir = BUNDLED_DIR) {
    if (!fs.existsSync(bundledDir)) {
        return []
    }

    const entries = fs.readdirSync(bundledDir, { withFileTypes: true })
    const pluginDirs = entries.filter((e) => e.isDirectory())
    const manifests = []

    for (const dir of pluginDirs) {
        const manifestPath = path.join(bundledDir, dir.name, 'manifest.json')
        if (!fs.existsSync(manifestPath)) {
            continue
        }

        const raw = fs.readFileSync(manifestPath, 'utf8')
        try {
            const parsed = JSON.parse(raw)
            if (!parsed.id || !parsed.name || !parsed.version) {
                console.error(`Error: Invalid manifest in ${manifestPath}: missing required id, name, or version`)
                continue
            }
            manifests.push({
                manifest: parsed,
                dirName: dir.name,
                sourceRoot: path.join('plugins', 'bundled', dir.name).replace(/\\/g, '/'),
            })
        } catch (err) {
            console.error(`Error parsing JSON in ${manifestPath}:`, err)
        }
    }

    // Sort by activationPriority (ascending), then id
    manifests.sort((a, b) => {
        const prioA = a.manifest.activationPriority ?? 1000
        const prioB = b.manifest.activationPriority ?? 1000
        if (prioA !== prioB) {
            return prioA - prioB
        }
        return a.manifest.id.localeCompare(b.manifest.id)
    })

    return manifests
}

/**
 * Generates the Main bundled loaders TypeScript file content.
 */
export function generateMainLoadersContent(manifests, options = {}) {
    const root = options.rootDir ?? rootDir
    const mainGeneratedDir = path.join(root, 'src', 'main', 'plugins', 'generated')
    const loaderEntries = []

    for (const item of manifests) {
        if (!item.manifest.entries?.main) {
            continue
        }
        const pluginId = item.manifest.id
        const packageDir = path.join(root, 'plugins', 'bundled', item.dirName)
        const declaredEntry = item.manifest.entries.main

        const realEntry = findRealEntryFile(packageDir, declaredEntry)
        if (!realEntry) {
            throw new Error(`Bundled plugin "${pluginId}" declares main entry "${declaredEntry}" but file was not found in "${packageDir}"`)
        }

        let relImport = path.relative(mainGeneratedDir, realEntry).replace(/\\/g, '/')
        if (!relImport.startsWith('.')) {
            relImport = './' + relImport
        }
        // Strip .ts / .tsx / .js extension for TS import or keep as needed
        relImport = relImport.replace(/\.(ts|tsx)$/, '.js')
        loaderEntries.push(
            `    '${pluginId}': async () => {\n        const mod = await import('${relImport}')\n        return mod.default ?? mod.entry ?? mod\n    },`
        )
    }

    const mainManifests = manifests.filter((item) => Boolean(item.manifest.entries?.main))

    const manifestsMapEntries = mainManifests.map(
        (item) => `    '${item.manifest.id}': Object.freeze(${JSON.stringify(item.manifest, null, 8).trim()}),`
    )

    const mainPackagesEntries = mainManifests.map(
        (item) => `    Object.freeze({
        manifest: bundledManifests['${item.manifest.id}'],
        entries: bundledManifests['${item.manifest.id}'].entries ?? {},
        sourceRoot: '${item.sourceRoot ?? ['plugins', 'bundled', item.dirName ?? item.manifest.id].join('/')}',
        source: Object.freeze({ kind: 'bundled' as const, spec: 'bundled:${item.manifest.id}' }),
    }),`
    )

    return `// Generated by scripts/generate-bundled-plugin-catalog.mjs. Do not edit directly.
import type { PluginEntryDefinition, PluginManifest, ResolvedPluginPackage } from '@cpa/plugin-api'

export type BundledEntryLoader = () => Promise<PluginEntryDefinition>

/**
 * Authoritative manifest map for bundled plugins with main entries.
 */
export const bundledManifests: Readonly<Record<string, PluginManifest>> = Object.freeze({
${manifestsMapEntries.join('\n')}
})

/**
 * Resolved plugin packages declaring main entries.
 */
export const bundledMainPackages: readonly ResolvedPluginPackage[] = Object.freeze([
${mainPackagesEntries.join('\n')}
])

/**
 * Main process bundled plugin entry loaders.
 */
export const bundledMainEntryLoaders: Readonly<Record<string, BundledEntryLoader>> = Object.freeze({
${loaderEntries.join('\n')}
})
`
}

/**
 * Generates the Frontend (Renderer and Agent) bundled loaders TypeScript file content.
 */
export function generateFrontendLoadersContent(manifests, options = {}) {
    const root = options.rootDir ?? rootDir
    const frontendGeneratedDir = path.join(root, 'frontend', 'src', 'plugins', 'generated')

    const rendererEntries = []
    const agentEntries = []

    for (const item of manifests) {
        const pluginId = item.manifest.id
        const packageDir = path.join(root, 'plugins', 'bundled', item.dirName)

        // 1. Renderer Entry
        if (item.manifest.entries?.renderer) {
            const declaredEntry = item.manifest.entries.renderer
            const realEntry = findRealEntryFile(packageDir, declaredEntry)
            if (!realEntry) {
                throw new Error(`Bundled plugin "${pluginId}" declares renderer entry "${declaredEntry}" but file was not found in "${packageDir}"`)
            }

            let relImport = path.relative(frontendGeneratedDir, realEntry).replace(/\\/g, '/')
            if (!relImport.startsWith('.')) {
                relImport = './' + relImport
            }
            relImport = relImport.replace(/\.(ts|tsx)$/, '')
            rendererEntries.push(
                `    '${pluginId}': async () => {\n        const mod = await import('${relImport}')\n        return mod.default ?? mod.entry ?? mod\n    },`
            )
        }

        // 2. Agent Entry
        if (item.manifest.entries?.agent) {
            const declaredEntry = item.manifest.entries.agent
            const realEntry = findRealEntryFile(packageDir, declaredEntry)
            if (!realEntry) {
                throw new Error(`Bundled plugin "${pluginId}" declares agent entry "${declaredEntry}" but file was not found in "${packageDir}"`)
            }

            let relImport = path.relative(frontendGeneratedDir, realEntry).replace(/\\/g, '/')
            if (!relImport.startsWith('.')) {
                relImport = './' + relImport
            }
            relImport = relImport.replace(/\.(ts|tsx)$/, '')
            agentEntries.push(
                `    '${pluginId}': async () => {\n        const mod = await import('${relImport}')\n        return mod.default ?? mod.entry ?? mod\n    },`
            )
        }
    }

    const manifestsMapEntries = manifests.map(
        (item) => `    '${item.manifest.id}': Object.freeze(${JSON.stringify(item.manifest, null, 8).trim()}),`
    )

    const rendererPackagesEntries = manifests.map(
        (item) => `    Object.freeze({
        manifest: bundledManifests['${item.manifest.id}'],
        entries: bundledManifests['${item.manifest.id}'].entries ?? {},
        sourceRoot: '${item.sourceRoot ?? ['plugins', 'bundled', item.dirName ?? item.manifest.id].join('/')}',
        source: Object.freeze({ kind: 'bundled' as const, spec: 'bundled:${item.manifest.id}' }),
    }),`
    )

    const agentPackagesEntries = manifests
        .filter((item) => Boolean(item.manifest.entries?.agent))
        .map(
            (item) => `    Object.freeze({
        manifest: bundledManifests['${item.manifest.id}'],
        entries: bundledManifests['${item.manifest.id}'].entries ?? {},
        sourceRoot: '${item.sourceRoot ?? ['plugins', 'bundled', item.dirName ?? item.manifest.id].join('/')}',
        source: Object.freeze({ kind: 'bundled' as const, spec: 'bundled:${item.manifest.id}' }),
    }),`
        )

    return `// Generated by scripts/generate-bundled-plugin-catalog.mjs. Do not edit directly.
import type { PluginEntryDefinition, PluginManifest, ResolvedPluginPackage } from '@cpa/plugin-api'

export type BundledEntryLoader = () => Promise<PluginEntryDefinition>

/**
 * Authoritative manifest map for all bundled plugins.
 */
export const bundledManifests: Readonly<Record<string, PluginManifest>> = Object.freeze({
${manifestsMapEntries.join('\n')}
})

/**
 * Authoritative bundled plugin packages for the renderer runtime host.
 */
export const bundledRendererPackages: readonly ResolvedPluginPackage[] = Object.freeze([
${rendererPackagesEntries.join('\n')}
])

/**
 * Resolved plugin packages declaring agent entries.
 */
export const bundledAgentPackages: readonly ResolvedPluginPackage[] = Object.freeze([
${agentPackagesEntries.join('\n')}
])

/**
 * Renderer process bundled plugin entry loaders.
 */
export const bundledRendererEntryLoaders: Readonly<Record<string, BundledEntryLoader>> = Object.freeze({
${rendererEntries.join('\n')}
})

/**
 * Agent runtime bundled plugin entry loaders.
 * Driven strictly by manifest entries.agent for plugins with real entry files.
 */
export const bundledAgentEntryLoaders: Readonly<Record<string, BundledEntryLoader>> = Object.freeze({
${agentEntries.join('\n')}
})
`
}

/**
 * Generates fixture catalog strings for test fixtures.
 */
export function generateFixtureCatalog(manifests, options = {}) {
    const mainContent = generateMainLoadersContent(manifests, options)
    const rendererContent = generateFrontendLoadersContent(manifests, options)

    // Calculate manifest copies in generated output
    const manifestCopies =
        (rendererContent.match(/manifest:\s*\{/g) || []).length +
        (mainContent.match(/manifest:\s*\{/g) || []).length

    return {
        main: mainContent,
        renderer: rendererContent,
        manifestCopies,
    }
}

/**
 * Scans repository bundled plugins and returns a contract baseline report.
 */
export async function scanBundledPluginContracts(repo = rootDir) {
    const bundledDir = path.join(repo, 'plugins', 'bundled')
    const manifests = discoverBundledManifests(bundledDir)

    const pluginIds = manifests.map((m) => m.manifest.id)
    const seen = new Set()
    const duplicatePluginIds = []
    for (const id of pluginIds) {
        if (seen.has(id)) {
            duplicatePluginIds.push(id)
        }
        seen.add(id)
    }

    const realEntries = []
    const legacyEntries = []
    const accountedPluginIds = new Set()
    const unaccountedPluginIds = []

    for (const item of manifests) {
        const pluginId = item.manifest.id
        const packageDir = path.join(bundledDir, item.dirName)
        let isAccounted = false

        // Check renderer
        if (item.manifest.entries?.renderer) {
            const real = findRealEntryFile(packageDir, item.manifest.entries.renderer)
            if (real) {
                realEntries.push({ pluginId, runtime: 'renderer', path: real })
                isAccounted = true
            }
        }

        // Check main
        if (item.manifest.entries?.main) {
            const real = findRealEntryFile(packageDir, item.manifest.entries.main)
            if (real) {
                realEntries.push({ pluginId, runtime: 'main', path: real })
                isAccounted = true
            }
        }

        // Check agent
        if (item.manifest.entries?.agent) {
            const real = findRealEntryFile(packageDir, item.manifest.entries.agent)
            if (real) {
                realEntries.push({ pluginId, runtime: 'agent', path: real })
                isAccounted = true
            }
        }

        if (isAccounted) {
            accountedPluginIds.add(pluginId)
        } else {
            unaccountedPluginIds.push(pluginId)
        }
    }

    // Check manifest copies in generated files
    const rendererPath = path.join(repo, 'frontend', 'src', 'plugins', 'generated', 'bundledPluginLoaders.ts')
    const mainPath = path.join(repo, 'src', 'main', 'plugins', 'generated', 'bundledPluginLoaders.ts')

    let manifestCopies = 0
    if (fs.existsSync(rendererPath)) {
        const c = fs.readFileSync(rendererPath, 'utf8')
        manifestCopies += (c.match(/manifest:\s*\{/g) || []).length
        if (c.includes('bundledPluginPackages')) {
            manifestCopies += 1
        }
    }
    if (fs.existsSync(mainPath)) {
        const c = fs.readFileSync(mainPath, 'utf8')
        manifestCopies += (c.match(/manifest:\s*\{/g) || []).length
        if (c.includes('bundledPluginPackages')) {
            manifestCopies += 1
        }
    }

    return {
        pluginIds,
        duplicatePluginIds,
        realEntries,
        legacyEntries,
        unaccountedPluginIds,
        manifestCopies,
    }
}

/**
 * Verifies that generated loader files match deterministic expected output.
 */
export function verifyGeneratedLoaders(repo = rootDir) {
    const bundledDir = path.join(repo, 'plugins', 'bundled')
    const manifests = discoverBundledManifests(bundledDir)

    const expectedMain = generateMainLoadersContent(manifests, { rootDir: repo })
    const expectedFrontend = generateFrontendLoadersContent(manifests, { rootDir: repo })

    const mainFile = path.join(repo, 'src', 'main', 'plugins', 'generated', 'bundledPluginLoaders.ts')
    const frontendFile = path.join(repo, 'frontend', 'src', 'plugins', 'generated', 'bundledPluginLoaders.ts')

    if (!fs.existsSync(mainFile)) {
        return { ok: false, error: `Missing main generated file: ${mainFile}` }
    }
    if (!fs.existsSync(frontendFile)) {
        return { ok: false, error: `Missing frontend generated file: ${frontendFile}` }
    }

    const actualMain = fs.readFileSync(mainFile, 'utf8')
    const actualFrontend = fs.readFileSync(frontendFile, 'utf8')

    if (actualMain.trim() !== expectedMain.trim()) {
        return { ok: false, error: 'Main generated bundledPluginLoaders.ts does not match expected output' }
    }
    if (actualFrontend.trim() !== expectedFrontend.trim()) {
        return { ok: false, error: 'Frontend generated bundledPluginLoaders.ts does not match expected output' }
    }

    return { ok: true, manifests }
}

/**
 * Main execution
 */
async function main() {
    const isCheck = process.argv.includes('--check')
    if (isCheck) {
        const verification = verifyGeneratedLoaders()
        if (!verification.ok) {
            console.error(`❌ Bundled plugin loaders verification failed: ${verification.error}`)
            process.exit(1)
        }
        console.log(`✅ Bundled plugin loaders are up-to-date (${verification.manifests.length} plugins verified).`)
        process.exit(0)
    }

    const manifests = discoverBundledManifests()
    console.log(`Discovered ${manifests.length} bundled plugin manifests.`)

    const mainLoadersContent = generateMainLoadersContent(manifests)
    const frontendLoadersContent = generateFrontendLoadersContent(manifests)

    fs.mkdirSync(path.dirname(MAIN_GENERATED_FILE), { recursive: true })
    fs.mkdirSync(path.dirname(FRONTEND_GENERATED_FILE), { recursive: true })

    fs.writeFileSync(MAIN_GENERATED_FILE, mainLoadersContent, 'utf8')
    console.log(`Wrote ${MAIN_GENERATED_FILE}`)

    fs.writeFileSync(FRONTEND_GENERATED_FILE, frontendLoadersContent, 'utf8')
    console.log(`Wrote ${FRONTEND_GENERATED_FILE}`)

    console.log('Successfully generated bundled plugin loaders.')
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
    main().catch((err) => {
        console.error('Error generating bundled plugin catalog:', err)
        process.exit(1)
    })
}
