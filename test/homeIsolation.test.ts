import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('default storage isolation', () => {
    it('binds home and configuration overrides to the disposable test directory', () => {
        const home = os.homedir()
        expect(home).toContain('cpa-test-home-')
        expect(process.env.USERPROFILE).toBe(home)
        expect(process.env.CPA_HOME).toBe(home)
        expect(process.env.CPA_CONFIG_DIR_NAME).toBe('.coding-professional-agent')
        for (const key of ['APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) {
            const relative = path.relative(home, process.env[key] ?? '')
            expect(path.isAbsolute(relative)).toBe(false)
            expect(relative.startsWith('..')).toBe(false)
        }
    })
})
