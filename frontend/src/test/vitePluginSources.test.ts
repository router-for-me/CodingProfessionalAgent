// @vitest-environment node
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import viteConfig from '../../vite.config.ts'
import vitestConfig from '../../vitest.config.ts'
import { frontendResolveAliases, zustandEsmResolvePlugin } from '../../vite.aliases.ts'
import { create } from '../vendor/zustand'

interface ConfigWithTest {
    test?: {
        include?: string[]
    }
}

describe('Vite & Vitest external plugin sources configuration', () => {
    it('allows repository root in Vite server.fs.allow', () => {
        const repoRoot = path.resolve(__dirname, '../../..')
        const allowed = viteConfig.server?.fs?.allow ?? []
        const normalizedAllowed = allowed.map((item: string) => path.resolve(__dirname, '../..', item))
        expect(normalizedAllowed).toContain(repoRoot)
    })

    it('includes bundled plugin and frontend tests in vitest include pattern', () => {
        const config = vitestConfig as ConfigWithTest
        const include = config.test?.include ?? []
        expect(include).toContain('src/**/*.test.{ts,tsx}')
        expect(include).toContain('../plugins/bundled/**/renderer/**/*.test.{ts,tsx}')
    })

    it('contains Tailwind v4 @source directives for bundled plugins, plugin-ui, and context-usage in app.css', () => {
        const cssPath = path.resolve(__dirname, '../styles/app.css')
        const cssContent = fs.readFileSync(cssPath, 'utf-8')
        expect(cssContent).toContain('@source "../../../plugins/bundled/**/*.{ts,tsx}";')
        expect(cssContent).toContain('@source "../../../packages/plugin-ui/src/**/*.{ts,tsx}";')
        expect(cssContent).toContain('@source "../../../packages/context-usage/src/**/*.{ts,tsx}";')
    })

    it('aliases the zustand specifier to a first-party shim instead of the package directory', () => {
        const rootAlias = frontendResolveAliases.find(
            (entry: { find: string | RegExp; replacement: string }) => entry.find instanceof RegExp && entry.find.test('zustand') && !entry.find.test('zustand/vanilla'),
        )
        const subpathAlias = frontendResolveAliases.find(
            (entry: { find: string | RegExp; replacement: string }) => entry.find instanceof RegExp && entry.find.test('zustand/vanilla'),
        )
        expect(rootAlias).toBeDefined()
        expect(rootAlias?.replacement.split('\\').join('/')).toMatch(/\/src\/vendor\/zustand\.ts$/)
        expect(subpathAlias).toBeDefined()
        expect(subpathAlias?.replacement.split('\\').join('/')).toMatch(/\/zustand\/esm\/\$1\.mjs$/)
    })

    it('resolves zustand to the local shim that exports create', async () => {
        const plugin = zustandEsmResolvePlugin()
        const resolveId = plugin.resolveId as (id: string) => string | null
        const shimPath = resolveId('zustand')
        const vanillaPath = resolveId('zustand/vanilla')
        const reactPath = resolveId('zustand/react')
        expect(shimPath?.split('\\').join('/')).toMatch(/\/src\/vendor\/zustand\.ts$/)
        expect(vanillaPath?.split('\\').join('/')).toMatch(/\/zustand\/esm\/vanilla\.mjs$/)
        expect(reactPath?.split('\\').join('/')).toMatch(/\/zustand\/esm\/react\.mjs$/)

        expect(typeof create).toBe('function')
        const useCount = create<{ n: number }>(() => ({ n: 1 }))
        expect(useCount.getState().n).toBe(1)
        expect(viteConfig.optimizeDeps?.exclude).toContain('zustand')
    })
})
