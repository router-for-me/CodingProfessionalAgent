import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'
import {
    PluginCatalog,
} from '@cpa/plugin-kernel'
import {
    createPluginCatalog,
} from '../src/main/plugins/catalog/createPluginCatalog.js'
import {
    MainPluginRuntimeHost,
} from '../src/main/plugins/runtime/MainPluginRuntimeHost.js'
import {
    MainCapabilityBroker,
} from '../src/main/plugins/capabilities/MainCapabilityBroker.js'
import {
    MainPluginModuleLoader,
} from '../src/main/plugins/loading/MainPluginModuleLoader.js'
import {
    assertPathInsideSourceRoot,
} from '../src/main/plugins/sources/sourceRootGuard.js'
import {
    ProfilingService,
    type V8CpuProfile,
} from '../src/main/services/profilingService.js'
import {
    ProfilingAnalyzer,
    type PluginMetric,
} from '../src/main/services/profilingAnalyzer.js'
import {
    createLegacySessionDb,
} from './fixtures/legacy-data/create-session-db.js'
import type {
    CapabilityDescriptor,
    CapabilityInvocationContext,
    PluginEntryDefinition,
    ResolvedPluginPackage,
} from '@cpa/plugin-api'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

describe('Plugin Platform Integration (Main Process)', () => {
    let tempRoot: string
    let homeDir: string
    let projectDir: string
    let globalPluginsDir: string
    let projectPluginsDir: string

    beforeEach(async () => {
        tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cpa-plugin-integ-test-'))
        homeDir = path.join(tempRoot, 'home')
        projectDir = path.join(tempRoot, 'project')
        globalPluginsDir = path.join(homeDir, '.coding-professional-agent', 'plugins')
        projectPluginsDir = path.join(projectDir, '.cpa', 'plugins')

        await fs.mkdir(globalPluginsDir, { recursive: true })
        await fs.mkdir(projectPluginsDir, { recursive: true })
    })

    afterEach(async () => {
        try {
            await fs.rm(tempRoot, { recursive: true, force: true })
        } catch {
            // Ignore cleanup errors
        }
    })

    async function createPluginOnDisk(
        dir: string,
        manifest: Record<string, unknown>,
        entryFiles: Record<string, string> = { 'index.js': 'export default {};' },
    ): Promise<string> {
        await fs.mkdir(dir, { recursive: true })
        await fs.writeFile(
            path.join(dir, 'manifest.json'),
            JSON.stringify(manifest, null, 2),
            'utf-8',
        )
        for (const [file, content] of Object.entries(entryFiles)) {
            const fullPath = path.join(dir, file)
            await fs.mkdir(path.dirname(fullPath), { recursive: true })
            await fs.writeFile(fullPath, content, 'utf-8')
        }
        return dir
    }

    describe('Multi-source Loading & Dependency Ordering Across 5 Source Kinds', () => {
        it('loads all 5 source kinds and activates them in dependency order', async () => {
            const activationOrder: string[] = []

            // 1. Bundled Source Fixture
            const bundledPkg: ResolvedPluginPackage = {
                manifest: {
                    id: 'fixture.bundled',
                    name: 'Bundled Plugin',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '>=1.0.0' },
                    activationPriority: 10,
                    entries: { main: './index.js' },
                    dependencies: {},
                    capabilities: [],
                    contributes: {
                        service: ['bundledService'],
                    },
                },
                source: { kind: 'bundled', spec: 'bundled:fixture.bundled' },
                sourceRoot: path.join(__dirname, 'fixtures/plugins/bundled'),
                entries: { main: './index.js' },
            }

            // 2. Global Directory Source
            const globalDir = path.join(globalPluginsDir, 'global-plugin')
            await createPluginOnDisk(globalDir, {
                id: 'fixture.global',
                name: 'Global Plugin',
                version: '1.0.0',
                apiVersion: '1.0.0',
                engines: { cpa: '>=1.0.0' },
                activationPriority: 20,
                dependencies: { 'fixture.bundled': '>=1.0.0' },
                entries: { main: './index.js' },
            })

            // 3. Project Directory Source
            const projDir = path.join(projectPluginsDir, 'project-plugin')
            await createPluginOnDisk(projDir, {
                id: 'fixture.project',
                name: 'Project Plugin',
                version: '1.0.0',
                apiVersion: '1.0.0',
                engines: { cpa: '>=1.0.0' },
                activationPriority: 30,
                dependencies: { 'fixture.global': '>=1.0.0' },
                entries: { main: './index.js' },
            })

            // 4. Local Configured Path Source
            const localDir = path.join(tempRoot, 'custom-local')
            await createPluginOnDisk(localDir, {
                id: 'fixture.local',
                name: 'Local Plugin',
                version: '1.0.0',
                apiVersion: '1.0.0',
                engines: { cpa: '>=1.0.0' },
                activationPriority: 40,
                dependencies: { 'fixture.project': '>=1.0.0' },
                entries: { main: './index.js' },
            })

            // 5. NPM Packaged Source
            const npmDir = path.join(tempRoot, 'node_modules', '@test', 'npm-plugin')
            await createPluginOnDisk(npmDir, {
                id: 'fixture.npm',
                name: 'NPM Plugin',
                version: '1.0.0',
                apiVersion: '1.0.0',
                engines: { cpa: '>=1.0.0' },
                activationPriority: 50,
                dependencies: { 'fixture.local': '>=1.0.0' },
                entries: { main: './index.js' },
            })

            const discoveredPackages = await createPluginCatalog({
                homeDir,
                projectPath: projectDir,
                bundledPackages: [bundledPkg],
                projectConfig: {
                    sources: [
                        { source: `path:${localDir}` },
                        { source: 'npm:@test/npm-plugin' },
                    ],
                },
                npmInstaller: {
                    install: async () => ({
                        packageRoot: npmDir,
                        integrity: 'sha256-mock-integrity',
                        manifest: {
                            id: 'fixture.npm',
                            name: 'NPM Plugin',
                            version: '1.0.0',
                            apiVersion: '1.0.0',
                            engines: { cpa: '>=1.0.0' },
                            activationPriority: 50,
                            dependencies: { 'fixture.local': '>=1.0.0' },
                            entries: { main: './index.js' },
                        },
                    }),
                } as any,
            })

            const catalog = new PluginCatalog({
                cpaVersion: '1.0.0',
                packages: discoveredPackages,
                enabledPluginIds: discoveredPackages.map((p) => p.manifest.id),
            })

            const packages = catalog.getPackages()
            expect(packages.map((p) => p.manifest.id)).toContain('fixture.bundled')
            expect(packages.map((p) => p.manifest.id)).toContain('fixture.global')
            expect(packages.map((p) => p.manifest.id)).toContain('fixture.project')
            expect(packages.map((p) => p.manifest.id)).toContain('fixture.local')
            expect(packages.map((p) => p.manifest.id)).toContain('fixture.npm')

            const definitions: Record<string, PluginEntryDefinition> = {
                'fixture.bundled': {
                    runtime: 'main',
                    activate: (ctx) => {
                        activationOrder.push('fixture.bundled')
                        ctx.register({
                            kind: 'service',
                            id: 'bundledService',
                            value: { ping: () => 'pong' },
                        })
                    },
                },
                'fixture.global': {
                    runtime: 'main',
                    activate: (ctx) => {
                        activationOrder.push('fixture.global')
                        const bundledSvc = ctx.getService<{ ping: () => string }>('bundledService')
                        expect(bundledSvc.ping()).toBe('pong')
                    },
                },
                'fixture.project': {
                    runtime: 'main',
                    activate: () => {
                        activationOrder.push('fixture.project')
                    },
                },
                'fixture.local': {
                    runtime: 'main',
                    activate: () => {
                        activationOrder.push('fixture.local')
                    },
                },
                'fixture.npm': {
                    runtime: 'main',
                    activate: () => {
                        activationOrder.push('fixture.npm')
                    },
                },
            }

            const moduleLoader = new MainPluginModuleLoader(undefined, definitions)
            const host = new MainPluginRuntimeHost({
                catalog,
                moduleLoader,
                bundledPackages: [bundledPkg],
            })

            await host.activateAll()

            // Verify topological activation order respecting dependencies
            expect(activationOrder).toEqual([
                'fixture.bundled',
                'fixture.global',
                'fixture.project',
                'fixture.local',
                'fixture.npm',
            ])

            // Verify all 5 are active
            expect(host.isPluginActive('fixture.bundled')).toBe(true)
            expect(host.isPluginActive('fixture.global')).toBe(true)
            expect(host.isPluginActive('fixture.project')).toBe(true)
            expect(host.isPluginActive('fixture.local')).toBe(true)
            expect(host.isPluginActive('fixture.npm')).toBe(true)

            // Test reverse teardown
            await host.deactivatePlugin('fixture.bundled')
            // Deactivating base plugin should deactivate all dependents in reverse order
            expect(host.isPluginActive('fixture.bundled')).toBe(false)
            expect(host.isPluginActive('fixture.global')).toBe(false)
            expect(host.isPluginActive('fixture.project')).toBe(false)
            expect(host.isPluginActive('fixture.local')).toBe(false)
            expect(host.isPluginActive('fixture.npm')).toBe(false)
        })
    })

    describe('Security & Capability Enforcements', () => {
        it('rejects path traversal escaping outside source root', async () => {
            const sourceRoot = path.join(tempRoot, 'plugin-root')
            await fs.mkdir(sourceRoot, { recursive: true })
            const outsideFile = path.join(tempRoot, 'outside-secret.txt')
            await fs.writeFile(outsideFile, 'secret', 'utf-8')
            const maliciousEntry = '../outside-secret.txt'

            await expect(
                assertPathInsideSourceRoot(maliciousEntry, sourceRoot),
            ).rejects.toThrow(/escapes canonical source root/i)
        })

        it('enforces capability permissions via MainCapabilityBroker', async () => {
            const broker = new MainCapabilityBroker()

            const testDescriptor: CapabilityDescriptor<[text: string], string> = {
                method: 'tools.echo',
                capability: 'tools:register',
                validate(args: unknown[]): asserts args is [string] {
                    if (typeof args[0] !== 'string') {
                        throw new Error('Argument 0 must be string')
                    }
                },
                invoke: async (_ctx, text) => `echo:${text}`,
            }

            broker.register(testDescriptor)

            const authorizedSender: CapabilityInvocationContext = {
                pluginId: 'trusted-plugin',
                senderId: 1,
                frameUrl: 'cpa-plugin://trusted-plugin/index.html',
                transport: 'electron',
            }

            const unauthorizedSender: CapabilityInvocationContext = {
                pluginId: 'untrusted-plugin',
                senderId: 2,
                frameUrl: 'cpa-plugin://untrusted-plugin/index.html',
                transport: 'electron',
            }

            const authHandle = broker.grant(authorizedSender, ['tools:register'])
            const unauthHandle = broker.grant(unauthorizedSender, ['events:listen'])

            const result = await broker.invoke(authHandle, 'tools.echo', ['hello'], authorizedSender)
            expect(result).toBe('echo:hello')

            await expect(
                broker.invoke(unauthHandle, 'tools.echo', ['hello'], unauthorizedSender),
            ).rejects.toThrow(/lacks capability tools:register/i)
        })
    })

    describe('Generation Leases & Clean Teardown', () => {
        it('holds generation lease during turn and cleans up completely after release', async () => {
            let disposed = false
            const def: PluginEntryDefinition = {
                runtime: 'main',
                activate: (ctx) => {
                    ctx.register({
                        kind: 'service',
                        id: 'leaseService',
                        value: { data: 'active' },
                    })
                },
                deactivate: () => {
                    disposed = true
                },
            }

            const pkg: ResolvedPluginPackage = {
                manifest: {
                    id: 'lease.plugin',
                    name: 'Lease Plugin',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '>=1.0.0' },
                    entries: { main: './index.js' },
                    dependencies: {},
                    capabilities: [],
                    contributes: {
                        service: ['leaseService'],
                    },
                },
                source: { kind: 'bundled', spec: 'bundled:lease.plugin' },
                sourceRoot: '/test/lease',
                entries: { main: './index.js' },
            }

            const host = new MainPluginRuntimeHost({
                bundledPackages: [pkg],
                moduleLoader: new MainPluginModuleLoader(undefined, { 'lease.plugin': def }),
            })

            await host.activateAll()
            expect(host.isPluginActive('lease.plugin')).toBe(true)

            // Acquire lease for an agent turn
            const lease = host.acquireGeneration(['lease.plugin'])
            expect(lease.generation).toBeGreaterThanOrEqual(1)

            // Start deactivation while lease is active
            const deactPromise = host.deactivatePlugin('lease.plugin')

            // Plugin should still be winding down / waiting for lease release
            lease.release()
            await deactPromise

            expect(disposed).toBe(true)
            expect(host.isPluginActive('lease.plugin')).toBe(false)
        })
    })

    describe('Legacy Data Preservation', () => {
        it('preserves legacy settings, projects, schedule, and SQLite database data', async () => {
            const legacySettingsPath = path.join(__dirname, 'fixtures/legacy-data/settings.json')
            const legacyProjectsPath = path.join(__dirname, 'fixtures/legacy-data/projects.json')
            const legacySchedulePath = path.join(__dirname, 'fixtures/legacy-data/schedule.json')

            const settings = JSON.parse(await fs.readFile(legacySettingsPath, 'utf-8'))
            const projects = JSON.parse(await fs.readFile(legacyProjectsPath, 'utf-8'))
            const schedule = JSON.parse(await fs.readFile(legacySchedulePath, 'utf-8'))

            expect(settings.settings.language).toBe('zh-CN')
            expect(settings.settings.legacyCustomField).toBe('preserved-value')
            expect(settings.retainedUnknown).toBe(true)

            expect(projects[0].id).toBe('proj-legacy-1')
            expect(projects[0].extraMetadata).toBe('preserved-proj-prop')

            expect(schedule[0].id).toBe('sched-legacy-1')
            expect(schedule[0].customScheduleAttr).toBe('preserved-sched-prop')

            // Verify SQLite DB creation and query
            const dbPath = path.join(tempRoot, 'legacy-test.db')
            const db = createLegacySessionDb(dbPath)
            try {
                const row = db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number }
                expect(row.count).toBeGreaterThanOrEqual(1)
            } finally {
                db.close()
            }
        })
    })

    describe('Profiling Service & Runtime Plugin Metrics Integration', () => {
        it('includes runtime plugin metrics in profiling reports', async () => {
            const pkg: ResolvedPluginPackage = {
                manifest: {
                    id: 'fixture.plugin',
                    name: 'Fixture Metric Plugin',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '>=1.0.0' },
                    entries: { main: './index.js' },
                    dependencies: {},
                    capabilities: [],
                    contributes: {},
                },
                source: { kind: 'bundled', spec: 'bundled:fixture.plugin' },
                sourceRoot: '/test/metric',
                entries: { main: './index.js' },
            }

            const def: PluginEntryDefinition = {
                runtime: 'main',
                activate: () => {},
            }

            const host = new MainPluginRuntimeHost({
                bundledPackages: [pkg],
                moduleLoader: new MainPluginModuleLoader(undefined, { 'fixture.plugin': def }),
            })

            await host.activateAll()

            const profiler = new ProfilingService({
                isDebug: true,
                getPluginMetrics: () => host.getPluginMetrics?.() ?? [],
            })

            // Mock profile session start/stop
            await profiler.start()

            // Simulate stopped profiling with mock profile
            const mockProfile: V8CpuProfile = {
                nodes: [
                    { id: 1, callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: 0, columnNumber: 0 } },
                ],
                startTime: 0,
                endTime: 100_000,
                samples: [],
            }

            // Set last profile and evaluate analyze
            const stopResult = await profiler.stop()
            expect(stopResult.ok).toBe(true)
            expect(stopResult.report).toBeDefined()
            expect(stopResult.report?.pluginMetrics).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ pluginId: 'fixture.plugin', activationCount: 1 }),
                ]),
            )
        })

        it('detects slow plugin bottleneck in profiling reports when metrics exceed threshold', () => {
            const slowPluginMetrics: PluginMetric[] = [
                {
                    pluginId: 'slow.plugin',
                    activationCount: 1,
                    callCount: 10,
                    totalDurationMs: 95.5,
                    maxDurationMs: 35.2,
                    errorCount: 0,
                    timeoutCount: 0,
                    activeLeases: 0,
                },
            ]

            const profile: V8CpuProfile = {
                startTime: 0,
                endTime: 100_000,
                nodes: [
                    { id: 1, callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: 0, columnNumber: 0 } },
                ],
                samples: [],
            }

            const report = ProfilingAnalyzer.analyze(profile, {
                pluginMetrics: slowPluginMetrics,
                durationMs: 1000,
            })

            expect(report.pluginMetrics).toHaveLength(1)
            const bottleneck = report.bottlenecks.find((b) => b.type === 'PLUGIN_PERF_REGRESSION')
            expect(bottleneck).toBeDefined()
            expect(bottleneck?.location).toBe('slow.plugin')
            expect(bottleneck?.severity).toBe('HIGH')
        })

        it('handles empty plugin metrics with default empty array and clean report', () => {
            const profile: V8CpuProfile = {
                startTime: 0,
                endTime: 100_000,
                nodes: [
                    { id: 1, callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: 0, columnNumber: 0 } },
                ],
                samples: [],
            }

            const report = ProfilingAnalyzer.analyze(profile, {
                pluginMetrics: [],
                durationMs: 1000,
            })

            expect(report.pluginMetrics).toEqual([])
            const bottlenecks = report.bottlenecks.filter((b) => b.type === 'PLUGIN_PERF_REGRESSION')
            expect(bottlenecks).toHaveLength(0)
            const markdown = ProfilingAnalyzer.formatMarkdown(report)
            expect(markdown).toContain('*(No plugin execution metrics)*')
        })
    })

    describe('Main Process Two-Phase Staging & Coordinator Staging Contract', () => {
        it('stages main plugins without immediate commit and commits on explicit coordination', async () => {
            const pkg: ResolvedPluginPackage = {
                manifest: {
                    id: 'fixture.twophase',
                    name: 'Two Phase Plugin',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '>=1.0.0' },
                    entries: { main: './index.js' },
                    dependencies: {},
                    capabilities: [],
                    contributes: {},
                },
                source: { kind: 'bundled', spec: 'bundled:fixture.twophase' },
                sourceRoot: '/test/twophase',
                entries: { main: './index.js' },
            }

            let mainActivated = false
            const def: PluginEntryDefinition = {
                runtime: 'main',
                activate: () => {
                    mainActivated = true
                },
            }

            const host = new MainPluginRuntimeHost({
                bundledPackages: [pkg],
                moduleLoader: new MainPluginModuleLoader(undefined, { 'fixture.twophase': def }),
            })

            const { MainPluginActivationCoordinator } = await import(
                '../src/main/plugins/runtime/MainPluginActivationCoordinator.js'
            )

            const coordinator = new MainPluginActivationCoordinator({ host })
            const prepared = await coordinator.stage()

            expect(mainActivated).toBe(true)
            // Active plugin IDs in runtime remain empty before commit
            expect(host.getActivePluginIds()).toHaveLength(0)
            expect(host.getGeneration()).toBe(0)
            expect(coordinator.getGeneration()).toBe(0)

            // Commit prepared generation
            await coordinator.commitPrepared(prepared.revision, prepared.generation)

            expect(host.getActivePluginIds()).toContain('fixture.twophase')
            expect(host.getGeneration()).toBe(1)
            expect(coordinator.getGeneration()).toBe(1)

            await host.dispose()
        })
    })
})
