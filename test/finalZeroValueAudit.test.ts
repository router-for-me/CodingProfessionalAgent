import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'

const REPO_ROOT = path.resolve(__dirname, '..')

function runRg(pattern: string, searchPaths: string[] = ['src', 'frontend/src', 'packages', 'plugins/bundled']): string[] {
    const paths = searchPaths.map((p) => path.join(REPO_ROOT, p)).filter((p) => fs.existsSync(p))
    if (paths.length === 0) return []

    const args = [
        '-n',
        pattern,
        ...paths,
        '--glob', '!**/*.test.*',
        '--glob', '!**/*.spec.*',
        '--glob', '!**/dist/**',
        '--glob', '!**/node_modules/**',
        '--glob', '!**/fixtures/**',
    ]

    try {
        const output = execFileSync('/opt/homebrew/bin/rg', args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }).trim()
        return output ? output.split('\n') : []
    } catch (err: any) {
        // rg exits with 1 if no matches found
        if (err.status === 1) {
            return []
        }
        throw err
    }
}

describe('Task24 Final Zero-Value Audit', () => {
    it('enforces zero occurrences of window.electronBridge / electronBridge in production code', () => {
        const matches = runRg('\\belectronBridge\\b')
        expect(matches, `Found unexpected electronBridge references:\n${matches.join('\n')}`).toEqual([])
    })

    it('enforces zero occurrences of window.cpa, optional chaining, cast or computed cpa globals in production code', () => {
        const matches = runRg('(\\bwindow|\\bglobalThis|\\bself)(\\.cpa\\b|\\[[\'"]cpa[\'"]\\]|\\?\\.\\s*cpa\\b)|\\(window\\s+as\\s+any\\)\\.cpa\\b')
        expect(matches, `Found unexpected legacy cpa global references:\n${matches.join('\n')}`).toEqual([])
    })

    it('enforces that direct cpaHostTransport access is strictly isolated to hostTransport.ts, preload, and vite-env', () => {
        const matches = runRg('\\bcpaHostTransport\\b')
        const allowedFiles = [
            'src/preload/index.cts',
            'frontend/src/vite-env.d.ts',
            'frontend/src/application/services/hostTransport.ts',
        ]

        const unexpected = matches.filter((m) => {
            return !allowedFiles.some((allowed) => m.includes(allowed))
        })

        expect(unexpected, `Found direct cpaHostTransport access outside allowed host boundary files:\n${unexpected.join('\n')}`).toEqual([])
    })

    it('enforces zero occurrences of ipcRenderer literal in production code', () => {
        const matches = runRg('\\bipcRenderer\\b')
        expect(matches, `Found unexpected ipcRenderer references:\n${matches.join('\n')}`).toEqual([])
    })

    it('enforces zero occurrences of createCoreServiceDescriptors and createCoreRpcDescriptors', () => {
        const matches = runRg('createCoreServiceDescriptors|createCoreRpcDescriptors', ['src', 'frontend/src', 'packages', 'plugins', 'test'])
        expect(matches, `Found legacy descriptor factory names:\n${matches.join('\n')}`).toEqual([])
    })

    it('validates src/preload/index.cts exports only cpaHostTransport and no legacy broad globals', () => {
        const preloadContent = fs.readFileSync(path.join(REPO_ROOT, 'src/preload/index.cts'), 'utf8')
        
        expect(preloadContent).not.toContain('ipcRenderer')
        expect(preloadContent).not.toContain("exposeInMainWorld('electronBridge'")
        expect(preloadContent).not.toContain("exposeInMainWorld('cpa'")
        expect(preloadContent).toContain("exposeInMainWorld('cpaHostTransport'")
    })

    it('validates frontend/src/vite-env.d.ts does not declare electronBridge or cpa on Window', () => {
        const viteEnvContent = fs.readFileSync(path.join(REPO_ROOT, 'frontend/src/vite-env.d.ts'), 'utf8')
        expect(viteEnvContent).not.toContain('electronBridge?:')
        expect(viteEnvContent).not.toContain('cpa?:')
        expect(viteEnvContent).toContain('cpaHostTransport?:')
    })
})
