import { describe, expect, it } from 'vitest'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'
import {
    generateFixtureCatalog,
    scanBundledPluginContracts,
    verifyGeneratedLoaders,
} from '../scripts/generate-bundled-plugin-catalog.mjs'

describe('bundledPluginLoaderGenerator', () => {
    it('generates real entry loaders directly from manifests', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-generator-test-'))
        try {
            const authDir = path.join(tempDir, 'plugins', 'bundled', 'cpa.core.auth-sample')
            fs.mkdirSync(path.join(authDir, 'renderer'), { recursive: true })

            // Real entry file exists for auth plugin
            fs.writeFileSync(path.join(authDir, 'renderer', 'index.tsx'), 'export default { runtime: "renderer", activate() {} }')

            const authoritativeFixture = {
                manifest: {
                    id: 'cpa.core.auth-sample',
                    name: 'Auth Sample',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '>=1.0.0' },
                    entries: {
                        renderer: './renderer/index.tsx',
                    },
                    dependencies: {},
                    capabilities: [],
                    contributes: {
                        view: ['auth-view'],
                    },
                },
                dirName: 'cpa.core.auth-sample',
                sourceRoot: 'plugins/bundled/cpa.core.auth-sample',
            }

            const result = await generateFixtureCatalog([authoritativeFixture], {
                rootDir: tempDir,
            })

            expect(result.renderer).toContain('bundledRendererEntryLoaders')
            expect(result.manifestCopies).toBe(0)
            expect(result.renderer).not.toContain('JSON.stringify')
            expect(result.renderer).not.toContain('bundledPluginPackages')

            // Authoritative plugin should load directly without legacy adapter
            const authLoaderMatch = result.renderer.match(/'cpa\.core\.auth-sample':\s*async\s*\(\)\s*=>\s*\{([\s\S]*?)\}/)
            expect(authLoaderMatch).toBeTruthy()
            expect(authLoaderMatch![1]).toContain('mod.default ?? mod.entry ?? mod')
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true })
        }
    })

    it('throws when a declared entry file is missing on disk', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-missing-entry-test-'))
        try {
            const pluginDir = path.join(tempDir, 'plugins', 'bundled', 'cpa.core.missing-entry')
            fs.mkdirSync(pluginDir, { recursive: true })

            const fixture = {
                manifest: {
                    id: 'cpa.core.missing-entry',
                    name: 'Missing Entry',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '>=1.0.0' },
                    entries: {
                        renderer: './renderer/index.tsx',
                    },
                    dependencies: {},
                    capabilities: [],
                    contributes: {},
                },
                dirName: 'cpa.core.missing-entry',
                sourceRoot: 'plugins/bundled/cpa.core.missing-entry',
            }

            expect(() =>
                generateFixtureCatalog([fixture], {
                    rootDir: tempDir,
                }),
            ).toThrow('declares renderer entry "./renderer/index.tsx" but file was not found')
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true })
        }
    })

    it('does not generate main entry loader if manifest does not declare entries.main', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-no-main-test-'))
        try {
            const pluginDir = path.join(tempDir, 'plugins', 'bundled', 'cpa.core.renderer-only')
            fs.mkdirSync(path.join(pluginDir, 'renderer'), { recursive: true })
            fs.writeFileSync(path.join(pluginDir, 'renderer', 'index.ts'), 'export default { runtime: "renderer", activate() {} }')

            const rendererOnlyFixture = {
                manifest: {
                    id: 'cpa.core.renderer-only',
                    name: 'Renderer Only',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '>=1.0.0' },
                    entries: {
                        renderer: './renderer/index.ts',
                    },
                    dependencies: {},
                    capabilities: [],
                    contributes: {},
                },
                dirName: 'cpa.core.renderer-only',
                sourceRoot: 'plugins/bundled/cpa.core.renderer-only',
            }

            const result = await generateFixtureCatalog([rendererOnlyFixture], {
                rootDir: tempDir,
            })

            expect(result.main).not.toContain('cpa.core.renderer-only')
            expect(result.renderer).toContain('cpa.core.renderer-only')
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true })
        }
    })

    it('verifies generated bundled plugin loaders in current workspace', () => {
        const verification = verifyGeneratedLoaders()
        expect(verification.ok).toBe(true)
        expect(verification.manifests.length).toBeGreaterThanOrEqual(22)
    })
})
