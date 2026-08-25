import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.resolve(__dirname, '..', 'bin', 'dist')

function normalizeArtifacts() {
    if (!fs.existsSync(distDir)) {
        console.log('[normalize-artifacts] Directory bin/dist does not exist, skipping.')
        return
    }

    const files = fs.readdirSync(distDir)
    for (const file of files) {
        const fullPath = path.join(distDir, file)
        if (!fs.statSync(fullPath).isFile()) continue

        if (file.endsWith('.blockmap') || file.endsWith('.yml') || file.endsWith('.yaml')) {
            fs.unlinkSync(fullPath)
            console.log(`[normalize-artifacts] Removed metadata: ${file}`)
            continue
        }

        const ext = path.extname(file)
        const isTarget = ['.dmg', '.exe', '.AppImage', '.zip'].includes(ext) || file.endsWith('.tar.gz')
        if (!isTarget) continue

        const newName = file
            .replace(/x86_64/g, 'amd64')
            .replace(/x64/g, 'amd64')
            .replace(/arm64/g, 'aarch64')

        if (newName !== file) {
            const newFullPath = path.join(distDir, newName)
            fs.renameSync(fullPath, newFullPath)
            console.log(`[normalize-artifacts] Renamed: ${file} -> ${newName}`)
        }
    }
}

normalizeArtifacts()
