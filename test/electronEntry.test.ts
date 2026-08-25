import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const COMPILED_MAIN = 'dist-electron/src/main/index.js'

describe('Electron entry path', () => {
    it('package.json main and pnpm dev launch the tsc output under dist-electron/src/main', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
            main: string
        }
        expect(pkg.main).toBe(COMPILED_MAIN)

        const devScript = fs.readFileSync(path.join(repoRoot, 'scripts/dev.js'), 'utf8')
        expect(devScript).toContain(`'${COMPILED_MAIN}'`)
        expect(devScript).not.toContain("'dist-electron/main/index.js'")
    })
})
