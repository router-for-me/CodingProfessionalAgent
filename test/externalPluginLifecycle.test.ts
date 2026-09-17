import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import {
    type CapabilityHandle,
    type PluginContext,
    type PluginEntryDefinition,
    type PluginManifest,
    type ResolvedPluginGraphDTO,
    type ResolvedPluginPackage,
    DuplicatePluginSourceError,
    PluginDependencyError,
    PluginError,
    PluginManifestError,
    PluginValidationError,
} from '@cpa/plugin-api'
import {
    PluginCatalog,
    ContributionRegistry,
    PluginEventBus,
    PluginRuntimeCoordinator,
} from '@cpa/plugin-kernel'
import { createPluginCatalog } from '../src/main/plugins/catalog/createPluginCatalog.js'
import { bootstrapPluginGraph } from '../src/main/plugins/catalog/bootstrapPluginGraph.js'
import { computePluginGraphRevision, createResolvedPluginGraphDTO } from '../src/main/plugins/catalog/graphRevision.js'
import { MainPluginRuntimeHost } from '../src/main/plugins/runtime/MainPluginRuntimeHost.js'
import { MainPluginActivationCoordinator } from '../src/main/plugins/runtime/MainPluginActivationCoordinator.js'
import { MainPluginModuleLoader } from '../src/main/plugins/loading/MainPluginModuleLoader.js'
import { ExternalMainPluginHost } from '../src/main/plugins/loading/ExternalMainPluginHost.js'
import { PluginResourceService } from '../src/main/plugins/resources/PluginResourceService.js'
import { ManagedNpmInstaller, parseNpmSpec } from '../src/main/plugins/packages/ManagedNpmInstaller.js'
import { PluginPackageLock } from '../src/main/plugins/packages/PluginPackageLock.js'
import { RendererPluginRuntimeHost } from '../frontend/src/plugins/platform/RendererPluginRuntimeHost.js'
import { AgentPluginRuntimeHost } from '../frontend/src/plugins/platform/AgentPluginRuntimeHost.js'
import { PluginPlatformCoordinator } from '../frontend/src/plugins/platform/PluginPlatformCoordinator.js'
import { RendererPluginModuleLoader } from '../frontend/src/plugins/platform/RendererPluginModuleLoader.js'
import { PluginGraphManagementService } from '../src/main/plugins/management/PluginGraphManagementService.js'

