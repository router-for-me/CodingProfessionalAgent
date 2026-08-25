import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')

const PIPELINE_COMPAT = `let Minipass = require('minipass')
// [fix-minipass] unwrap Minipass class if imported from CJS namespace
if (typeof Minipass !== 'function' && Minipass && typeof Minipass.Minipass === 'function') {
  Minipass = Minipass.Minipass
}`

const MINIPASS_EXPORT_PATCH = `
// [fix-minipass] Safe compatibility export for older CommonJS consumers
if (typeof exports.Minipass === "function") {
  const OriginalClass = exports.Minipass;
  module.exports = OriginalClass;
  for (const key of Object.getOwnPropertyNames(exports)) {
    if (key === "default" || key in OriginalClass) continue;
    try {
      const desc = Object.getOwnPropertyDescriptor(exports, key);
      if (desc) Object.defineProperty(OriginalClass, key, desc);
    } catch {}
  }
}
`

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

function fixMinipass() {
    let patchedCount = 0
    const nodeModulesDir = path.join(rootDir, 'node_modules')
    if (!fs.existsSync(nodeModulesDir)) return

    // Restore minipass-pipeline template if corrupted
    const cleanPipelinePath = '/tmp/package/index.js'
    const hasCleanTemplate = fs.existsSync(cleanPipelinePath)

    // 1. Patch minipass-pipeline index.js
    walkDir(
        nodeModulesDir,
        (p) => p.endsWith(path.join('minipass-pipeline', 'index.js')),
        (filePath) => {
            try {
                let content = fs.readFileSync(filePath, 'utf8')
                if (content.length < 100 && hasCleanTemplate) {
                    content = fs.readFileSync(cleanPipelinePath, 'utf8')
                }
                if (!content.includes('[fix-minipass]')) {
                    const replaced = content.replace(
                        "const Minipass = require('minipass')",
                        PIPELINE_COMPAT
                    )
                    if (replaced !== content) {
                        fs.writeFileSync(filePath, replaced, 'utf8')
                        patchedCount++
                        console.log(`[fix-minipass] Patched minipass-pipeline: ${filePath}`)
                    }
                }
            } catch (err) {
                console.warn(`[fix-minipass] Error patching ${filePath}:`, err.message)
            }
        }
    )

    // 2. Patch minipass CJS entry points
    walkDir(
        nodeModulesDir,
        (p) => p.endsWith(path.join('minipass', 'dist', 'commonjs', 'index.js')),
        (filePath) => {
            try {
                let content = fs.readFileSync(filePath, 'utf8')
                if (content.includes('// [fix-minipass]')) {
                    content = content.replace(/\n\/\/ \[fix-minipass\][\s\S]*$/, '')
                }
                if (content.includes('exports.Minipass = Minipass')) {
                    content += MINIPASS_EXPORT_PATCH
                    fs.writeFileSync(filePath, content, 'utf8')
                    patchedCount++
                    console.log(`[fix-minipass] Patched minipass CJS export: ${filePath}`)
                }
            } catch (err) {
                console.warn(`[fix-minipass] Error patching ${filePath}:`, err.message)
            }
        }
    )

    console.log(`[fix-minipass] Complete. Total files patched: ${patchedCount}`)
}

fixMinipass()
