import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const require = createRequire(import.meta.url)

function walkDir(dir, matcher, onFile) {
    if (!fs.existsSync(dir)) return
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name)
            if (entry.isDirectory()) {
                walkDir(fullPath, matcher, onFile)
            } else if (entry.isFile() && matcher(fullPath)) {
                onFile(fullPath)
            }
        }
    } catch {}
}

function patchMacCodeSign(filePath) {
    try {
        let content = fs.readFileSync(filePath, 'utf8')
        if (content.includes('[fix-electron-builder]')) {
            return false
        }

        const target1 = 'return await importCerts(keychainFile, certPaths, cscPasswords);'
        const replace1 = 'return await importCerts(keychainFile, certPaths, cscPasswords, keychainPassword);'

        const target2 = 'async function importCerts(keychainFile, paths, keyPasswords) {'
        const replace2 = 'async function importCerts(keychainFile, paths, keyPasswords, keychainPassword) {'

        const target3 = '["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", password, keychainFile]'
        const replace3 = '["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", keychainPassword, keychainFile] /* [fix-electron-builder] */'

        if (content.includes(target1) && content.includes(target2) && content.includes(target3)) {
            content = content
                .replace(target1, replace1)
                .replace(target2, replace2)
                .replace(target3, replace3)
            fs.writeFileSync(filePath, content, 'utf8')
            console.log(`[fix-electron-builder] Patched keychain password in: ${filePath}`)
            return true
        }
    } catch (err) {
        console.warn(`[fix-electron-builder] Error patching ${filePath}:`, err.message)
    }
    return false
}

function fixElectronBuilder() {
    let patchedCount = 0
    const patchedFiles = new Set()

    // 1. Try resolving via electron-builder dependency tree
    try {
        const ebEntry = require.resolve('electron-builder')
        const ebReq = createRequire(ebEntry)
        const macSignPath = ebReq.resolve('app-builder-lib/out/codeSign/macCodeSign.js')
        if (fs.existsSync(macSignPath)) {
            if (patchMacCodeSign(macSignPath)) {
                patchedCount++
            }
            patchedFiles.add(macSignPath)
        }
    } catch {}

    // 2. Scan node_modules for any remaining app-builder-lib instances
    const nodeModulesDir = path.join(rootDir, 'node_modules')
    if (fs.existsSync(nodeModulesDir)) {
        walkDir(
            nodeModulesDir,
            (p) => p.endsWith(path.join('app-builder-lib', 'out', 'codeSign', 'macCodeSign.js')),
            (filePath) => {
                const realPath = fs.realpathSync(filePath)
                if (!patchedFiles.has(realPath)) {
                    patchedFiles.add(realPath)
                    if (patchMacCodeSign(realPath)) {
                        patchedCount++
                    }
                }
            }
        )
    }

    console.log(`[fix-electron-builder] Complete. Total files patched: ${patchedCount}`)
}

fixElectronBuilder()