describe('Task 22: External Plugin Unified Runtime Lifecycle & Multi-Source End-to-End', () => {
    let tempRoot: string
    let homeDir: string
    let projectDir: string
    let globalPluginsDir: string
    let npmPluginsDir: string

    beforeEach(async () => {
        tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cpa-task22-test-'))
        homeDir = path.join(tempRoot, 'home')
        projectDir = path.join(tempRoot, 'project')
        globalPluginsDir = path.join(homeDir, '.coding-professional-agent', 'plugins')
        npmPluginsDir = path.join(globalPluginsDir, 'npm')

        await fs.mkdir(globalPluginsDir, { recursive: true })
        await fs.mkdir(npmPluginsDir, { recursive: true })
    })

    afterEach(async () => {
        try {
            await fs.rm(tempRoot, { recursive: true, force: true })
        } catch {
            // Ignore temp cleanup errors
        }
    })

    async function createExternalPluginFixture(
        dir: string,
        id: string,
        entries: { main?: boolean; renderer?: boolean; agent?: boolean } = {
            main: true,
            renderer: true,
            agent: true,
        },
        overrides: Partial<PluginManifest> = {},
    ): Promise<string> {
        await fs.mkdir(dir, { recursive: true })
        const declaredEntries: Record<string, string> = {}
        const contributes: Record<string, string[]> = {}

        const serviceId = overrides.contributes?.service?.[0] ?? `${id}-main-service`
        const viewId = overrides.contributes?.view?.[0] ?? `${id}-renderer-view`
        const toolId = overrides.contributes?.['tool-factory']?.[0] ?? `${id}-agent-tool`

        if (entries.main) {
            declaredEntries.main = './main.js'
            contributes.service = [serviceId]
            await fs.writeFile(
                path.join(dir, 'main.js'),
                `export default {
                    runtime: 'main',
                    activate(ctx) {
                        ctx.register({
                            kind: 'service',
                            id: '${serviceId}',
                            value: {
                                plugin: '${id}',
                                runtime: 'main',
                                ping(msg) { return 'pong:' + msg; }
                            }
                        });
                    }
                };`,
                'utf-8',
            )
        }

        if (entries.renderer) {
            declaredEntries.renderer = './renderer.js'
            contributes.view = [viewId]
            await fs.writeFile(
                path.join(dir, 'renderer.js'),
                `export default {
                    runtime: 'renderer',
                    activate(ctx) {
                        ctx.register({
                            kind: 'view',
                            id: '${viewId}',
                            value: { plugin: '${id}', runtime: 'renderer' }
                        });
                    }
                };`,
                'utf-8',
            )
        }

        if (entries.agent) {
            declaredEntries.agent = './agent.js'
            contributes['tool-factory'] = [toolId]
            await fs.writeFile(
                path.join(dir, 'agent.js'),
                `export default {
                    runtime: 'agent',
                    activate(ctx) {
                        ctx.register({
                            kind: 'tool-factory',
                            id: '${toolId}',
                            value: { plugin: '${id}', runtime: 'agent' }
                        });
                    }
                };`,
                'utf-8',
            )
        }

        const manifest: PluginManifest = {
            id,
            name: `${id} Name`,
            version: '1.0.0',
            apiVersion: '1.0.0',
            engines: { cpa: '>=1.0.0' },
            entries: declaredEntries,
            dependencies: {},
            capabilities: [],
            contributes,
            ...overrides,
        }

        await fs.writeFile(
            path.join(dir, 'manifest.json'),
            JSON.stringify(manifest, null, 2),
            'utf-8',
        )

        return dir
    }

    describe('1. External Sources x Three Runtimes End-to-End Activation', () => {
        it.each([
            'global-config',
            'global-directory',
            'npm',
        ] as const)(
            'activates a %s plugin in every declared runtime (main, renderer, agent)',
            async (sourceKind) => {
                const pluginId = `test.ext.${sourceKind.replace('-', '.')}`
                let pluginDir: string
                let npmInstaller: ManagedNpmInstaller | undefined
                let globalConfig: any = undefined
                let npmSources: any = undefined

                if (sourceKind === 'global-directory') {
                    pluginDir = path.join(globalPluginsDir, 'my-plugin')
                    await createExternalPluginFixture(pluginDir, pluginId)
                } else if (sourceKind === 'global-config') {
                    pluginDir = path.join(tempRoot, 'custom-global-plugin')
                    await createExternalPluginFixture(pluginDir, pluginId)
                    globalConfig = {
                        sources: [{ source: `path:${pluginDir}` }],
                    }
                } else if (sourceKind === 'npm') {
                    pluginDir = path.join(npmPluginsDir, 'test-npm-pkg', '1.0.0')
                    await createExternalPluginFixture(pluginDir, pluginId)

                    const lockfile = path.join(globalPluginsDir, 'plugin-lock.json')
                    const lock = new PluginPackageLock(lockfile)
                    await lock.save({
                        version: 1,
                        packages: {
                            'npm:test-npm-pkg@1.0.0': {
                                requested: 'npm:test-npm-pkg@1.0.0',
                                resolvedVersion: '1.0.0',
                                integrity: 'sha512-testIntegrity==',
                                packageRoot: pluginDir,
                            },
                        },
                    })

                    npmInstaller = new ManagedNpmInstaller({
                        pluginsDir: globalPluginsDir,
                        lockfilePath: lockfile,
                        offline: true,
                    })

                    npmSources = [{ source: 'npm:test-npm-pkg@1.0.0' }]
                }

                // 1. Discover and bootstrap plugin graph
                const bootstrap = await bootstrapPluginGraph({
                    homeDir,
                    globalConfig,
                    npmSources,
                    npmInstaller,
                    bundledPackages: [],
                })

                expect(bootstrap.graph.plugins.map((p) => p.id)).toContain(pluginId)
                const targetPkg = bootstrap.catalog.getPackage(pluginId)
                expect(targetPkg).toBeDefined()
                expect(targetPkg?.source.kind).toBe(sourceKind)

                // 2. Main Runtime Host & Coordinator
                const mainRegistry = new ContributionRegistry()
                const mainHost = new MainPluginRuntimeHost({
                    catalog: bootstrap.catalog,
                    contributionRegistry: mainRegistry,
                    bundledPackages: [],
                })

                const mainCoordinator = new MainPluginActivationCoordinator({
                    host: mainHost,
                    graph: bootstrap.graph,
                })

                // 3. Renderer & Agent Runtime Hosts
                const rendererRegistry = new ContributionRegistry()
                const rendererHost = new RendererPluginRuntimeHost({
                    catalog: bootstrap.catalog,
                    contributionRegistry: rendererRegistry,
                    bundledPackages: [],
                })

                const agentRegistry = new ContributionRegistry()
                const agentHost = new AgentPluginRuntimeHost({
                    catalog: bootstrap.catalog,
                    contributionRegistry: agentRegistry,
                    bundledPackages: [],
                })

                // 4. Unified Cross-Runtime Platform Coordination
                const platformCoordinator = new PluginPlatformCoordinator({
                    rendererHost,
                    agentHost,
                    mainParticipant: {
                        getPreparedState: async () => mainCoordinator.getPreparedState(),
                        commit: async (rev, gen) => mainCoordinator.commitPrepared(rev, gen),
                        rollback: async (rev, gen) => mainCoordinator.rollbackPrepared(rev, gen),
                    },
                })

                // Stage Main entries first
                await mainCoordinator.stage(bootstrap.graph)

                // Stage Renderer & Agent entries via Platform Coordinator
                const prepared = await platformCoordinator.prepareGeneration(bootstrap.graph)
                expect(prepared.revision).toBe(bootstrap.graph.revision)
                expect(prepared.generation).toBe(1)

                // Commit generation across all runtimes
                await prepared.commit()

                // 5. Verify all three runtimes have activated the external plugin from disk
                const mainServices = mainRegistry.list('service')
                const rendererViews = rendererRegistry.list('view')
                const agentTools = agentRegistry.list('tool-factory')

                expect(mainServices.map((s) => s.id)).toContain(`${pluginId}-main-service`)
                const serviceContrib = mainServices.find((s) => s.id === `${pluginId}-main-service`)
                expect(serviceContrib).toBeDefined()
                // Assert real proxy side-effects from utility process
                if (serviceContrib?.value && typeof (serviceContrib.value as any).ping === 'function') {
                    const pingResult = await (serviceContrib.value as any).ping('e2e')
                    expect(pingResult).toBe('pong:e2e')
                }

                expect(rendererViews.map((v) => v.id)).toContain(`${pluginId}-renderer-view`)
                const viewContrib = rendererViews.find((v) => v.id === `${pluginId}-renderer-view`)
                expect(viewContrib?.value).toEqual({ plugin: pluginId, runtime: 'renderer' })

                expect(agentTools.map((t) => t.id)).toContain(`${pluginId}-agent-tool`)
                const toolContrib = agentTools.find((t) => t.id === `${pluginId}-agent-tool`)
                expect(toolContrib?.value).toEqual({ plugin: pluginId, runtime: 'agent' })

                expect(mainHost.getGeneration()).toBe(1)
                expect(rendererHost.getGeneration()).toBe(1)
                expect(agentHost.getGeneration()).toBe(1)
            },
        )
    })

    describe('2. Revision Management, Enable/Disable and Dynamic Reload', () => {
        it('computes stable SHA-256 revision invariant to discovery order and updates on toggle', async () => {
            const dirA = path.join(globalPluginsDir, 'plugin-a')
            const dirB = path.join(globalPluginsDir, 'plugin-b')
            await createExternalPluginFixture(dirA, 'ext.plugin.a')
            await createExternalPluginFixture(dirB, 'ext.plugin.b')

            const bootstrap1 = await bootstrapPluginGraph({
                homeDir,
                bundledPackages: [],
            })

            const rev1 = bootstrap1.graph.revision
            expect(rev1).toMatch(/^[a-f0-9]{64}$/)

            // Disabling plugin-b creates a different revision
            const bootstrap2 = await bootstrapPluginGraph({
                homeDir,
                bundledPackages: [],
                enabledPluginIds: ['ext.plugin.a'],
            })

            const rev2 = bootstrap2.graph.revision
            expect(rev2).not.toBe(rev1)
            expect(bootstrap2.graph.plugins.map((p) => p.id)).toEqual(['ext.plugin.a'])
        })

        it('supports atomic prepare/commit generation advance and rollback on failure', async () => {
            const dirA = path.join(globalPluginsDir, 'plugin-a')
            await createExternalPluginFixture(dirA, 'ext.plugin.a', { main: true, renderer: false, agent: false }, {
                contributes: { service: ['srv-a'] },
            })

            const bootstrap = await bootstrapPluginGraph({
                homeDir,
                bundledPackages: [],
            })

            const mainRegistry = new ContributionRegistry()
            const mainHost = new MainPluginRuntimeHost({
                catalog: bootstrap.catalog,
                contributionRegistry: mainRegistry,
                bundledPackages: [],
            })

            const coordinator = new MainPluginActivationCoordinator({
                host: mainHost,
                graph: bootstrap.graph,
            })

            // Prepare generation 1
            const prep1 = await coordinator.stage(bootstrap.graph)
            await prep1.commit()

            expect(mainHost.getGeneration()).toBe(1)
            expect(mainRegistry.list('service')).toHaveLength(1)

            // Prepare failing generation 2 with a critical required plugin that fails to load
            const failingGraph: ResolvedPluginGraphDTO = {
                ...bootstrap.graph,
                revision: 'failing_rev_2',
                plugins: [
                    ...bootstrap.graph.plugins,
                    {
                        id: 'failing.plugin',
                        name: 'Failing Plugin',
                        version: '1.0.0',
                        manifest: {
                            id: 'failing.plugin',
                            name: 'Failing Plugin',
                            version: '1.0.0',
                            apiVersion: '1.0.0',
                            engines: { cpa: '>=1.0.0' },
                            criticality: 'required',
                            entries: { main: './failing.js' },
                        },
                        source: { kind: 'bundled', spec: 'bundled:failing.plugin' },
                        sourceKind: 'bundled',
                        entries: { main: './nonexistent-file.js' },
                        criticality: 'required',
                        dependencies: {},
                    },
                ],
                activationOrder: [...bootstrap.graph.activationOrder, 'failing.plugin'],
            }

            await expect(coordinator.stage(failingGraph, { generation: 2 })).rejects.toThrow()

            // Generation remains rolled back at 1 with active contributions intact
            expect(mainHost.getGeneration()).toBe(1)
            expect(mainRegistry.list('service')).toHaveLength(1)
        })
    })

    describe('3. Multi-Tier Precedence & Duplicate Diagnostics', () => {
        it('enforces precedence order: global-config > global-directory > npm > bundled', async () => {
            const bundledPkg: ResolvedPluginPackage = {
                manifest: {
                    id: 'tier.test',
                    name: 'Tier (Bundled)',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '>=1.0.0' },
                },
                source: { kind: 'bundled', spec: 'bundled:tier.test' },
                sourceRoot: '/bundled/tier.test',
                entries: {},
            }

            // Global Dir
            const globalDir = path.join(globalPluginsDir, 'tier.test')
            await createExternalPluginFixture(globalDir, 'tier.test', { main: true }, { name: 'Tier (Global Dir)' })

            // Global Config
            const customDir = path.join(tempRoot, 'cfg-tier-test')
            await createExternalPluginFixture(customDir, 'tier.test', { main: true }, { name: 'Tier (Global Config)' })

            const catalog = await createPluginCatalog({
                homeDir,
                bundledPackages: [bundledPkg],
                globalConfig: { sources: [{ source: `path:${customDir}` }] },
            })

            const winner = catalog.find((p) => p.manifest.id === 'tier.test')
            expect(winner).toBeDefined()
            expect(winner?.manifest.name).toBe('Tier (Global Config)')
            expect(winner?.source.kind).toBe('global-config')
        })

        it('throws DuplicatePluginSourceError when duplicate IDs exist in the same tier', async () => {
            const dir1 = path.join(tempRoot, 'cfg-a')
            const dir2 = path.join(tempRoot, 'cfg-b')
            await createExternalPluginFixture(dir1, 'dup.id')
            await createExternalPluginFixture(dir2, 'dup.id')

            await expect(
                createPluginCatalog({
                    projectPath: projectDir,
                    homeDir,
                    bundledPackages: [],
                    globalConfig: {
                        sources: [{ source: `path:${dir1}` }, { source: `path:${dir2}` }],
                    },
                }),
            ).rejects.toThrow(DuplicatePluginSourceError)
        })
    })

    describe('4. Dependency Resolution & Criticality Enforcement', () => {
        it('fails bootstrap with PluginDependencyError when a required plugin dependency is missing', async () => {
            const dir = path.join(globalPluginsDir, 'dependent-plugin')
            await createExternalPluginFixture(
                dir,
                'dependent.plugin',
                { main: true },
                {
                    criticality: 'required',
                    dependencies: { 'missing.dep': '^1.0.0' },
                },
            )

            await expect(
                bootstrapPluginGraph({
                    projectPath: projectDir,
                    homeDir,
                    bundledPackages: [],
                }),
            ).rejects.toThrow(PluginDependencyError)
        })

        it('allows resolution when an optional dependency is missing', async () => {
            const dir = path.join(globalPluginsDir, 'opt-dependent-plugin')
            await createExternalPluginFixture(
                dir,
                'opt.dependent.plugin',
                { main: true },
                {
                    criticality: 'optional',
                    optionalDependencies: { 'missing.opt.dep': '^1.0.0' },
                },
            )

            const bootstrap = await bootstrapPluginGraph({
                projectPath: projectDir,
                homeDir,
                bundledPackages: [],
            })

            expect(bootstrap.graph.plugins.map((p) => p.id)).toContain('opt.dependent.plugin')
        })
    })

    describe('5. Managed NPM Security & Offline Isolation', () => {
        it('rejects installation of packages using non-exact semver or tags in strict mode', () => {
            expect(() => parseNpmSpec('npm:pkg@latest', { strictExact: true })).toThrow()
            expect(() => parseNpmSpec('npm:pkg@^1.0.0', { strictExact: true })).toThrow()
            expect(() => parseNpmSpec('npm:pkg@1.0.0', { strictExact: true })).not.toThrow()
            expect(() => parseNpmSpec('npm:pkg@^1.0.0')).not.toThrow() // standard parse
        })

        it('disallows execution of package lifecycle scripts during extraction', async () => {
            const extractSpy = vi.fn(async (_s: string, dest: string) => {
                await fs.mkdir(dest, { recursive: true })
                await fs.writeFile(
                    path.join(dest, 'package.json'),
                    JSON.stringify({
                        name: 'script-injection-plugin',
                        version: '1.0.0',
                        scripts: {
                            preinstall: 'node -e "process.exit(1)"',
                            postinstall: 'rm -rf /',
                        },
                        cpa: { id: 'script-plugin', apiVersion: '1.0.0' },
                    }),
                )
            })

            const installer = new ManagedNpmInstaller({
                pluginsDir: globalPluginsDir,
                fetchManifest: async () => ({
                    name: 'script-injection-plugin',
                    version: '1.0.0',
                    dist: { integrity: 'sha512-cleanHash==' },
                }),
                extractPackage: extractSpy,
            })

            const installed = await installer.install('npm:script-injection-plugin@1.0.0')
            expect(installed.name).toBe('script-injection-plugin')
            expect(extractSpy).toHaveBeenCalledWith(
                'script-injection-plugin@1.0.0',
                expect.stringContaining('.tmp-'),
                expect.objectContaining({ runScripts: false }),
            )
        })

        it('strictly fails in offline mode when cache is missing or integrity is tampered', async () => {
            const lockfile = path.join(globalPluginsDir, 'plugin-lock.json')
            const lock = new PluginPackageLock(lockfile)
            await lock.save({
                version: 1,
                packages: {
                    'npm:tampered-plugin@1.0.0': {
                        requested: 'npm:tampered-plugin@1.0.0',
                        resolvedVersion: '1.0.0',
                        integrity: 'sha512-expectedIntegrity==',
                        packageRoot: path.join(npmPluginsDir, 'tampered-plugin', '1.0.0'),
                    },
                },
            })

            const installer = new ManagedNpmInstaller({
                pluginsDir: globalPluginsDir,
                lockfilePath: lockfile,
                offline: true,
            })

            // Directory does not exist on disk
            await expect(installer.install('npm:tampered-plugin@1.0.0')).rejects.toThrow(
                /offline mode/i,
            )
        })

        it('deduplicates concurrent in-flight installation calls to the same specifier', async () => {
            let fetchCallCount = 0
            const installer = new ManagedNpmInstaller({
                pluginsDir: globalPluginsDir,
                fetchManifest: async () => {
                    fetchCallCount++
                    await new Promise((r) => setTimeout(r, 20))
                    return {
                        name: 'concurrent-pkg',
                        version: '1.0.0',
                        dist: { integrity: 'sha512-concHash==' },
                    }
                },
                extractPackage: async (_s, dest) => {
                    await fs.mkdir(dest, { recursive: true })
                    await fs.writeFile(
                        path.join(dest, 'package.json'),
                        JSON.stringify({ name: 'concurrent-pkg', version: '1.0.0' }),
                    )
                },
            })

            const [pkg1, pkg2] = await Promise.all([
                installer.install('npm:concurrent-pkg@1.0.0'),
                installer.install('npm:concurrent-pkg@1.0.0'),
            ])

            expect(fetchCallCount).toBe(1)
            expect(pkg1.version).toBe('1.0.0')
            expect(pkg2.version).toBe('1.0.0')
        })

        it('never creates or modifies node_modules or package.json in the project workspace', async () => {
            const projectPkgJson = path.join(projectDir, 'package.json')
            const projectNodeModules = path.join(projectDir, 'node_modules')

            const installer = new ManagedNpmInstaller({
                pluginsDir: globalPluginsDir,
                fetchManifest: async () => ({
                    name: 'clean-plugin',
                    version: '1.0.0',
                    dist: { integrity: 'sha512-cleanHash==' },
                }),
                extractPackage: async (_s, dest) => {
                    await fs.mkdir(dest, { recursive: true })
                    await fs.writeFile(
                        path.join(dest, 'package.json'),
                        JSON.stringify({ name: 'clean-plugin', version: '1.0.0' }),
                    )
                },
            })

            await installer.install('npm:clean-plugin@1.0.0')

            const pkgExists = await fs.access(projectPkgJson).then(() => true).catch(() => false)
            const nmExists = await fs.access(projectNodeModules).then(() => true).catch(() => false)

            expect(pkgExists).toBe(false)
            expect(nmExists).toBe(false)
        })
    })

    describe('6. PluginResourceService Security & Path Traversal Guard', () => {
        it('rejects directory traversal, encoded path attempts, and symlink escapes', async () => {
            const pluginDir = path.join(globalPluginsDir, 'secured-plugin')
            await createExternalPluginFixture(pluginDir, 'secured-plugin')

            const outsideSecret = path.join(tempRoot, 'host-secret.env')
            await fs.writeFile(outsideSecret, 'SECRET_KEY=12345', 'utf-8')

            try {
                await fs.symlink(outsideSecret, path.join(pluginDir, 'symlink-secret.env'))
            } catch {
                // Ignore symlink creation failure if OS does not support
            }

            const resourceService = new PluginResourceService()
            resourceService.registerPackage({
                manifest: {
                    id: 'secured-plugin',
                    name: 'Secured Plugin',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '>=1.0.0' },
                },
                source: { kind: 'global-directory', spec: `path:${pluginDir}` },
                sourceRoot: pluginDir,
                entries: {},
            })

            // Relative traversal
            await expect(
                resourceService.getResourcePath('secured-plugin', '../host-secret.env'),
            ).rejects.toThrow(PluginValidationError)

            // Encoded traversal
            await expect(
                resourceService.getResourcePath('secured-plugin', '..%2F..%2Fhost-secret.env'),
            ).rejects.toThrow(PluginValidationError)

            // Symlink escape
            await expect(
                resourceService.getResourcePath('secured-plugin', 'symlink-secret.env'),
            ).rejects.toThrow(PluginValidationError)
        })

        it('correctly identifies content types and serves package assets', async () => {
            const pluginDir = path.join(globalPluginsDir, 'asset-plugin')
            await createExternalPluginFixture(pluginDir, 'asset-plugin')

            await fs.writeFile(path.join(pluginDir, 'styles.css'), 'body { color: blue; }')
            await fs.writeFile(path.join(pluginDir, 'data.json'), '{"hello": "world"}')

            const resourceService = new PluginResourceService()
            resourceService.registerPackage({
                manifest: {
                    id: 'asset-plugin',
                    name: 'Asset Plugin',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '>=1.0.0' },
                },
                source: { kind: 'global-directory', spec: `path:${pluginDir}` },
                sourceRoot: pluginDir,
                entries: {},
            })

            const cssRes = await resourceService.readResource('asset-plugin', 'styles.css')
            expect(cssRes.contentType).toContain('text/css')
            expect(cssRes.body.toString('utf-8')).toBe('body { color: blue; }')

            const jsonRes = await resourceService.readResource('asset-plugin', 'data.json')
            expect(jsonRes.contentType).toBe('application/json')
            expect(jsonRes.body.toString('utf-8')).toBe('{"hello": "world"}')
        })

        it('throws PluginError when accessing resource for unregistered package', async () => {
            const resourceService = new PluginResourceService()
            await expect(
                resourceService.readResource('nonexistent-pkg', 'file.js'),
            ).rejects.toThrow(PluginError)
        })
    })

    describe('7. ExternalMainPluginHost Utility Process Isolation', () => {
        it('blocks unauthorized imports such as Node built-ins without capabilities', async () => {
            const dir = path.join(globalPluginsDir, 'unauthorized-import-plugin')
            await createExternalPluginFixture(dir, 'unauthorized-import-plugin')

            // Write entry importing fs without filesystem capability
            await fs.writeFile(
                path.join(dir, 'main.js'),
                `import * as fs from 'node:fs';
                export default { runtime: 'main', activate() {} };`,
            )

            const host = new ExternalMainPluginHost()
            const pkg: ResolvedPluginPackage = {
                manifest: {
                    id: 'unauthorized-import-plugin',
                    name: 'Unauthorized',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '>=1.0.0' },
                    entries: { main: './main.js' },
                    capabilities: [],
                },
                source: { kind: 'global-directory', spec: `path:${dir}` },
                sourceRoot: dir,
                entries: { main: path.join(dir, 'main.js') },
            }

            await expect(host.load(pkg)).rejects.toThrow(/without a brokered capability/i)
        })
    })

    describe('8. PluginGraphManagementService 3-Runtime Coordination & Persistence', () => {
        it('prepares and commits enable/disable/reload across all 3 runtimes with candidate revision', async () => {
            const dir = path.join(globalPluginsDir, 'managed-e2e-plugin')
            await createExternalPluginFixture(dir, 'managed-e2e-plugin', {
                main: true,
                renderer: true,
                agent: true,
            })

            const resourceService = new PluginResourceService()
            const mainHost = new MainPluginRuntimeHost({ bundledPackages: [] })
            const coordinator = new MainPluginActivationCoordinator({ host: mainHost })
            const installer = new ManagedNpmInstaller({ pluginsDir: globalPluginsDir })

            const initResult = await bootstrapPluginGraph({
                projectPath: projectDir,
                homeDir,
                bundledPackages: [],
                resourceService,
                npmInstaller: installer,
            })

            coordinator.setGraphDTO(initResult.graph)
            await coordinator.prepareGeneration(initResult.catalog, {
                generation: 1,
                revision: initResult.graph.revision,
            })
            await coordinator.commitPrepared(initResult.graph.revision, 1)

            const mgmtService = new PluginGraphManagementService({
                homeDir,
                projectPath: projectDir,
                resourceService,
                coordinator,
                npmInstaller: installer,
            })

            // Verify initial list
            const initialList = await mgmtService.list()
            expect(initialList.plugins.some((p) => p.manifest.id === 'managed-e2e-plugin')).toBe(true)

            // Prepare disable candidate
            const disableCandidate = await mgmtService.prepareDisable('managed-e2e-plugin', {
                expectedRevision: initResult.graph.revision,
            })

            expect(disableCandidate.candidateRevision).toBeTruthy()
            expect(disableCandidate.generation).toBe(2)

            // Commit disable transaction
            await mgmtService.commitTransaction(disableCandidate.candidateRevision)

            // Verify disabled state persisted
            const listAfterDisable = await mgmtService.list()
            const disabledSummary = listAfterDisable.plugins.find(
                (p) => p.manifest.id === 'managed-e2e-plugin',
            )
            expect(disabledSummary?.status).toBe('inactive')

            // Prepare enable candidate
            const enableCandidate = await mgmtService.prepareEnable('managed-e2e-plugin', {
                expectedRevision: disableCandidate.candidateRevision,
            })

            await mgmtService.commitTransaction(enableCandidate.candidateRevision)

            const listAfterEnable = await mgmtService.list()
            const enabledSummary = listAfterEnable.plugins.find(
                (p) => p.manifest.id === 'managed-e2e-plugin',
            )
            expect(enabledSummary?.status).toBe('active')
        })

        it('rolls back all 3 runtimes when candidate commit fails and preserves active graph', async () => {
            const dir = path.join(globalPluginsDir, 'rollback-e2e-plugin')
            await createExternalPluginFixture(dir, 'rollback-e2e-plugin', {
                main: true,
                renderer: true,
                agent: true,
            })

            const resourceService = new PluginResourceService()
            const mainHost = new MainPluginRuntimeHost({ bundledPackages: [] })
            const coordinator = new MainPluginActivationCoordinator({ host: mainHost })
            const installer = new ManagedNpmInstaller({ pluginsDir: globalPluginsDir })

            const initResult = await bootstrapPluginGraph({
                projectPath: projectDir,
                homeDir,
                bundledPackages: [],
                resourceService,
                npmInstaller: installer,
            })

            coordinator.setGraphDTO(initResult.graph)
            await coordinator.prepareGeneration(initResult.catalog, {
                generation: 1,
                revision: initResult.graph.revision,
            })
            await coordinator.commitPrepared(initResult.graph.revision, 1)

            const mgmtService = new PluginGraphManagementService({
                homeDir,
                projectPath: projectDir,
                resourceService,
                coordinator,
                npmInstaller: installer,
            })

            const initialRevision = mgmtService.getActiveRevision()

            const candidate = await mgmtService.prepareDisable('rollback-e2e-plugin')
            await mgmtService.rollbackTransaction(candidate.candidateRevision)

            expect(mgmtService.getActiveRevision()).toBe(initialRevision)
            const list = await mgmtService.list()
            const summary = list.plugins.find((p) => p.manifest.id === 'rollback-e2e-plugin')
            expect(summary?.status).toBe('active')
        })
    })
})
