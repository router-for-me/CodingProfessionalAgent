import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import * as asarModule from '@electron/asar'

const require = createRequire(import.meta.url)
const asar = asarModule.default?.createPackage ? asarModule.default : asarModule

/**
 * Dynamically resolves Electron modules ABI or falls back to known version map.
 */
export function resolveElectronModulesAbi(cwd = process.cwd(), electronVer = '44.0.0') {
    try {
        const output = execSync('pnpm exec electron -e "console.log(process.versions.modules)"', {
            cwd,
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 5000,
        }).trim()
        if (output && /^\d+$/.test(output)) {
            return output
        }
    } catch {}

    const major = parseInt(String(electronVer).replace(/^[\^~]/, '').split('.')[0], 10)
    const ABI_MAP = {
        44: '149',
        35: '133',
        34: '132',
        33: '131',
        32: '130',
        31: '128',
        30: '125',
    }
    return (major && ABI_MAP[major]) || '149'
}

/**
 * Builds the ASAR update patch archive containing the application code
 * and an initial release manifest.
 */
export async function buildUpdatePatch(options = {}) {
    const rootDir = options.rootDir ? path.resolve(options.rootDir) : process.cwd()
    const outDir = options.outDir ? path.resolve(options.outDir) : path.join(rootDir, 'bin', 'dist')
    const skipBuild = options.skipBuild ?? (process.argv.includes('--skip-build') || process.env.SKIP_BUILD === '1')
    const keepStagingDir = options.keepStagingDir ?? false

    const pkgPath = path.join(rootDir, 'package.json')
    if (!fs.existsSync(pkgPath)) {
        throw new Error(`package.json not found at ${pkgPath}`)
    }
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    const version = pkg.version || '1.0.0'
    const electronDep = pkg.devDependencies?.electron || '44.0.0'
    const electronVersion = electronDep.replace(/^[\^~]/, '')

    console.log(`[Patch Builder] Building CPA patch for version v${version}...`)

    // 1. Build TS packages, frontend, and electron if requested
    if (!skipBuild) {
        console.log('[Patch Builder] Executing pnpm build...')
        execSync('pnpm build', { cwd: rootDir, stdio: 'inherit' })
    } else {
        console.log('[Patch Builder] Skipping pnpm build (--skip-build)')
    }

    fs.mkdirSync(outDir, { recursive: true })

    // 2. Prepare staging directory for asar
    const stagingDir = path.join(outDir, 'staging-patch')
    fs.rmSync(stagingDir, { recursive: true, force: true })
    fs.mkdirSync(stagingDir, { recursive: true })

    const requiredDirs = [
        { src: path.join(rootDir, 'dist-electron'), dest: path.join(stagingDir, 'dist-electron') },
        { src: path.join(rootDir, 'frontend', 'dist'), dest: path.join(stagingDir, 'frontend', 'dist') },
        { src: path.join(rootDir, 'plugins', 'bundled'), dest: path.join(stagingDir, 'plugins', 'bundled') },
    ]

    for (const { src, dest } of requiredDirs) {
        if (!fs.existsSync(src)) {
            throw new Error(`Required directory missing: ${src}. Ensure project is built before packaging patch.`)
        }
        fs.cpSync(src, dest, { recursive: true })
    }

    fs.copyFileSync(pkgPath, path.join(stagingDir, 'package.json'))

    // 2.1 Include workspace packages (@cpa/*) inside stagingDir/node_modules/@cpa/
    const stagingNodeModules = path.join(stagingDir, 'node_modules')
    const stagingCpaDir = path.join(stagingNodeModules, '@cpa')
    fs.mkdirSync(stagingCpaDir, { recursive: true })

    const packagesDir = path.join(rootDir, 'packages')
    if (fs.existsSync(packagesDir)) {
        for (const entry of fs.readdirSync(packagesDir)) {
            const pkgDir = path.join(packagesDir, entry)
            if (!fs.statSync(pkgDir).isDirectory()) continue

            const pkgJsonFile = path.join(pkgDir, 'package.json')
            if (!fs.existsSync(pkgJsonFile)) continue

            let pkgName = entry
            try {
                const innerPkg = JSON.parse(fs.readFileSync(pkgJsonFile, 'utf8'))
                if (innerPkg.name && innerPkg.name.startsWith('@cpa/')) {
                    pkgName = innerPkg.name.slice(5)
                }
            } catch {}

            const destPkgDir = path.join(stagingCpaDir, pkgName)
            fs.mkdirSync(destPkgDir, { recursive: true })
            fs.copyFileSync(pkgJsonFile, path.join(destPkgDir, 'package.json'))

            const distDir = path.join(pkgDir, 'dist')
            if (fs.existsSync(distDir)) {
                fs.cpSync(distDir, path.join(destPkgDir, 'dist'), { recursive: true })
            }
        }
    }

    // Copy any workspace packages from root node_modules/@cpa if present
    const rootCpaDir = path.join(rootDir, 'node_modules', '@cpa')
    if (fs.existsSync(rootCpaDir)) {
        for (const entry of fs.readdirSync(rootCpaDir)) {
            const destPkgDir = path.join(stagingCpaDir, entry)
            if (!fs.existsSync(destPkgDir)) {
                const srcPkgDir = path.join(rootCpaDir, entry)
                fs.cpSync(srcPkgDir, destPkgDir, { recursive: true, dereference: true })
            }
        }
    }

    // 2.2 Include pure JS production dependencies in stagingDir/node_modules
    // Recursively resolve and bundle the complete transitive dependency closure.
    // Native modules (e.g., node-pty, better-sqlite3) and electron remain in the base app unpacked directory.
    const nativeModules = new Set(['better-sqlite3', 'node-pty', 'electron'])

    function getEnclosingNodeModules(pkgDir) {
        const parent = path.dirname(pkgDir)
        if (path.basename(parent).startsWith('@')) {
            return path.dirname(parent)
        }
        return parent
    }

    function resolvePackageLocation(depName, parentDir, currentRootDir) {
        const searchDirs = []
        if (parentDir) {
            searchDirs.push(parentDir)
        }
        searchDirs.push(currentRootDir)

        const currentPackagesDir = path.join(currentRootDir, 'packages')
        if (fs.existsSync(currentPackagesDir)) {
            for (const entry of fs.readdirSync(currentPackagesDir)) {
                searchDirs.push(path.join(currentPackagesDir, entry))
            }
        }

        for (const dir of searchDirs) {
            if (!dir || !fs.existsSync(dir)) continue

            let realDir = dir
            try {
                realDir = fs.realpathSync(dir)
            } catch {}

            // 1. Direct child node_modules
            const directCandidate = path.join(realDir, 'node_modules', depName)
            if (fs.existsSync(directCandidate)) {
                try {
                    return fs.realpathSync(directCandidate)
                } catch {
                    return directCandidate
                }
            }

            // 2. Sibling in enclosing node_modules (e.g. within pnpm virtual store)
            const enclosing = getEnclosingNodeModules(realDir)
            if (path.basename(enclosing) === 'node_modules') {
                const siblingCandidate = path.join(enclosing, depName)
                if (fs.existsSync(siblingCandidate)) {
                    try {
                        return fs.realpathSync(siblingCandidate)
                    } catch {
                        return siblingCandidate
                    }
                }
            }

            // 3. Node createRequire resolution from package.json
            try {
                const pkgJsonPath = path.join(realDir, 'package.json')
                if (fs.existsSync(pkgJsonPath)) {
                    const req = createRequire(pkgJsonPath)
                    let resolvedFile = null
                    try {
                        resolvedFile = req.resolve(depName + '/package.json')
                        const pkgRoot = path.dirname(resolvedFile)
                        try {
                            return fs.realpathSync(pkgRoot)
                        } catch {
                            return pkgRoot
                        }
                    } catch {
                        try {
                            resolvedFile = req.resolve(depName)
                        } catch {}
                    }

                    if (resolvedFile) {
                        let curr = path.dirname(resolvedFile)
                        while (curr && curr !== path.dirname(curr)) {
                            const candidatePkgJson = path.join(curr, 'package.json')
                            if (fs.existsSync(candidatePkgJson)) {
                                try {
                                    const parsed = JSON.parse(fs.readFileSync(candidatePkgJson, 'utf8'))
                                    if (parsed.name === depName || (!parsed.name && curr.endsWith(depName))) {
                                        try {
                                            return fs.realpathSync(curr)
                                        } catch {
                                            return curr
                                        }
                                    }
                                } catch {}
                            }
                            curr = path.dirname(curr)
                        }
                    }
                }
            } catch {}
        }

        // 4. Search in root .pnpm directory if present
        const pnpmDir = path.join(currentRootDir, 'node_modules', '.pnpm')
        if (fs.existsSync(pnpmDir)) {
            let reqRange = null
            if (parentDir) {
                try {
                    const pJson = JSON.parse(fs.readFileSync(path.join(parentDir, 'package.json'), 'utf8'))
                    reqRange = pJson.dependencies?.[depName] || pJson.devDependencies?.[depName] || null
                } catch {}
            }

            const encodedPrefix = depName.replace('/', '+') + '@'
            let matchedCandidate = null

            for (const entry of fs.readdirSync(pnpmDir)) {
                if (entry.startsWith(encodedPrefix) || entry === depName) {
                    const candidate = path.join(pnpmDir, entry, 'node_modules', depName)
                    if (fs.existsSync(candidate)) {
                        let realCandidate
                        try {
                            realCandidate = fs.realpathSync(candidate)
                        } catch {
                            realCandidate = candidate
                        }

                        if (reqRange) {
                            try {
                                const candPkg = JSON.parse(fs.readFileSync(path.join(realCandidate, 'package.json'), 'utf8'))
                                const cleanReq = reqRange.replace(/^[\^~>=<]/, '')
                                if (candPkg.version && (candPkg.version === cleanReq || entry.includes(`@${candPkg.version}`))) {
                                    return realCandidate
                                }
                            } catch {}
                        }

                        if (!matchedCandidate) {
                            matchedCandidate = realCandidate
                        }
                    }
                }
            }
            if (matchedCandidate) {
                return matchedCandidate
            }
        }

        return null
    }

    const queue = []
    const enqueuedKeys = new Set()

    const enqueueDependencies = (pkgJsonPath, searchDir, parentDestDir) => {
        if (!fs.existsSync(pkgJsonPath)) return
        try {
            const content = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'))
            if (content.dependencies) {
                for (const dep of Object.keys(content.dependencies)) {
                    if (dep.startsWith('@cpa/') || nativeModules.has(dep)) {
                        continue
                    }
                    const key = `${parentDestDir}::${dep}`
                    if (!enqueuedKeys.has(key)) {
                        enqueuedKeys.add(key)
                        queue.push({ dep, parentDir: searchDir, parentDestDir })
                    }
                }
            }
        } catch {}
    }

    // 1. Start with direct production dependencies from root package.json
    enqueueDependencies(pkgPath, rootDir, stagingDir)

    // And all packages/*/package.json
    if (fs.existsSync(packagesDir)) {
        for (const entry of fs.readdirSync(packagesDir)) {
            const pkgDir = path.join(packagesDir, entry)
            if (!fs.statSync(pkgDir).isDirectory()) continue

            const pkgJsonFile = path.join(pkgDir, 'package.json')
            if (!fs.existsSync(pkgJsonFile)) continue

            let pkgName = entry
            try {
                const innerPkg = JSON.parse(fs.readFileSync(pkgJsonFile, 'utf8'))
                if (innerPkg.name && innerPkg.name.startsWith('@cpa/')) {
                    pkgName = innerPkg.name.slice(5)
                }
            } catch {}

            const destPkgDir = path.join(stagingCpaDir, pkgName)
            enqueueDependencies(pkgJsonFile, pkgDir, destPkgDir)
        }
    }

    // 2. Recursively resolve and copy dependency closure into stagingDir/node_modules
    // Supports multi-version dependency hierarchies via standard nested node_modules.
    const processedDestDirs = new Set()
    const cpOptions = {
        recursive: true,
        dereference: true,
        filter: (source) => path.basename(source) !== 'node_modules',
    }

    while (queue.length > 0) {
        const { dep, parentDir, parentDestDir } = queue.shift()

        const pkgLocation = resolvePackageLocation(dep, parentDir, rootDir)
        if (!pkgLocation) {
            console.warn(`[Patch Builder] Warning: dependency '${dep}' could not be located in node_modules.`)
            continue
        }

        const resolvedPkgJsonPath = path.join(pkgLocation, 'package.json')
        if (!fs.existsSync(resolvedPkgJsonPath)) {
            console.warn(`[Patch Builder] Warning: package.json missing at '${pkgLocation}'.`)
            continue
        }

        let depVersion = '0.0.0'
        try {
            const parsed = JSON.parse(fs.readFileSync(resolvedPkgJsonPath, 'utf8'))
            depVersion = parsed.version || '0.0.0'
        } catch {}

        const topLevelDestDir = path.join(stagingNodeModules, dep)
        let targetDestDir

        if (!fs.existsSync(topLevelDestDir)) {
            // Top-level stagingDir/node_modules/<depName> does not exist yet -> copy to top-level
            targetDestDir = topLevelDestDir
        } else {
            // Top-level already has <depName> -> compare version
            let topVersion = null
            try {
                const topPkgJsonPath = path.join(topLevelDestDir, 'package.json')
                if (fs.existsSync(topPkgJsonPath)) {
                    const topPkg = JSON.parse(fs.readFileSync(topPkgJsonPath, 'utf8'))
                    topVersion = topPkg.version || null
                }
            } catch {}

            if (topVersion && topVersion === depVersion) {
                // Top-level matches. Verify if any intermediate parent shadows it with a conflicting version.
                let shadowed = false
                if (parentDestDir && parentDestDir !== stagingDir) {
                    let curr = parentDestDir
                    while (curr && curr !== stagingNodeModules && curr !== stagingDir) {
                        const intermediateCandidate = path.join(curr, 'node_modules', dep)
                        if (fs.existsSync(intermediateCandidate)) {
                            try {
                                const interPkg = JSON.parse(fs.readFileSync(path.join(intermediateCandidate, 'package.json'), 'utf8'))
                                if (interPkg.version && interPkg.version !== depVersion) {
                                    shadowed = true
                                    break
                                }
                            } catch {}
                        }
                        const parent = path.dirname(curr)
                        if (parent === curr) break
                        curr = parent
                    }
                }

                if (!shadowed) {
                    // Versions match and no intermediate shadowing -> reuse top-level
                    continue
                }
            }

            // Versions differ (conflict) or shadowed!
            // Nest this version inside the requesting parent package
            if (!parentDestDir || parentDestDir === stagingDir) {
                targetDestDir = topLevelDestDir
            } else {
                targetDestDir = path.join(parentDestDir, 'node_modules', dep)
            }
        }

        if (processedDestDirs.has(targetDestDir)) {
            continue
        }

        if (fs.existsSync(targetDestDir)) {
            let existingVersion = null
            try {
                const existingPkg = JSON.parse(fs.readFileSync(path.join(targetDestDir, 'package.json'), 'utf8'))
                existingVersion = existingPkg.version || null
            } catch {}
            if (existingVersion === depVersion) {
                processedDestDirs.add(targetDestDir)
                continue
            }
        }

        fs.mkdirSync(path.dirname(targetDestDir), { recursive: true })
        fs.cpSync(pkgLocation, targetDestDir, cpOptions)
        processedDestDirs.add(targetDestDir)

        // Read package.json of resolved package to enqueue its sub-dependencies,
        // with the newly created targetDestDir as their requesting parent.
        enqueueDependencies(resolvedPkgJsonPath, pkgLocation, targetDestDir)
    }

    // Optional build assets (tray templates and app icons)
    const buildDir = path.join(rootDir, 'build')
    if (fs.existsSync(buildDir)) {
        const stagingBuildDir = path.join(stagingDir, 'build')
        fs.mkdirSync(stagingBuildDir, { recursive: true })
        for (const file of fs.readdirSync(buildDir)) {
            if (file.startsWith('trayTemplate') || file.startsWith('appicon')) {
                const fullSrc = path.join(buildDir, file)
                if (fs.statSync(fullSrc).isFile()) {
                    fs.copyFileSync(fullSrc, path.join(stagingBuildDir, file))
                }
            }
        }
    }

    const asarPath = path.join(outDir, `app-update-${version}.asar`)
    console.log(`[Patch Builder] Creating asar archive at ${asarPath}...`)
    await asar.createPackage(stagingDir, asarPath)
    if (!keepStagingDir) {
        fs.rmSync(stagingDir, { recursive: true, force: true })
    }

    // 3. Calculate SHA-256 and size
    const asarBuf = fs.readFileSync(asarPath)
    const sha256 = crypto.createHash('sha256').update(asarBuf).digest('hex')
    const size = asarBuf.length

    console.log(`[Patch Builder] Asar generated: size=${size} bytes, sha256=${sha256}`)

    // 4. Generate initial release manifest
    const repo = process.env.GITHUB_REPOSITORY || 'router-for-me/CodingProfessionalAgent'
    const modulesAbi = options.nativeRequirements?.modules || resolveElectronModulesAbi(rootDir, electronVersion)
    const manifest = {
        version,
        releaseDate: new Date().toISOString(),
        releaseNotes: `Release v${version}`,
        nativeRequirements: {
            electron: electronVersion,
            modules: modulesAbi,
            minNativeBaseVersion: '1.0.0',
            ...options.nativeRequirements,
        },
        asar: {
            filename: `app-update-${version}.asar`,
            url: `https://github.com/${repo}/releases/download/v${version}/app-update-${version}.asar`,
            sha256,
            size,
        },
        installers: {},
    }

    const manifestPath = path.join(outDir, 'release-manifest.json')
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
    console.log(`[Patch Builder] Initial manifest generated at ${manifestPath}`)

    return {
        version,
        asarPath,
        sha256,
        size,
        manifestPath,
        manifest,
        stagingDir,
    }
}

// Execute when invoked as entry script
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
    buildUpdatePatch().catch((err) => {
        console.error('[Patch Builder] Fatal error:', err)
        process.exit(1)
    })
}
