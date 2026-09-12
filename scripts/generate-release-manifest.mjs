import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

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
 * Inspects released assets directory, computes cryptographic checksums,
 * and generates the authoritative release-manifest.json for the update service.
 */
export function generateReleaseManifest(options = {}) {
    const rawTag = options.tag || process.argv[2] || 'v1.0.0'
    const version = rawTag.replace(/^v/, '')
    const repo = options.repo || process.env.GITHUB_REPOSITORY || 'router-for-me/CodingProfessionalAgent'

    const assetsDir = options.assetsDir
        ? path.resolve(options.assetsDir)
        : process.argv[3]
          ? path.resolve(process.argv[3])
          : process.cwd()

    const outputPath = options.outputPath
        ? path.resolve(options.outputPath)
        : process.argv[4]
          ? path.resolve(process.argv[4])
          : path.join(assetsDir, 'release-manifest.json')

    if (!fs.existsSync(assetsDir)) {
        throw new Error(`Assets directory does not exist: ${assetsDir}`)
    }

    const files = fs.readdirSync(assetsDir)

    const scriptRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    let electronVer = '44.0.0'
    let resolvedPkgDir = scriptRepoRoot
    const candidatePkgPaths = [
        options.pkgJsonPath,
        options.rootDir ? path.join(options.rootDir, 'package.json') : null,
        path.join(process.cwd(), 'package.json'),
        path.join(assetsDir, '..', 'package.json'),
        path.join(scriptRepoRoot, 'package.json'),
    ].filter(Boolean)

    for (const cand of candidatePkgPaths) {
        try {
            if (fs.existsSync(cand)) {
                const pkg = JSON.parse(fs.readFileSync(cand, 'utf8'))
                if (pkg.devDependencies?.electron) {
                    electronVer = pkg.devDependencies.electron.replace(/^[\^~]/, '')
                }
                resolvedPkgDir = path.dirname(cand)
                break
            }
        } catch {}
    }

    const modulesAbi = options.nativeRequirements?.modules || resolveElectronModulesAbi(resolvedPkgDir, electronVer)

    const manifest = {
        version,
        releaseDate: new Date().toISOString(),
        releaseNotes: options.releaseNotes || `Release ${rawTag}`,
        nativeRequirements: {
            electron: electronVer,
            modules: modulesAbi,
            minNativeBaseVersion: '1.0.0',
            ...options.nativeRequirements,
        },
        installers: {},
    }

    for (const file of files) {
        const filePath = path.join(assetsDir, file)
        if (!fs.statSync(filePath).isFile()) continue

        // Skip non-distribution metadata files
        if (
            file === 'release-manifest.json' ||
            file === 'SHA256SUMS.txt' ||
            file.startsWith('.') ||
            file.endsWith('.blockmap') ||
            file.endsWith('.yml') ||
            file.endsWith('.yaml')
        ) {
            continue
        }

        const buf = fs.readFileSync(filePath)
        const sha256 = crypto.createHash('sha256').update(buf).digest('hex')
        const size = buf.length
        const url = `https://github.com/${repo}/releases/download/${rawTag}/${file}`
        const isArm = file.includes('arm64') || file.includes('aarch64')

        if (file.endsWith('.asar')) {
            manifest.asar = { filename: file, url, sha256, size }
        } else if (file.endsWith('.dmg')) {
            const key = isArm ? 'darwin-arm64' : 'darwin-x64'
            manifest.installers[key] = { filename: file, url, sha256, size }
        } else if (file.endsWith('.exe')) {
            const key = isArm ? 'win32-arm64' : 'win32-x64'
            manifest.installers[key] = { filename: file, url, sha256, size }
        } else if (file.endsWith('.AppImage')) {
            const key = isArm ? 'linux-arm64' : 'linux-x64'
            manifest.installers[key] = { filename: file, url, sha256, size }
        } else if (file.endsWith('.tar.gz')) {
            const key = isArm ? 'linux-arm64' : 'linux-x64'
            if (!manifest.installers[key]) {
                manifest.installers[key] = { filename: file, url, sha256, size }
            }
        }
    }

    // Validate that at least one asset was detected
    const hasAsar = Boolean(manifest.asar)
    const hasInstallers = Object.keys(manifest.installers).length > 0
    if (!hasAsar && !hasInstallers) {
        throw new Error(
            `No release assets detected in ${assetsDir}. Expected at least one asar patch or platform installer.`,
        )
    }

    const outputDir = path.dirname(outputPath)
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true })
    }

    fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2), 'utf8')
    console.log(`[Manifest Generator] Generated release-manifest.json successfully at ${outputPath}`)

    return manifest
}

// Execute when invoked as entry script
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
    try {
        generateReleaseManifest()
    } catch (err) {
        console.error('[Manifest Generator] Fatal error:', err)
        process.exit(1)
    }
}
