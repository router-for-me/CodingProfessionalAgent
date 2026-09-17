import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import * as crypto from 'node:crypto'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { generateReleaseManifest } from './generate-release-manifest.mjs'

/**
 * Executes a shell command with retry logic for network and transient API errors.
 */
export async function execWithRetry(command, options = {}) {
    const retries = options.retries ?? 4
    const delayMs = options.delayMs ?? 5000
    let lastError = null

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return execSync(command, {
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'pipe'],
                timeout: options.timeout || 600000, // 10 minutes timeout per execution
                ...options,
            })
        } catch (err) {
            lastError = err
            const stderr = err.stderr ? err.stderr.toString().trim() : ''
            const stdout = err.stdout ? err.stdout.toString().trim() : ''
            console.warn(`[publish] Command failed (attempt ${attempt}/${retries}): ${command}`)
            if (stderr) console.warn(`[publish] stderr: ${stderr}`)
            if (stdout && !stderr) console.warn(`[publish] stdout: ${stdout}`)

            if (attempt < retries) {
                console.log(`[publish] Waiting ${delayMs / 1000}s before retrying...`)
                await new Promise((resolve) => setTimeout(resolve, delayMs))
            }
        }
    }

    if (options.ignoreError) {
        return null
    }
    throw lastError
}

/**
 * Discovers distributable binary artifacts in the specified directory.
 */
export function findTargetArtifacts(dir) {
    if (!fs.existsSync(dir)) return []

    const files = fs.readdirSync(dir)
    const targetFiles = []

    for (const file of files) {
        const fullPath = path.join(dir, file)
        if (!fs.statSync(fullPath).isFile()) continue

        // Skip metadata, checksum, and yaml files
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

        const ext = path.extname(file)
        const isTarget =
            ['.dmg', '.exe', '.AppImage', '.zip', '.asar'].includes(ext) || file.endsWith('.tar.gz')

        if (isTarget) {
            targetFiles.push(file)
        }
    }

    return targetFiles
}

/**
 * Resolves default tag name from arguments, environment variables, or package.json.
 */
function resolveTag(providedTag) {
    if (providedTag) return providedTag
    if (process.env.TAG) return process.env.TAG
    if (process.env.GITHUB_REF_NAME) return process.env.GITHUB_REF_NAME
    if (process.env.GITHUB_REF && process.env.GITHUB_REF.startsWith('refs/tags/')) {
        return process.env.GITHUB_REF.replace('refs/tags/', '')
    }

    try {
        const pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
        if (pkg.version) return `v${pkg.version}`
    } catch {}

    return 'v1.0.0'
}

/**
 * Uploads newly produced release artifacts sequentially and incrementally
 * supplements release-manifest.json and SHA256SUMS.txt on GitHub Release.
 */
export async function publishReleaseArtifacts(options = {}) {
    const rawTag = options.tag || process.argv[2]
    const tag = resolveTag(rawTag)

    const rawAssetsDir = options.artifactsDir || process.argv[3] || path.join(process.cwd(), 'bin', 'dist')
    const assetsDir = path.resolve(rawAssetsDir)

    console.log(`[publish] Scanning artifacts in ${assetsDir} for release ${tag}...`)
    const targetFiles = findTargetArtifacts(assetsDir)

    if (targetFiles.length === 0) {
        console.log('[publish] No target artifacts found to upload.')
        return { uploaded: [], manifest: null }
    }

    console.log(`[publish] Found ${targetFiles.length} artifact(s) to publish: ${targetFiles.join(', ')}`)

    // 1. Upload each artifact sequentially to avoid overwhelming uploads.github.com
    for (const file of targetFiles) {
        const fullPath = path.join(assetsDir, file)
        const sizeMb = (fs.statSync(fullPath).size / (1024 * 1024)).toFixed(2)
        console.log(`[publish] ⬆️ Uploading ${file} (${sizeMb} MB)...`)
        await execWithRetry(`gh release upload "${tag}" "${fullPath}" --clobber`, {
            retries: 4,
            delayMs: 6000,
        })
        console.log(`[publish] ✓ Successfully uploaded ${file}`)
    }

    // 2. Fetch existing release-manifest.json and SHA256SUMS.txt from GitHub Release into a temp directory
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-release-'))
    try {
        console.log(`[publish] Fetching existing release manifest and checksums for ${tag}...`)
        await execWithRetry(
            `gh release download "${tag}" -p "release-manifest.json" -p "SHA256SUMS.txt" -D "${tempDir}" --clobber`,
            { retries: 2, delayMs: 2000, ignoreError: true },
        )

        // 3. Incrementally update SHA256SUMS.txt
        const sha256SumsPath = path.join(tempDir, 'SHA256SUMS.txt')
        const checksumMap = new Map()

        if (fs.existsSync(sha256SumsPath)) {
            const lines = fs.readFileSync(sha256SumsPath, 'utf8').split('\n')
            for (const line of lines) {
                const trimmed = line.trim()
                if (!trimmed) continue
                const parts = trimmed.split(/\s+/)
                if (parts.length >= 2) {
                    const hash = parts[0]
                    const fname = parts.slice(1).join(' ').trim()
                    checksumMap.set(fname, hash)
                }
            }
        }

        for (const file of targetFiles) {
            const fullPath = path.join(assetsDir, file)
            const buf = fs.readFileSync(fullPath)
            const hash = crypto.createHash('sha256').update(buf).digest('hex')
            checksumMap.set(file, hash)
        }

        const sortedFiles = Array.from(checksumMap.keys()).sort()
        const newSumsContent = sortedFiles.map((f) => `${checksumMap.get(f)}  ${f}`).join('\n') + '\n'
        fs.writeFileSync(sha256SumsPath, newSumsContent, 'utf8')
        console.log(`[publish] Updated SHA256SUMS.txt (${sortedFiles.length} file checksums recorded).`)

        // 4. Incrementally update release-manifest.json
        const manifestOutputPath = path.join(tempDir, 'release-manifest.json')
        const localManifestInAssets = path.join(assetsDir, 'release-manifest.json')
        let existingManifestPath = manifestOutputPath
        if (!fs.existsSync(manifestOutputPath) && fs.existsSync(localManifestInAssets)) {
            existingManifestPath = localManifestInAssets
        }

        const updatedManifest = generateReleaseManifest({
            tag,
            assetsDir,
            outputPath: manifestOutputPath,
            mergeExisting: true,
            existingManifestPath,
        })

        const installersCount = Object.keys(updatedManifest.installers || {}).length
        const asarStatus = updatedManifest.asar ? 'yes' : 'no'
        console.log(
            `[publish] Generated release-manifest.json (installers: ${installersCount}, asar: ${asarStatus})`,
        )

        // 5. Upload updated SHA256SUMS.txt and release-manifest.json
        console.log(`[publish] ⬆️ Uploading updated SHA256SUMS.txt and release-manifest.json...`)
        await execWithRetry(
            `gh release upload "${tag}" "${sha256SumsPath}" "${manifestOutputPath}" --clobber`,
            { retries: 4, delayMs: 4000 },
        )
        console.log(`[publish] ✓ Release manifest and checksums published successfully!`)

        return {
            uploaded: targetFiles,
            manifest: updatedManifest,
        }
    } finally {
        try {
            fs.rmSync(tempDir, { recursive: true, force: true })
        } catch {}
    }
}

// Execute when invoked as entry script
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
    publishReleaseArtifacts().catch((err) => {
        console.error('[publish] Fatal error:', err)
        process.exit(1)
    })
}
