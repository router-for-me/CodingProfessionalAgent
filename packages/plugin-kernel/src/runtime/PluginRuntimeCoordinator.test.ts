import { describe, expect, it } from 'vitest'
import type {
    PluginEntryDefinition,
    PluginEntryKind,
    PluginManifest,
    ResolvedPluginGraphDTO,
    ResolvedPluginPackage,
} from '@cpa/plugin-api'
import { PluginCatalog } from '../catalog/PluginCatalog.js'
import { ContributionRegistry } from '../registry/ContributionRegistry.js'
import { PluginEventBus } from '../events/PluginEventBus.js'
import { PluginRuntime, type PluginModuleLoader } from './PluginRuntime.js'
import {
    PluginRuntimeCoordinator,
    type PreparedPluginGeneration,
} from './PluginRuntimeCoordinator.js'

class MemoryModuleLoader implements PluginModuleLoader {
    private readonly modules = new Map<string, PluginEntryDefinition>()
    private readonly failPluginIds = new Set<string>()

    setModule(id: string, module: PluginEntryDefinition): void {
        this.modules.set(id, module)
    }

    setFailing(id: string): void {
        this.failPluginIds.add(id)
    }

    async load(
        pluginPackage: ResolvedPluginPackage,
        _runtime: PluginEntryKind,
    ): Promise<PluginEntryDefinition | undefined> {
        const id = pluginPackage.manifest.id
        if (this.failPluginIds.has(id)) {
            throw new Error(`Load failure for ${id}`)
        }
        return this.modules.get(id)
    }
}

function createAuthoritativePkg(
    id: string,
    options?: {
        criticality?: 'platform' | 'required' | 'optional'
        contributes?: Record<string, string[]>
        dependencies?: Record<string, string>
    },
): ResolvedPluginPackage {
    const manifest: PluginManifest = {
        id,
        name: id,
        version: '1.0.0',
        apiVersion: '1.0.0',
        engines: { cpa: '>=1.0.0' },
        criticality: options?.criticality ?? 'required',
        entries: {
            main: './main.js',
            renderer: './renderer.js',
            agent: './agent.js',
        },
        dependencies: options?.dependencies ?? {},
        capabilities: [],
        contributes: options?.contributes ?? {},
    }

    return {
        manifest,
        source: { kind: 'bundled', spec: `bundled:${id}` },
        sourceRoot: `/plugins/${id}`,
        entries: manifest.entries,
    }
}

function createTestGraph(packages: readonly ResolvedPluginPackage[]): ResolvedPluginGraphDTO {
    return {
        revision: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        createdAt: Date.now(),
        plugins: packages.map((pkg) => ({
            id: pkg.manifest.id,
            name: pkg.manifest.name,
            version: pkg.manifest.version,
            manifest: pkg.manifest,
            source: pkg.source,
            sourceKind: pkg.source.kind,
            entries: pkg.entries,
            criticality: pkg.manifest.criticality ?? 'required',
            dependencies: pkg.manifest.dependencies ?? {},
        })),
        activationOrder: packages.map((p) => p.manifest.id),
    }
}

interface TestCoordinatorSetup {
    coordinator: PluginRuntimeCoordinator
    mainRuntime: PluginRuntime
    rendererRuntime: PluginRuntime
    agentRuntime: PluginRuntime
    mainRegistry: ContributionRegistry
    rendererRegistry: ContributionRegistry
    agentRegistry: ContributionRegistry
    mainLoader: MemoryModuleLoader
    rendererLoader: MemoryModuleLoader
    agentLoader: MemoryModuleLoader
    allContributionCounts: () => [number, number, number]
}

