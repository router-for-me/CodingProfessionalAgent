import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import {
    bootstrapPluginGraph,
    type BootstrapPluginGraphOptions,
    type BootstrapPluginGraphResult,
} from '../src/main/plugins/catalog/bootstrapPluginGraph.js'
import {
    createResolvedPluginGraphDTO,
    computePluginGraphRevision,
} from '../src/main/plugins/catalog/graphRevision.js'
import {
    PluginDependencyError,
    PluginValidationError,
    type ResolvedPluginPackage,
    type ResolvedPluginGraphDTO,
    type ResolvedPluginNodeDTO,
} from '@cpa/plugin-api'

describe('Plugin Catalog Bootstrap & Graph Revision', () => {
    let tempRoot: string
    let homeDir: string
    let projectDir: string
    let globalPluginsDir: string

    async function createPluginFixture(
        dir: string,
        manifestOverrides: Record<string, unknown> = {},
        entryFiles: Record<string, string> = { 'index.js': 'export default {};' },
    ): Promise<string> {
        await fs.mkdir(dir, { recursive: true })
        const manifest = {
            id: path.basename(dir),
            name: path.basename(dir),
            version: '1.0.0',
            apiVersion: '1.0.0',
            engines: { cpa: '^1.0.0' },
            entries: { main: './index.js' },
            ...manifestOverrides,
        }
        await fs.writeFile(
            path.join(dir, 'manifest.json'),
            JSON.stringify(manifest, null, 2),
            'utf-8',
        )
        for (const [filename, content] of Object.entries(entryFiles)) {
            const filePath = path.join(dir, filename)
            await fs.mkdir(path.dirname(filePath), { recursive: true })
            await fs.writeFile(filePath, content, 'utf-8')
        }
        return dir
    }

    beforeEach(async () => {
        tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cpa-bootstrap-test-'))
        homeDir = path.join(tempRoot, 'home')
        projectDir = path.join(tempRoot, 'project')

        globalPluginsDir = path.join(homeDir, '.coding-professional-agent', 'plugins')

        await fs.mkdir(globalPluginsDir, { recursive: true })
    })

    afterEach(async () => {
        try {
            await fs.rm(tempRoot, { recursive: true, force: true })
        } catch {
            // Ignore cleanup errors
        }
    })

    describe('Bootstrap & Resource Registration', () => {
        it('registers every resolved package before creating the business window', async () => {
            const pluginADir = path.join(globalPluginsDir, 'plugin-a')
            const pluginBDir = path.join(globalPluginsDir, 'plugin-b')

            await createPluginFixture(pluginADir, {
                id: 'plugin-a',
                name: 'Plugin A',
                version: '1.0.0',
                dependencies: { 'plugin-b': '^1.0.0' },
            })
            await createPluginFixture(pluginBDir, {
                id: 'plugin-b',
                name: 'Plugin B',
                version: '1.0.0',
            })

            const bundledPkg: ResolvedPluginPackage = {
                manifest: {
                    id: 'plugin-c',
                    name: 'Plugin C',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '^1.0.0' },
                    entries: { main: './index.js' },
                },
                source: { kind: 'bundled', spec: 'bundled:plugin-c' },
                sourceRoot: path.join(tempRoot, 'bundled-c'),
                entries: { main: './index.js' },
            }

            const fixtureOptions: BootstrapPluginGraphOptions = {
                cpaVersion: '1.0.0',
                homeDir,
                projectPath: projectDir,
                bundledPackages: [bundledPkg],
            }

            const result: BootstrapPluginGraphResult = await bootstrapPluginGraph(fixtureOptions)

            expect(result.graph).toBeDefined()
            expect(result.graph.revision).toMatch(/^[a-f0-9]{64}$/)
            expect(result.graph.createdAt).toBeGreaterThan(0)
            expect(result.graph.plugins).toHaveLength(3)
            expect(result.resourcePackageIds).toEqual(result.graph.plugins.map((plugin) => plugin.id))

            // Activation order: plugin-b (dep of a) must come before plugin-a
            const bIdx = result.graph.activationOrder.indexOf('plugin-b')
            const aIdx = result.graph.activationOrder.indexOf('plugin-a')
            expect(bIdx).toBeLessThan(aIdx)

            // Resource service has every resolved package registered
            for (const plugin of result.graph.plugins) {
                expect(result.resourceService.getPackage(plugin.id)).toBeDefined()
            }
        })
    })

    describe('Graph Revision Determinism and Sensitivity', () => {
        it('produces identical SHA-256 revision regardless of package discovery order', async () => {
            const pkgA: ResolvedPluginPackage = {
                manifest: {
                    id: 'pkg-a',
                    name: 'Package A',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '^1.0.0' },
                    entries: { main: './a.js' },
                },
                source: { kind: 'bundled', spec: 'bundled:pkg-a' },
                sourceRoot: '/path/to/a',
                entries: { main: './a.js' },
            }

            const pkgB: ResolvedPluginPackage = {
                manifest: {
                    id: 'pkg-b',
                    name: 'Package B',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '^1.0.0' },
                    dependencies: { 'pkg-a': '^1.0.0' },
                    entries: { main: './b.js' },
                },
                source: { kind: 'bundled', spec: 'bundled:pkg-b' },
                sourceRoot: '/path/to/b',
                entries: { main: './b.js' },
            }

            const result1 = await bootstrapPluginGraph({
                cpaVersion: '1.0.0',
                homeDir,
                bundledPackages: [pkgA, pkgB],
            })

            const result2 = await bootstrapPluginGraph({
                cpaVersion: '1.0.0',
                homeDir,
                bundledPackages: [pkgB, pkgA],
            })

            expect(result1.graph.revision).toEqual(result2.graph.revision)
            expect(result1.graph.activationOrder).toEqual(result2.graph.activationOrder)
        })

        it('does not include createdAt in graph revision hash', async () => {
            const rawGraph = {
                activationOrder: [
                    {
                        manifest: {
                            id: 'pkg-1',
                            name: 'Package 1',
                            version: '1.0.0',
                            apiVersion: '1.0.0',
                            engines: { cpa: '^1.0.0' },
                        },
                        source: { kind: 'bundled' as const, spec: 'bundled:pkg-1' },
                        sourceRoot: '/path/to/1',
                        entries: {},
                    },
                ],
                blocked: [],
            }

            const dto1 = createResolvedPluginGraphDTO(rawGraph, { createdAt: 100000 })
            const dto2 = createResolvedPluginGraphDTO(rawGraph, { createdAt: 99999999 })

            expect(dto1.createdAt).toBe(100000)
            expect(dto2.createdAt).toBe(99999999)
            expect(dto1.revision).toEqual(dto2.revision)
        })

        it('changes revision when manifest, entry, dependency, source, or integrity changes', async () => {
            const basePkg: ResolvedPluginPackage = {
                manifest: {
                    id: 'sample-plugin',
                    name: 'Sample Plugin',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '^1.0.0' },
                    entries: { main: './main.js' },
                    dependencies: { 'other-pkg': '^1.0.0' },
                },
                source: { kind: 'bundled', spec: 'bundled:sample-plugin' },
                sourceRoot: '/path/to/sample',
                entries: { main: './main.js' },
                integrity: 'sha256-initial',
            }

            const baseRevision = computePluginGraphRevision([basePkg])

            // Version change
            const vChanged = { ...basePkg, manifest: { ...basePkg.manifest, version: '1.0.1' } }
            expect(computePluginGraphRevision([vChanged])).not.toEqual(baseRevision)

            // Entry change
            const entryChanged = { ...basePkg, manifest: { ...basePkg.manifest, entries: { main: './other.js' } } }
            expect(computePluginGraphRevision([entryChanged])).not.toEqual(baseRevision)

            // Dependency change
            const depChanged = { ...basePkg, manifest: { ...basePkg.manifest, dependencies: { 'other-pkg': '^2.0.0' } } }
            expect(computePluginGraphRevision([depChanged])).not.toEqual(baseRevision)

            // Source kind change
            const sourceChanged = { ...basePkg, source: { kind: 'npm' as const, spec: 'path:/custom' } }
            expect(computePluginGraphRevision([sourceChanged])).not.toEqual(baseRevision)

            // Integrity change
            const integrityChanged = { ...basePkg, integrity: 'sha256-modified' }
            expect(computePluginGraphRevision([integrityChanged])).not.toEqual(baseRevision)
        })
    })

    describe('Criticality and Startup Error Semantics', () => {
        it('throws PluginDependencyError when a platform plugin cannot be resolved', async () => {
            const platformPkg: ResolvedPluginPackage = {
                manifest: {
                    id: 'critical-platform-plugin',
                    name: 'Critical Platform Plugin',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '^1.0.0' },
                    criticality: 'platform',
                    dependencies: { 'missing-dep': '^1.0.0' },
                },
                source: { kind: 'bundled', spec: 'bundled:critical-platform-plugin' },
                sourceRoot: '/path/to/platform',
                entries: {},
            }

            await expect(
                bootstrapPluginGraph({
                    cpaVersion: '1.0.0',
                    homeDir,
                    bundledPackages: [platformPkg],
                }),
            ).rejects.toThrow(PluginDependencyError)
        })

        it('throws PluginDependencyError when a required plugin cannot be resolved', async () => {
            const requiredPkg: ResolvedPluginPackage = {
                manifest: {
                    id: 'required-plugin',
                    name: 'Required Plugin',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '^1.0.0' },
                    criticality: 'required',
                    dependencies: { 'missing-dep': '^1.0.0' },
                },
                source: { kind: 'bundled', spec: 'bundled:required-plugin' },
                sourceRoot: '/path/to/required',
                entries: {},
            }

            await expect(
                bootstrapPluginGraph({
                    cpaVersion: '1.0.0',
                    homeDir,
                    bundledPackages: [requiredPkg],
                }),
            ).rejects.toThrow(PluginDependencyError)
        })

        it('isolates optional plugin failure and successfully boots remaining plugins', async () => {
            const optionalBrokenPkg: ResolvedPluginPackage = {
                manifest: {
                    id: 'optional-broken-plugin',
                    name: 'Optional Broken Plugin',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '^1.0.0' },
                    criticality: 'optional',
                    dependencies: { 'missing-dep': '^1.0.0' },
                },
                source: { kind: 'bundled', spec: 'bundled:optional-broken-plugin' },
                sourceRoot: '/path/to/broken',
                entries: {},
            }

            const validPkg: ResolvedPluginPackage = {
                manifest: {
                    id: 'valid-plugin',
                    name: 'Valid Plugin',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '^1.0.0' },
                },
                source: { kind: 'bundled', spec: 'bundled:valid-plugin' },
                sourceRoot: '/path/to/valid',
                entries: {},
            }

            const result = await bootstrapPluginGraph({
                cpaVersion: '1.0.0',
                homeDir,
                bundledPackages: [optionalBrokenPkg, validPkg],
            })

            expect(result.graph.plugins.map((p) => p.id)).toEqual(['valid-plugin'])
            expect(result.resourcePackageIds).toEqual(['valid-plugin'])
            expect(result.rawGraph.blocked).toHaveLength(1)
            expect(result.rawGraph.blocked[0].pluginId).toBe('optional-broken-plugin')
        })
    })

    describe('Resource Access & Boundary Security Post-Bootstrap', () => {
        it('allows reading valid resources and blocks path escapes from bootstrapped packages', async () => {
            const pluginDir = path.join(globalPluginsDir, 'secured-plugin')
            await createPluginFixture(
                pluginDir,
                {
                    id: 'secured-plugin',
                    name: 'Secured Plugin',
                    version: '1.0.0',
                },
                {
                    'index.js': 'export default {};',
                    'assets/info.json': '{"hello": "world"}',
                },
            )

            const result = await bootstrapPluginGraph({
                cpaVersion: '1.0.0',
                homeDir,
                projectPath: projectDir,
            })

            const resource = await result.resourceService.readResource(
                'secured-plugin',
                'assets/info.json',
            )
            expect(JSON.parse(resource.body.toString('utf-8'))).toEqual({ hello: 'world' })

            await expect(
                result.resourceService.readResource('secured-plugin', '../secret.txt'),
            ).rejects.toThrow(PluginValidationError)
        })
    })
})
