import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(__dirname, '..')
const RESOURCES_BIN = path.join(ROOT_DIR, 'resources', 'bin')

// Pin stable versions of ripgrep and fd
const RG_VERSION = '15.2.0' // Latest ripgrep release
const FD_VERSION = '10.4.2' // Latest fd release (darwin-x64 uses 10.3.0 as upstream removed x86_64 macOS runners in 10.4+)

const TARGETS = {
    'darwin-arm64': {
        os: 'darwin',
        arch: 'arm64',
        rgVersion: RG_VERSION,
        fdVersion: FD_VERSION,
        rgUrl: `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/ripgrep-${RG_VERSION}-aarch64-apple-darwin.tar.gz`,
        fdUrl: `https://github.com/sharkdp/fd/releases/download/v${FD_VERSION}/fd-v${FD_VERSION}-aarch64-apple-darwin.tar.gz`,
        binExt: '',
    },
    'darwin-x64': {
        os: 'darwin',
        arch: 'x64',
        rgVersion: RG_VERSION,
        fdVersion: '10.3.0',
        rgUrl: `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/ripgrep-${RG_VERSION}-x86_64-apple-darwin.tar.gz`,
        fdUrl: `https://github.com/sharkdp/fd/releases/download/v10.3.0/fd-v10.3.0-x86_64-apple-darwin.tar.gz`,
        binExt: '',
    },
    'linux-arm64': {
        os: 'linux',
        arch: 'arm64',
        rgVersion: RG_VERSION,
        fdVersion: FD_VERSION,
        rgUrl: `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/ripgrep-${RG_VERSION}-aarch64-unknown-linux-gnu.tar.gz`,
        fdUrl: `https://github.com/sharkdp/fd/releases/download/v${FD_VERSION}/fd-v${FD_VERSION}-aarch64-unknown-linux-gnu.tar.gz`,
        binExt: '',
    },
    'linux-x64': {
        os: 'linux',
        arch: 'x64',
        rgVersion: RG_VERSION,
        fdVersion: FD_VERSION,
        // Using musl builds for static binary linking and universal Linux distro compatibility
        rgUrl: `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/ripgrep-${RG_VERSION}-x86_64-unknown-linux-musl.tar.gz`,
        fdUrl: `https://github.com/sharkdp/fd/releases/download/v${FD_VERSION}/fd-v${FD_VERSION}-x86_64-unknown-linux-musl.tar.gz`,
        binExt: '',
    },
    'win32-arm64': {
        os: 'win32',
        arch: 'arm64',
        rgVersion: RG_VERSION,
        fdVersion: FD_VERSION,
        rgUrl: `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/ripgrep-${RG_VERSION}-aarch64-pc-windows-msvc.zip`,
        fdUrl: `https://github.com/sharkdp/fd/releases/download/v${FD_VERSION}/fd-v${FD_VERSION}-aarch64-pc-windows-msvc.zip`,
        binExt: '.exe',
    },
    'win32-x64': {
        os: 'win32',
        arch: 'x64',
        rgVersion: RG_VERSION,
        fdVersion: FD_VERSION,
        rgUrl: `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/ripgrep-${RG_VERSION}-x86_64-pc-windows-msvc.zip`,
        fdUrl: `https://github.com/sharkdp/fd/releases/download/v${FD_VERSION}/fd-v${FD_VERSION}-x86_64-pc-windows-msvc.zip`,
        binExt: '.exe',
    },
}

async function downloadFile(url, destPath) {
    const res = await fetch(url, { headers: { 'User-Agent': 'CodingProfessionalAgent-Downloader' } })
    if (!res.ok) {
        throw new Error(`Failed to download ${url}: status ${res.status} ${res.statusText}`)
    }
    const arrayBuffer = await res.arrayBuffer()
    fs.writeFileSync(destPath, Buffer.from(arrayBuffer))
}

function findFileRecursively(dir, fileName) {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
            const found = findFileRecursively(fullPath, fileName)
            if (found) return found
        } else if (entry.isFile() && entry.name === fileName) {
            return fullPath
        }
    }
    return null
}