function createTestCoordinator(options?: {
    packages?: readonly ResolvedPluginPackage[]
    failRuntime?: 'main' | 'renderer' | 'agent'
    failPluginId?: string
}): TestCoordinatorSetup {
    const packages = options?.packages ?? [
        createAuthoritativePkg('cpa.core.test', {
            contributes: {
                service: ['main-svc'],
                action: ['renderer-act'],
                'tool-factory': ['agent-tool'],
            },
        }),
    ]

    const enabledPluginIds = packages.map((p) => p.manifest.id)

    const mainCatalog = new PluginCatalog({ cpaVersion: '1.0.0', packages, enabledPluginIds })
    const rendererCatalog = new PluginCatalog({ cpaVersion: '1.0.0', packages, enabledPluginIds })
    const agentCatalog = new PluginCatalog({ cpaVersion: '1.0.0', packages, enabledPluginIds })

    const mainRegistry = new ContributionRegistry()
    const rendererRegistry = new ContributionRegistry()
    const agentRegistry = new ContributionRegistry()

    const mainLoader = new MemoryModuleLoader()
    const rendererLoader = new MemoryModuleLoader()
    const agentLoader = new MemoryModuleLoader()

    for (const pkg of packages) {
        const id = pkg.manifest.id

        mainLoader.setModule(id, {
            runtime: 'main',
            activate(ctx) {
                if (options?.failRuntime === 'main' && (!options.failPluginId || options.failPluginId === id)) {
                    throw new Error('main activation failed')
                }
                if (pkg.manifest.contributes?.service?.includes('main-svc')) {
                    ctx.register({ kind: 'service', id: 'main-svc', value: { type: 'main-service' } })
                }
            },
        })

        rendererLoader.setModule(id, {
            runtime: 'renderer',
            activate(ctx) {
                if (options?.failRuntime === 'renderer' && (!options.failPluginId || options.failPluginId === id)) {
                    throw new Error('renderer activation failed')
                }
                if (pkg.manifest.contributes?.action?.includes('renderer-act')) {
                    ctx.register({ kind: 'action', id: 'renderer-act', value: { type: 'renderer-action' } })
                }
            },
        })

        agentLoader.setModule(id, {
            runtime: 'agent',
            activate(ctx) {
                if (options?.failRuntime === 'agent' && (!options.failPluginId || options.failPluginId === id)) {
                    throw new Error('agent activation failed')
                }
                if (pkg.manifest.contributes?.['tool-factory']?.includes('agent-tool')) {
                    ctx.register({ kind: 'tool-factory', id: 'agent-tool', value: { type: 'agent-tool' } })
                }
            },
        })
    }

    const mainRuntime = new PluginRuntime({
        catalog: mainCatalog,
        registry: mainRegistry,
        loader: mainLoader,
        entryKind: 'main',
    })

    const rendererRuntime = new PluginRuntime({
        catalog: rendererCatalog,
        registry: rendererRegistry,
        loader: rendererLoader,
        entryKind: 'renderer',
    })

    const agentRuntime = new PluginRuntime({
        catalog: agentCatalog,
        registry: agentRegistry,
        loader: agentLoader,
        entryKind: 'agent',
    })

    const coordinator = new PluginRuntimeCoordinator({
        runtimes: {
            main: mainRuntime,
            renderer: rendererRuntime,
            agent: agentRuntime,
        },
    })

    const allContributionCounts = (): [number, number, number] => [
        mainRegistry.list('service').length,
        rendererRegistry.list('action').length,
        agentRegistry.list('tool-factory').length,
    ]

    return {
        coordinator,
        mainRuntime,
        rendererRuntime,
        agentRuntime,
        mainRegistry,
        rendererRegistry,
        agentRegistry,
        mainLoader,
        rendererLoader,
        agentLoader,
        allContributionCounts,
    }
}

