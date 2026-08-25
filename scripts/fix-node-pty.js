import * as fs from 'node:fs'
import * as path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

function fixNodePtyPermissions() {
  if (process.platform === 'win32') return

  try {
    const ptyPath = require.resolve('node-pty')
    const ptyDir = path.dirname(ptyPath)
    const baseDir = path.resolve(ptyDir, '..')

    const prebuildsDir = path.join(baseDir, 'prebuilds')
    if (fs.existsSync(prebuildsDir)) {
      const subdirs = fs.readdirSync(prebuildsDir)
      for (const subdir of subdirs) {
        const helper = path.join(prebuildsDir, subdir, 'spawn-helper')
        if (fs.existsSync(helper)) {
          const stat = fs.statSync(helper)
          if ((stat.mode & 0o111) === 0) {
            fs.chmodSync(helper, stat.mode | 0o755)
            console.log(`[fix-node-pty] Made executable: ${helper}`)
          }
        }
      }
    }
  } catch {
    // Ignore if node-pty is not installed
  }
}

fixNodePtyPermissions()