function extractArchive(archivePath, destDir) {
    fs.mkdirSync(destDir, { recursive: true })
    const isZip = archivePath.endsWith('.zip')

    if (isZip) {
        if (process.platform === 'win32') {
            execSync(`powershell -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force"`, { stdio: 'pipe' })
        } else {
            try {
                execSync(`unzip -q -o "${archivePath}" -d "${destDir}"`, { stdio: 'pipe' })
            } catch {
                // Fallback to tar if unzip is missing (tar on macOS/Linux/BSD handles zip)
                execSync(`tar -xf "${archivePath}" -C "${destDir}"`, { stdio: 'pipe' })
            }
        }
    } else {
        execSync(`tar -xzf "${archivePath}" -C "${destDir}"`, { stdio: 'pipe' })
    }
}

async function processTarget(key, config) {
    const targetDir = path.join(RESOURCES_BIN, key)
    fs.mkdirSync(targetDir, { recursive: true })

    const rgBinName = `rg${config.binExt}`
    const fdBinName = `fd${config.binExt}`
    const rgBinPath = path.join(targetDir, rgBinName)
    const fdBinPath = path.join(targetDir, fdBinName)

    if (fs.existsSync(rgBinPath) && fs.existsSync(fdBinPath)) {
        console.log(`[binaries] ${key} is already cached in resources/bin/${key}`)
        return
    }

    const tmpDir = path.join(ROOT_DIR, '.tmp_bin', key)
    fs.mkdirSync(tmpDir, { recursive: true })

    try {
        // 1. ripgrep
        if (!fs.existsSync(rgBinPath)) {
            console.log(`[binaries] Downloading ripgrep (${RG_VERSION}) for ${key}...`)
            const isZip = config.rgUrl.endsWith('.zip')
            const archivePath = path.join(tmpDir, `rg_archive${isZip ? '.zip' : '.tar.gz'}`)
            const extractDir = path.join(tmpDir, 'rg_extracted')
            
            await downloadFile(config.rgUrl, archivePath)
            extractArchive(archivePath, extractDir)

            const foundRg = findFileRecursively(extractDir, rgBinName)
            if (!foundRg) {
                throw new Error(`Could not find ${rgBinName} in extracted ripgrep archive for ${key}`)
            }
            fs.copyFileSync(foundRg, rgBinPath)
            if (config.os !== 'win32') {
                fs.chmodSync(rgBinPath, 0o755)
            }
            console.log(`[binaries] Successfully prepared ${rgBinName} for ${key}`)
        }

        // 2. fd
        if (!fs.existsSync(fdBinPath)) {
            console.log(`[binaries] Downloading fd (${FD_VERSION}) for ${key}...`)
            const isZip = config.fdUrl.endsWith('.zip')
            const archivePath = path.join(tmpDir, `fd_archive${isZip ? '.zip' : '.tar.gz'}`)
            const extractDir = path.join(tmpDir, 'fd_extracted')

            await downloadFile(config.fdUrl, archivePath)
            extractArchive(archivePath, extractDir)

            const foundFd = findFileRecursively(extractDir, fdBinName)
            if (!foundFd) {
                throw new Error(`Could not find ${fdBinName} in extracted fd archive for ${key}`)
            }
            fs.copyFileSync(foundFd, fdBinPath)
            if (config.os !== 'win32') {
                fs.chmodSync(fdBinPath, 0o755)
            }
            console.log(`[binaries] Successfully prepared ${fdBinName} for ${key}`)
        }
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true })
    }
}

async function main() {
    const downloadAll = process.argv.includes('--all')
    const targetArg = process.argv.find(arg => arg.startsWith('--target='))
    const specifiedTarget = targetArg ? targetArg.split('=')[1] : null
    const currentKey = specifiedTarget || `${process.platform}-${process.arch}`

    if (downloadAll) {
        console.log('[binaries] Preparing binaries for all 6 target platforms...')
        for (const [key, config] of Object.entries(TARGETS)) {
            await processTarget(key, config)
        }
    } else {
        const config = TARGETS[currentKey]
        if (!config) {
            console.warn(`[binaries] Platform/arch ${currentKey} is not in target matrix. Skipping binary download.`)
            return
        }
        await processTarget(currentKey, config)
    }
}

main().catch((err) => {
    console.error('[binaries] Failed to download native binaries:', err)
    process.exit(1)
})