describe('PluginRuntimeCoordinator', () => {
    it('rolls back all staged runtimes when a required agent entry fails', async () => {
        const setup = createTestCoordinator({ failRuntime: 'agent' })
        const graph = createTestGraph(setup.mainRuntime.catalog.getPackages())

        await expect(setup.coordinator.activate(graph)).rejects.toThrow('agent activation failed')
        expect(setup.allContributionCounts()).toEqual([0, 0, 0])
        expect(setup.mainRuntime.getGeneration()).toBe(0)
        expect(setup.rendererRuntime.getGeneration()).toBe(0)
        expect(setup.agentRuntime.getGeneration()).toBe(0)
    })

    it('staging does not expose staged contributions to active registry before commit', async () => {
        const setup = createTestCoordinator()
        const graph = createTestGraph(setup.mainRuntime.catalog.getPackages())

        const prepared: PreparedPluginGeneration = await setup.coordinator.prepareGeneration(graph)

        // Staged contributions must NOT be visible in active registries before commit
        expect(setup.allContributionCounts()).toEqual([0, 0, 0])
        expect(setup.mainRuntime.getGeneration()).toBe(0)
        expect(setup.rendererRuntime.getGeneration()).toBe(0)
        expect(setup.agentRuntime.getGeneration()).toBe(0)
        expect(prepared.revision).toBe(graph.revision)
        expect(prepared.generation).toBe(1)

        // After commit, contributions become active across all runtimes
        await prepared.commit()
        expect(setup.allContributionCounts()).toEqual([1, 1, 1])
        expect(setup.mainRuntime.getGeneration()).toBe(1)
        expect(setup.rendererRuntime.getGeneration()).toBe(1)
        expect(setup.agentRuntime.getGeneration()).toBe(1)
    })

    it('rolls back completely when rollback() is invoked on prepared generation', async () => {
        const setup = createTestCoordinator()
        const graph = createTestGraph(setup.mainRuntime.catalog.getPackages())

        const prepared = await setup.coordinator.prepareGeneration(graph)
        expect(setup.allContributionCounts()).toEqual([0, 0, 0])

        await prepared.rollback()
        expect(setup.allContributionCounts()).toEqual([0, 0, 0])
        expect(setup.mainRuntime.getGeneration()).toBe(0)
        expect(setup.rendererRuntime.getGeneration()).toBe(0)
        expect(setup.agentRuntime.getGeneration()).toBe(0)
    })

    it('optional entry failure records diagnostics without rolling back required entries', async () => {
        const pkgRequired = createAuthoritativePkg('cpa.core.required', {
            criticality: 'required',
            contributes: {
                service: ['main-svc'],
                action: ['renderer-act'],
                'tool-factory': ['agent-tool'],
            },
        })
        const pkgOptional = createAuthoritativePkg('cpa.core.optional', {
            criticality: 'optional',
            contributes: {
                service: ['opt-svc'],
            },
        })

        const setup = createTestCoordinator({
            packages: [pkgRequired, pkgOptional],
            failRuntime: 'main',
            failPluginId: 'cpa.core.optional',
        })

        const graph = createTestGraph([pkgRequired, pkgOptional])
        const prepared = await setup.coordinator.prepareGeneration(graph)
        await prepared.commit()

        // Required contributions succeeded across runtimes
        expect(setup.mainRegistry.list('service').length).toBe(1)
        expect(setup.mainRegistry.get('service', 'main-svc')).toEqual({ type: 'main-service' })
        expect(setup.rendererRegistry.list('action').length).toBe(1)
        expect(setup.agentRegistry.list('tool-factory').length).toBe(1)

        // Optional plugin summary reflects error in main runtime
        const summary = setup.mainRuntime.getPluginSummary('cpa.core.optional')
        expect(summary.status).toBe('error')
    })

    it('extracts valid revision and falls back safely on null, undefined, or empty string', async () => {
        const setup = createTestCoordinator()
        const packages = setup.mainRuntime.catalog.getPackages()

        // 1. null revision
        const prepNull = await setup.coordinator.prepareGeneration({
            revision: null as any,
            createdAt: Date.now(),
            plugins: [],
            activationOrder: [],
        })
        expect(prepNull.revision).not.toBe('null')
        expect(prepNull.revision.startsWith('rev-')).toBe(true)

        // 2. undefined revision
        const prepUndef = await setup.coordinator.prepareGeneration({
            revision: undefined as any,
            createdAt: Date.now(),
            plugins: [],
            activationOrder: [],
        })
        expect(prepUndef.revision).not.toBe('undefined')
        expect(prepUndef.revision.startsWith('rev-')).toBe(true)

        // 3. empty string revision
        const prepEmpty = await setup.coordinator.prepareGeneration({
            revision: '   ',
            createdAt: Date.now(),
            plugins: [],
            activationOrder: [],
        })
        expect(prepEmpty.revision).not.toBe('')
        expect(prepEmpty.revision).not.toBe('   ')
        expect(prepEmpty.revision.startsWith('rev-')).toBe(true)

        // 4. valid revision
        const prepValid = await setup.coordinator.prepareGeneration({
            revision: 'valid-rev-123',
            createdAt: Date.now(),
            plugins: [],
            activationOrder: [],
        })
        expect(prepValid.revision).toBe('valid-rev-123')
    })

    it('coordinates atomic replacement from Generation 1 to Generation 2 across all runtimes', async () => {
        const setup = createTestCoordinator()
        const graph1 = createTestGraph(setup.mainRuntime.catalog.getPackages())

        // Activate Generation 1
        await setup.coordinator.activate(graph1)
        expect(setup.coordinator.getGeneration()).toBe(1)
        expect(setup.allContributionCounts()).toEqual([1, 1, 1])

        // Prepare Generation 2 with new graph revision
        const graph2: ResolvedPluginGraphDTO = {
            ...graph1,
            revision: 'generation-2-revision-abcdef',
        }

        const prepared2 = await setup.coordinator.prepareGeneration(graph2, { generation: 2 })
        expect(prepared2.generation).toBe(2)
        expect(prepared2.revision).toBe('generation-2-revision-abcdef')

        // Generation 1 is still active
        expect(setup.coordinator.getGeneration()).toBe(1)
        expect(setup.allContributionCounts()).toEqual([1, 1, 1])

        // Commit Generation 2
        await prepared2.commit()
        expect(setup.coordinator.getGeneration()).toBe(2)
        expect(setup.coordinator.getRevision()).toBe('generation-2-revision-abcdef')
        expect(setup.allContributionCounts()).toEqual([1, 1, 1])
    })

    it('ensures multi-runtime prepare failure leaves no staged listeners or queued emits in any runtime', async () => {
        const pkgA = createAuthoritativePkg('cpa.core.alpha', {
            contributes: { service: ['alpha-svc'] },
        })
        const pkgB = createAuthoritativePkg('cpa.core.beta', {
            contributes: { service: ['beta-svc'] },
        })

        const mainEventBus = new PluginEventBus()
        const rendererEventBus = new PluginEventBus()
        const agentEventBus = new PluginEventBus()

        const catalog = new PluginCatalog({
            cpaVersion: '1.0.0',
            packages: [pkgA, pkgB],
            enabledPluginIds: ['cpa.core.alpha', 'cpa.core.beta'],
        })

        const mainLoader = new MemoryModuleLoader()
        const rendererLoader = new MemoryModuleLoader()
        const agentLoader = new MemoryModuleLoader()

        const mainReceived: string[] = []
        const rendererReceived: string[] = []

        // Main plugin subscribes and emits
        mainLoader.setModule('cpa.core.alpha', {
            manifest: pkgA.manifest,
            activate(ctx) {
                ctx.events.on<string>('main:topic', (msg) => {
                    mainReceived.push(msg)
                })
                void ctx.events.emit('main:leak', 'leak-attempt')
            },
        })

        // Renderer plugin subscribes
        rendererLoader.setModule('cpa.core.alpha', {
            manifest: pkgA.manifest,
            activate(ctx) {
                ctx.events.on<string>('renderer:topic', (msg) => {
                    rendererReceived.push(msg)
                })
            },
        })

        // Agent runtime loader fails for required plugin pkgB
        agentLoader.setFailing('cpa.core.beta')

        const mainRuntime = new PluginRuntime({
            catalog,
            eventBus: mainEventBus,
            loader: mainLoader,
            entryKind: 'main',
        })
        const rendererRuntime = new PluginRuntime({
            catalog,
            eventBus: rendererEventBus,
            loader: rendererLoader,
            entryKind: 'renderer',
        })
        const agentRuntime = new PluginRuntime({
            catalog,
            eventBus: agentEventBus,
            loader: agentLoader,
            entryKind: 'agent',
        })

        const coordinator = new PluginRuntimeCoordinator({
            runtimes: {
                main: mainRuntime,
                renderer: rendererRuntime,
                agent: agentRuntime,
            },
        })

        const graph = createTestGraph([pkgA, pkgB])

        // Prepare should reject due to agent runtime failure
        await expect(coordinator.prepareGeneration(graph)).rejects.toThrow()

        // Verify no listeners leaked in any runtime's live event bus
        expect(mainEventBus.listenerCount('main:topic')).toBe(0)
        expect(rendererEventBus.listenerCount('renderer:topic')).toBe(0)

        // Verify no queued emits leaked or were executed
        let leakReceived = false
        mainEventBus.on('main:leak', () => {
            leakReceived = true
        })
        await mainEventBus.emit('main:topic', 'ping')
        await rendererEventBus.emit('renderer:topic', 'ping')

        expect(mainReceived).toEqual([])
        expect(rendererReceived).toEqual([])
        expect(leakReceived).toBe(false)
    })
})
