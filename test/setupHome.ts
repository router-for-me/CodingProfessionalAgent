import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach } from 'vitest'

// Plugins may initialize before a test's explicit service options are applied.
// Isolate default-path storage too, including imports and runtime activation.
const testHome = mkdtempSync(join(tmpdir(), 'cpa-test-home-'))
function setTestHome(home: string): void {
    process.env.HOME = home
    process.env.USERPROFILE = home
    process.env.CPA_HOME = home
    process.env.CPA_CONFIG_DIR_NAME = '.coding-professional-agent'
    process.env.APPDATA = join(home, 'AppData', 'Roaming')
    process.env.LOCALAPPDATA = join(home, 'AppData', 'Local')
    process.env.XDG_CONFIG_HOME = join(home, '.config')
    process.env.XDG_DATA_HOME = join(home, '.local', 'share')
}
setTestHome(testHome)

beforeEach(() => {
    setTestHome(mkdtempSync(join(testHome, 'case-')))
})

afterAll(() => {
    // Never restore the real home in a worker that may still have async callbacks.
    rmSync(testHome, { recursive: true, force: true })
})
