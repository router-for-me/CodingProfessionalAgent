import { describe, expect, it, vi } from 'vitest'
import type {
    PluginCapabilityClient,
    PluginContext,
    PluginEntryDefinition,
    PluginEntryKind,
    PluginManifest,
    ResolvedPluginPackage,
} from '@cpa/plugin-api'
import { PluginCatalog } from '../catalog/PluginCatalog.js'
import { ContributionRegistry } from '../registry/ContributionRegistry.js'
import { PluginEventBus } from '../events/PluginEventBus.js'
import { PluginRuntime, type PluginModuleLoader, type PluginRuntimeOptions } from './PluginRuntime.js'

function createPkg(
    id: string,
    options?: {
        version?: string
        cpaEngine?: string
        dependencies?: Record<string, string>
        optionalDependencies?: Record<string, string>
        priority?: number
        criticality?: 'platform' | 'required' | 'optional'
        contributes?: Record<string, string[]>
        capabilities?: string[]
    },
): ResolvedPluginPackage {
    return {
        manifest: {
            id,
            name: id,
            version: options?.version ?? '1.0.0',
            apiVersion: '1.0.0',
            engines: {
                cpa: options?.cpaEngine ?? '^1.0.0',
            },
            entries: {
                main: 'index.js',
                renderer: 'index.js',
            },
            dependencies: options?.dependencies ?? {},
            optionalDependencies: options?.optionalDependencies,
            capabilities: (options?.capabilities as any) ?? [],
            contributes: (options?.contributes as any) ?? {
                service: ['core-service', 'slow-svc', 'svc-a', 'svc-b', 'healthy-svc', 'idem-svc'],
                view: ['ui-view'],
                action: ['sample-action', 'my-action', 'declared', 'declared-1', 'declared-2'],
                tool: ['my-tool', 'broken-tool'],
            },
            activationPriority: options?.priority,
            criticality: options?.criticality,
        },
        source: {
            kind: 'bundled',
            spec: `bundled:${id}`,
        },
        sourceRoot: `/plugins/${id}`,
        entries: {
            main: 'index.js',
            renderer: 'index.js',
        },
    }
}

class TestModuleLoader implements PluginModuleLoader {
    private readonly modules = new Map<string, PluginEntryDefinition>()

    registerModule(pluginId: string, definition: PluginEntryDefinition): void {
        this.modules.set(pluginId, definition)
    }

    async load(pkg: ResolvedPluginPackage, runtimeKind: PluginEntryKind): Promise<PluginEntryDefinition | undefined> {
        const mod = this.modules.get(pkg.manifest.id)
        if (mod && mod.runtime === runtimeKind) {
            return mod
        }
        return mod
    }
}

describe('PluginRuntime', () => {
    it.each(['activation', 'generation'] as const)('scopes model invocation in %s registrations', async (mode) => {
        const pkg = createPkg('unprivileged-tool', { contributes: { 'tool-factory': ['test-tool'] } })
        const catalog = new PluginCatalog({ cpaVersion: '1.0.0', packages: [pkg], enabledPluginIds: [pkg.manifest.id] })
        const registry = new ContributionRegistry()
        const loader = new TestModuleLoader()
        const execute = vi.fn().mockResolvedValue({ content: [] })
        loader.registerModule(pkg.manifest.id, {
            runtime: 'renderer',
            activate(context) {
                context.register({ kind: 'tool-factory', id: 'test-tool', value: {
                    id: 'test-tool', create: () => ({ name: 'test-tool', execute }),
                } })
            },
        })
        const runtime = new PluginRuntime({ catalog, registry, loader, entryKind: 'renderer' })
        if (mode === 'generation') {
            const prepared = await runtime.prepareGeneration(catalog, 1)
            await prepared.commit()
        } else await runtime.activateAll()
        const factory = registry.get<any>('tool-factory', 'test-tool')
        const tool = await factory.create({ platform: 'darwin', services: {} })
        await tool.execute('call-A', {}, { modelInvoker: { invoke: vi.fn() } })
        expect(execute.mock.calls[0][2]).toEqual({})
    })

    it('activates plugins in topological order and registers their contributions', async () => {
        const pkgCore = createPkg('core')
        const pkgUi = createPkg('ui', { dependencies: { core: '^1.0.0' } })

        const catalog = new PluginCatalog({
            cpaVersion: '1.0.0',
            packages: [pkgUi, pkgCore],
            enabledPluginIds: ['ui', 'core'],
        })

        const registry = new ContributionRegistry()
        const eventBus = new PluginEventBus()
        const loader = new TestModuleLoader()

        const activationOrder: string[] = []

        loader.registerModule('core', {
            runtime: 'renderer',
            activate(ctx) {
                activationOrder.push('core')
                ctx.register({
                    kind: 'service',
                    id: 'core-service',
                    value: { name: 'core-service-instance' },
                })
            },
        })

        loader.registerModule('ui', {
            runtime: 'renderer',
            activate(ctx) {
                activationOrder.push('ui')
                const coreService = ctx.getService<{ name: string }>('core-service')
                ctx.register({
                    kind: 'view',
                    id: 'ui-view',
                    value: { title: 'UI Panel', fromService: coreService.name },
                })
            },
        })

        const runtime = new PluginRuntime({
            catalog,
            registry,
            eventBus,
            loader,
            entryKind: 'renderer',
        })

        await runtime.activateAll()

        expect(activationOrder).toEqual(['core', 'ui'])
        expect(runtime.getPluginSummary('core').status).toBe('active')
        expect(runtime.getPluginSummary('ui').status).toBe('active')

        const service = registry.get<{ name: string }>('service', 'core-service')
        expect(service).toEqual({ name: 'core-service-instance' })

        const view = registry.get<{ title: string; fromService: string }>('view', 'ui-view')
        expect(view).toEqual({ title: 'UI Panel', fromService: 'core-service-instance' })
    })

    it('keeps an acquired generation alive until the run releases it', async () => {
        const pkgTooling = createPkg('tooling')
        const catalog = new PluginCatalog({
            cpaVersion: '1.0.0',
            packages: [pkgTooling],
            enabledPluginIds: ['tooling'],
        })
        const registry = new ContributionRegistry()
        const loader = new TestModuleLoader()

        loader.registerModule('tooling', {
            runtime: 'renderer',
            activate(ctx) {
                ctx.register({
                    kind: 'tool',
                    id: 'my-tool',
                    value: { fn: () => 'result' },
                })
            },
        })

        const runtime = new PluginRuntime({ catalog, registry, loader, entryKind: 'renderer' })
        await runtime.activateAll()

        const lease = runtime.acquireGeneration(['tooling'])
        const deactivate = runtime.deactivatePlugin('tooling')

        expect(runtime.getPluginSummary('tooling').status).toBe('deactivating')

        lease.release()
        await deactivate

        expect(runtime.getPluginSummary('tooling').status).toBe('inactive')
    })

    it('rolls back every staged contribution when activation throws', async () => {
        const pkgBroken = createPkg('broken', { criticality: 'optional' })
        const catalog = new PluginCatalog({
            cpaVersion: '1.0.0',
            packages: [pkgBroken],
            enabledPluginIds: ['broken'],
        })
        const registry = new ContributionRegistry()
        const loader = new TestModuleLoader()

        loader.registerModule('broken', {
            runtime: 'renderer',
            activate(ctx) {
                ctx.register({
                    kind: 'tool',
                    id: 'broken-tool',
                    value: { execute: () => {} },
                })
                throw new Error('Activation exploded!')
            },
        })

        const runtime = new PluginRuntime({ catalog, registry, loader, entryKind: 'renderer' })
        await runtime.activateAll()

        expect(runtime.registry.list('tool')).toEqual([])
        expect(runtime.getPluginSummary('broken').status).toBe('error')
        expect(runtime.getPluginSummary('broken').error).toContain('Activation exploded!')
    })

    it('deactivates plugins in reverse topological dependency order', async () => {
        const pkgCore = createPkg('core')
        const pkgUi = createPkg('ui', { dependencies: { core: '^1.0.0' } })

        const catalog = new PluginCatalog({
            cpaVersion: '1.0.0',
            packages: [pkgUi, pkgCore],
            enabledPluginIds: ['ui', 'core'],
        })

        const registry = new ContributionRegistry()
        const loader = new TestModuleLoader()
        const deactivationOrder: string[] = []

        loader.registerModule('core', {
            runtime: 'renderer',
            activate() {},
            deactivate() {
                deactivationOrder.push('core')
            },
        })

        loader.registerModule('ui', {
            runtime: 'renderer',
            activate() {},
            deactivate() {
                deactivationOrder.push('ui')
            },
        })

        const runtime = new PluginRuntime({ catalog, registry, loader, entryKind: 'renderer' })
        await runtime.activateAll()

        // Deactivating core should cascade and deactivate UI first
        await runtime.deactivatePlugin('core')

        expect(deactivationOrder).toEqual(['ui', 'core'])
        expect(runtime.getPluginSummary('core').status).toBe('inactive')
        expect(runtime.getPluginSummary('ui').status).toBe('inactive')
    })

    it('handles deactivation timeout gracefully and revokes resources', async () => {
        const pkgSlow = createPkg('slow')
        const catalog = new PluginCatalog({
            cpaVersion: '1.0.0',
            packages: [pkgSlow],
            enabledPluginIds: ['slow'],
        })
        const registry = new ContributionRegistry()
        const loader = new TestModuleLoader()

        loader.registerModule('slow', {
            runtime: 'renderer',
            activate(ctx) {
                ctx.register({
                    kind: 'service',
                    id: 'slow-svc',
                    value: 'alive',
                })
            },
            async deactivate() {
                // Hang indefinitely
                await new Promise((resolve) => setTimeout(resolve, 500))
            },
        })

        const runtime = new PluginRuntime({
            catalog,
            registry,
            loader,
            entryKind: 'renderer',
            deactivateTimeoutMs: 30,
        })

        await runtime.activateAll()
        expect(registry.get('service', 'slow-svc')).toBe('alive')

        await runtime.deactivatePlugin('slow')

        expect(runtime.getPluginSummary('slow').status).toBe('inactive')
        expect(registry.get('service', 'slow-svc')).toBeUndefined()
    })

    it('records error when deactivate hook throws but still cleans up resources', async () => {
        const pkgErrorDeact = createPkg('error-deact')
        const catalog = new PluginCatalog({
            cpaVersion: '1.0.0',
            packages: [pkgErrorDeact],
            enabledPluginIds: ['error-deact'],
        })
        const registry = new ContributionRegistry()
        const loader = new TestModuleLoader()

        loader.registerModule('error-deact', {
            runtime: 'renderer',
            activate(ctx) {
                ctx.register({
                    kind: 'action',
                    id: 'sample-action',
                    value: { run: () => {} },
                })
            },
            deactivate() {
                throw new Error('Deactivation hook failed!')
            },
        })

        const runtime = new PluginRuntime({ catalog, registry, loader, entryKind: 'renderer' })
        await runtime.activateAll()

        expect(registry.get('action', 'sample-action')).toBeDefined()
        await runtime.deactivatePlugin('error-deact')

        expect(registry.get('action', 'sample-action')).toBeUndefined()
        expect(runtime.getPluginSummary('error-deact').status).toBe('inactive')
    })

    it('sequentializes concurrent activation and deactivation via mutex', async () => {
        const pkgA = createPkg('plugin-a')
        const catalog = new PluginCatalog({
            cpaVersion: '1.0.0',
            packages: [pkgA],
            enabledPluginIds: ['plugin-a'],
        })
        const loader = new TestModuleLoader()

        const order: string[] = []

        loader.registerModule('plugin-a', {
            runtime: 'renderer',
            async activate() {
                order.push('start-activate')
                await new Promise((r) => setTimeout(r, 20))
                order.push('finish-activate')
            },
            async deactivate() {
                order.push('start-deactivate')
                await new Promise((r) => setTimeout(r, 20))
                order.push('finish-deactivate')
            },
        })

        const runtime = new PluginRuntime({ catalog, loader, entryKind: 'renderer' })

        // Fire activate and deactivate concurrently
        const p1 = runtime.activatePlugin('plugin-a')
        const p2 = runtime.deactivatePlugin('plugin-a')

        await Promise.all([p1, p2])

        expect(order).toEqual(['start-activate', 'finish-activate', 'start-deactivate', 'finish-deactivate'])
        expect(runtime.getPluginSummary('plugin-a').status).toBe('inactive')
    })

    it('isolates service discovery during activation; throws for unknown services', async () => {
        const pkgCore = createPkg('core')
        const pkgApp = createPkg('app', { dependencies: { core: '^1.0.0' } })

        const catalog = new PluginCatalog({
            cpaVersion: '1.0.0',
            packages: [pkgCore, pkgApp],
            enabledPluginIds: ['core', 'app'],
        })
        const loader = new TestModuleLoader()

        loader.registerModule('core', {
            runtime: 'renderer',
            activate(ctx) {
                ctx.register({
                    kind: 'service',
                    id: 'core-service',
                    value: 'active',
                })
            },
        })

        loader.registerModule('app', {
            runtime: 'renderer',
            activate(ctx) {
                expect(ctx.getService('core-service')).toBe('active')
                expect(() => ctx.getService('non-existent')).toThrow('Service "non-existent" not found')
            },
        })

        const runtime = new PluginRuntime({ catalog, loader, entryKind: 'renderer' })
        await runtime.activateAll()
    })

    it('collects execution metrics across plugin lifecycles', async () => {
        const pkg = createPkg('metrics-test')
        const catalog = new PluginCatalog({
            cpaVersion: '1.0.0',
            packages: [pkg],
            enabledPluginIds: ['metrics-test'],
        })
        const loader = new TestModuleLoader()

        loader.registerModule('metrics-test', {
            runtime: 'renderer',
            async activate() {
                await new Promise((resolve) => setTimeout(resolve, 10))
            },
        })

        const runtime = new PluginRuntime({ catalog, loader, entryKind: 'renderer' })
        await runtime.activateAll()

        const metrics = runtime.getPluginMetrics()
        expect(metrics).toHaveLength(1)
        expect(metrics[0].pluginId).toBe('metrics-test')
        expect(metrics[0].activationCount).toBe(1)
        expect(metrics[0].callCount).toBe(0)
        expect(metrics[0].totalDurationMs).toBeGreaterThanOrEqual(5)
    })

    it('returns plugin summaries with current statuses', async () => {
        const pkgActive = createPkg('active')
        const pkgBroken = createPkg('broken', { criticality: 'optional' })
        const pkgDisabled = createPkg('disabled')

        const catalog = new PluginCatalog({
            cpaVersion: '1.0.0',
            packages: [pkgActive, pkgBroken, pkgDisabled],
            enabledPluginIds: ['active', 'broken'],
        })

        const loader = new TestModuleLoader()
        loader.registerModule('active', {
            runtime: 'renderer',
            activate() {},
        })
        loader.registerModule('broken', {
            runtime: 'renderer',
            activate() {
                throw new Error('fail')
            },
        })

        const runtime = new PluginRuntime({ catalog, loader, entryKind: 'renderer' })
        await runtime.activateAll()

        const summaries = runtime.getPluginSummaries()
        expect(summaries).toHaveLength(3)

        const activeSum = runtime.getPluginSummary('active')
        expect(activeSum.status).toBe('active')

        const brokenSum = runtime.getPluginSummary('broken')
        expect(brokenSum.status).toBe('error')

        const disabledSum = runtime.getPluginSummary('disabled')
        expect(disabledSum.status).toBe('inactive')
    })

    describe('Plugin Declarations and Capabilities', () => {
        function createTestRuntime(
            manifestOverrides: Partial<PluginManifest>,
            entry: PluginEntryDefinition,
            entryKind: PluginEntryKind = 'renderer',
            runtimeOptions?: Partial<PluginRuntimeOptions>,
        ) {
            const pkg: ResolvedPluginPackage = {
                manifest: {
                    id: 'example',
                    name: 'Example',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '^1.0.0' },
                    entries: { [entry.runtime]: 'index.js' },
                    dependencies: {},
                    capabilities: [],
                    contributes: {},
                    ...manifestOverrides,
                },
                source: { kind: 'bundled', spec: 'bundled:example' },
                sourceRoot: '/plugins/example',
                entries: { [entry.runtime]: 'index.js' },
            }

            const catalog = new PluginCatalog({
                cpaVersion: '1.0.0',
                packages: [pkg],
                enabledPluginIds: ['example'],
            })

            const loader: PluginModuleLoader = {
                async load() {
                    return entry
                },
            }

            return new PluginRuntime({
                catalog,
                loader,
                entryKind,
                ...runtimeOptions,
            })
        }

        it('rolls back an undeclared contribution from an entry', async () => {
            const runtime = createTestRuntime(
                { contributes: { action: ['declared'] } },
                {
                    runtime: 'renderer',
                    activate(context) {
                        context.register({ kind: 'action', id: 'undeclared', value: {} })
                    },
                },
            )
            await expect(runtime.activatePlugin('example')).rejects.toThrow(
                'Undeclared contribution action/undeclared',
            )
            expect(runtime.registry.list('action')).toEqual([])
        })

        it('rolls back all staged contributions when an undeclared contribution is encountered', async () => {
            const runtime = createTestRuntime(
                { contributes: { action: ['declared-1', 'declared-2'] } },
                {
                    runtime: 'renderer',
                    activate(context) {
                        context.register({ kind: 'action', id: 'declared-1', value: { id: '1' } })
                        context.register({ kind: 'action', id: 'undeclared-x', value: { id: 'x' } })
                    },
                },
            )
            await expect(runtime.activatePlugin('example')).rejects.toThrow(
                'Undeclared contribution action/undeclared-x',
            )
            expect(runtime.registry.list('action')).toEqual([])
            expect(runtime.getPluginSummary('example').status).toBe('error')
        })

        it('rejects an entry when runtime does not match host entryKind', async () => {
            const runtime = createTestRuntime(
                { contributes: { action: ['declared'] } },
                {
                    runtime: 'agent',
                    activate() {},
                },
                'renderer',
            )
            await expect(runtime.activatePlugin('example')).rejects.toThrow(
                'Plugin "example" entry runtime "agent" does not match host entryKind "renderer"',
            )
            expect(runtime.getPluginSummary('example').status).toBe('error')
        })

        it('provides a deny-by-default capability client when no factory is supplied', async () => {
            let capturedContext: PluginContext | undefined
            const runtime = createTestRuntime(
                {
                    capabilities: ['sessions.read', 'filesystem.*'],
                    contributes: {},
                },
                {
                    runtime: 'renderer',
                    activate(ctx) {
                        capturedContext = ctx
                    },
                },
            )
            await runtime.activateAll()
            expect(capturedContext).toBeDefined()
            expect(capturedContext!.capabilityClient).toBeDefined()

            expect(capturedContext!.capabilityClient!.has('sessions.read')).toBe(true)
            expect(capturedContext!.capabilityClient!.has('filesystem.read')).toBe(true)
            expect(capturedContext!.capabilityClient!.has('settings.read')).toBe(false)

            await expect(
                capturedContext!.capabilityClient!.invoke('sessions.list'),
            ).rejects.toThrow('no capability transport configured')
        })

        it('invokes custom capabilityClientFactory and passes scoped client to PluginContext', async () => {
            let capturedContext: PluginContext | undefined
            const mockClient: PluginCapabilityClient = {
                has: () => true,
                invoke: vi.fn().mockResolvedValue({ count: 10 }),
                subscribe: vi.fn().mockReturnValue(() => {}),
            }
            const factory = vi.fn().mockReturnValue(mockClient)

            const runtime = createTestRuntime(
                {
                    capabilities: ['sessions.*'],
                    contributes: {},
                },
                {
                    runtime: 'renderer',
                    activate(ctx) {
                        capturedContext = ctx
                    },
                },
                'renderer',
                { capabilityClientFactory: factory },
            )
            await runtime.activateAll()

            expect(factory).toHaveBeenCalledWith(
                expect.objectContaining({ id: 'example' }),
                'renderer',
                1,
            )
            expect(capturedContext!.capabilityClient).toBe(mockClient)
            const res = await capturedContext!.capabilityClient!.invoke('sessions.list')
            expect(res).toEqual({ count: 10 })
        })
    })

    describe('Staging Transactions, Atomic Commit, and Dynamic Rollback', () => {
        it('isolates staged contributions in prepareGeneration until explicit commit', async () => {
            const pkgA = createPkg('plugin-a')
            const pkgB = createPkg('plugin-b')

            const catalog = new PluginCatalog({
                cpaVersion: '1.0.0',
                packages: [pkgA, pkgB],
                enabledPluginIds: ['plugin-a', 'plugin-b'],
            })
            const registry = new ContributionRegistry()
            const loader = new TestModuleLoader()

            loader.registerModule('plugin-a', {
                runtime: 'main',
                activate(ctx) {
                    ctx.register({ kind: 'service', id: 'svc-a', value: 'A-v1' })
                },
            })

            loader.registerModule('plugin-b', {
                runtime: 'main',
                activate(ctx) {
                    ctx.register({ kind: 'service', id: 'svc-b', value: 'B-v1' })
                },
            })

            const runtime = new PluginRuntime({
                catalog,
                registry,
                loader,
                entryKind: 'main',
            })

            const prepared = await runtime.prepareGeneration(catalog, 1)

            // During staging, contributions must NOT be visible in the active registry
            expect(registry.get('service', 'svc-a')).toBeUndefined()
            expect(registry.get('service', 'svc-b')).toBeUndefined()
            expect(runtime.getGeneration()).toBe(0)

            // Commit the generation
            await prepared.commit()

            // After commit, contributions are live
            expect(registry.get('service', 'svc-a')).toBe('A-v1')
            expect(registry.get('service', 'svc-b')).toBe('B-v1')
            expect(runtime.getGeneration()).toBe(1)
            expect(runtime.isPluginActive('plugin-a')).toBe(true)
            expect(runtime.isPluginActive('plugin-b')).toBe(true)
        })

        it('discards all staged contributions on explicit rollback without affecting active generation', async () => {
            const pkgA = createPkg('plugin-a')
            const catalog = new PluginCatalog({
                cpaVersion: '1.0.0',
                packages: [pkgA],
                enabledPluginIds: ['plugin-a'],
            })
            const registry = new ContributionRegistry()
            const loader = new TestModuleLoader()

            loader.registerModule('plugin-a', {
                runtime: 'main',
                activate(ctx) {
                    ctx.register({ kind: 'service', id: 'svc-a', value: 'A-v1' })
                },
            })

            const runtime = new PluginRuntime({ catalog, registry, loader, entryKind: 'main' })

            // Gen 1 committed
            await runtime.activateAll()
            expect(registry.get('service', 'svc-a')).toBe('A-v1')
            expect(runtime.getGeneration()).toBe(1)

            // Prepare Gen 2 with updated service value
            loader.registerModule('plugin-a', {
                runtime: 'main',
                activate(ctx) {
                    ctx.register({ kind: 'service', id: 'svc-a', value: 'A-v2' })
                },
            })

            const prepared = await runtime.prepareGeneration(catalog, 2)
            expect(registry.get('service', 'svc-a')).toBe('A-v1')

            // Rollback Gen 2
            await prepared.rollback()

            // Active Gen 1 remains completely unchanged
            expect(registry.get('service', 'svc-a')).toBe('A-v1')
            expect(runtime.getGeneration()).toBe(1)
        })

        it('disallows single-value contribution collision across different plugins during staging', async () => {
            const pkgA = createPkg('plugin-a')
            const pkgB = createPkg('plugin-b')

            const catalog = new PluginCatalog({
                cpaVersion: '1.0.0',
                packages: [pkgA, pkgB],
                enabledPluginIds: ['plugin-a', 'plugin-b'],
            })
            const registry = new ContributionRegistry()
            const loader = new TestModuleLoader()

            loader.registerModule('plugin-a', {
                runtime: 'main',
                activate(ctx) {
                    ctx.register({ kind: 'service', id: 'core-service', value: 'first' })
                },
            })
            loader.registerModule('plugin-b', {
                runtime: 'main',
                activate(ctx) {
                    ctx.register({ kind: 'service', id: 'core-service', value: 'collision' })
                },
            })

            const runtime = new PluginRuntime({ catalog, registry, loader, entryKind: 'main' })

            await expect(runtime.prepareGeneration(catalog, 1)).rejects.toThrow(
                'Contribution conflict: service/core-service is registered multiple times',
            )

            expect(registry.get('service', 'core-service')).toBeUndefined()
            expect(runtime.getGeneration()).toBe(0)
        })

        it('automatically rolls back and leaves previous generation intact when a required plugin fails during prepare', async () => {
            const pkgA = createPkg('plugin-a')
            const pkgB = createPkg('plugin-b')

            const catalog = new PluginCatalog({
                cpaVersion: '1.0.0',
                packages: [pkgA, pkgB],
                enabledPluginIds: ['plugin-a', 'plugin-b'],
            })
            const registry = new ContributionRegistry()
            const loader = new TestModuleLoader()

            let gen1Deactivated = false

            loader.registerModule('plugin-a', {
                runtime: 'main',
                activate(ctx) {
                    ctx.register({ kind: 'service', id: 'svc-a', value: 'A-v1' })
                },
                deactivate() {
                    gen1Deactivated = true
                },
            })
            loader.registerModule('plugin-b', {
                runtime: 'main',
                activate(ctx) {
                    ctx.register({ kind: 'service', id: 'svc-b', value: 'B-v1' })
                },
            })

            const runtime = new PluginRuntime({
                catalog,
                registry,
                loader,
                entryKind: 'main',
            })

            await runtime.activateAll()
            expect(runtime.getGeneration()).toBe(1)
            expect(registry.get('service', 'svc-a')).toBe('A-v1')

            // Fail plugin-b on Generation 2
            loader.registerModule('plugin-b', {
                runtime: 'main',
                activate() {
                    throw new Error('Plugin B failed in Gen 2')
                },
            })

            await expect(runtime.prepareGeneration(catalog, 2)).rejects.toThrow('Plugin B failed in Gen 2')

            // Gen 1 must remain completely active and unchanged
            expect(runtime.getGeneration()).toBe(1)
            expect(runtime.isPluginActive('plugin-a')).toBe(true)
            expect(runtime.isPluginActive('plugin-b')).toBe(true)
            expect(registry.get('service', 'svc-a')).toBe('A-v1')
            expect(registry.get('service', 'svc-b')).toBe('B-v1')
            expect(gen1Deactivated).toBe(false)
        })

        it('treats bundled package without explicit criticality as required by default', async () => {
            const pkgBundled = createPkg('bundled-core')
            // Bundled source, criticality undefined
            delete (pkgBundled.manifest as any).criticality

            const catalog = new PluginCatalog({
                cpaVersion: '1.0.0',
                packages: [pkgBundled],
                enabledPluginIds: ['bundled-core'],
            })
            const loader = new TestModuleLoader()
            loader.registerModule('bundled-core', {
                runtime: 'main',
                activate() {
                    throw new Error('Bundled package failed to activate')
                },
            })

            const runtime = new PluginRuntime({ catalog, loader, entryKind: 'main' })
            await expect(runtime.activateAll()).rejects.toThrow('Bundled package failed to activate')
        })

        it('treats external package without explicit criticality as optional by default', async () => {
            const pkgExternal: ResolvedPluginPackage = {
                manifest: {
                    id: 'external-plugin',
                    name: 'External Plugin',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '^1.0.0' },
                    entries: { main: 'index.js' },
                    dependencies: {},
                    capabilities: [],
                    contributes: {},
                },
                source: {
                    kind: 'global-config',
                    spec: 'external-plugin@1.0.0',
                },
                sourceRoot: '/global/.coding-professional-agent/plugins/external-plugin',
                entries: { main: 'index.js' },
            }

            const pkgHealthy = createPkg('healthy-core')

            const catalog = new PluginCatalog({
                cpaVersion: '1.0.0',
                packages: [pkgExternal, pkgHealthy],
                enabledPluginIds: ['external-plugin', 'healthy-core'],
            })
            const loader = new TestModuleLoader()
            loader.registerModule('external-plugin', {
                runtime: 'main',
                activate() {
                    throw new Error('External optional plugin exploded')
                },
            })
            loader.registerModule('healthy-core', {
                runtime: 'main',
                activate(ctx) {
                    ctx.register({ kind: 'service', id: 'healthy-svc', value: 'OK' })
                },
            })

            const runtime = new PluginRuntime({ catalog, loader, entryKind: 'main' })
            // Should NOT throw because external-plugin is optional by default
            await runtime.activateAll()

            expect(runtime.isPluginActive('healthy-core')).toBe(true)
            expect(runtime.isPluginActive('external-plugin')).toBe(false)
            expect(runtime.getPluginSummary('external-plugin').status).toBe('error')
        })

        it('prepared generation commit and rollback are idempotent', async () => {
            const pkg = createPkg('idempotent-test')
            const catalog = new PluginCatalog({
                cpaVersion: '1.0.0',
                packages: [pkg],
                enabledPluginIds: ['idempotent-test'],
            })
            const loader = new TestModuleLoader()
            loader.registerModule('idempotent-test', {
                runtime: 'main',
                activate(ctx) {
                    ctx.register({ kind: 'service', id: 'idem-svc', value: 'idem' })
                },
            })

            const runtime = new PluginRuntime({ catalog, loader, entryKind: 'main' })
            const prepared = await runtime.prepareGeneration(catalog, 1)

            await prepared.commit()
            expect(runtime.getGeneration()).toBe(1)

            // Second commit should be a no-op
            await prepared.commit()
            expect(runtime.getGeneration()).toBe(1)

            // Rollback after commit should be a no-op
            await prepared.rollback()
            expect(runtime.getGeneration()).toBe(1)
            expect(runtime.isPluginActive('idempotent-test')).toBe(true)
        })

        it('includes external plugin nodes from committed ResolvedPluginGraphDTO in getPluginSummaries and getPluginSummary', async () => {
            const bundledPkg: ResolvedPluginPackage = {
                manifest: {
                    id: 'bundled-core',
                    name: 'Bundled Core',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '^1.0.0' },
                    entries: { main: 'index.js' },
                    dependencies: {},
                    capabilities: [],
                    contributes: {},
                },
                source: { kind: 'bundled', spec: 'bundled:bundled-core' },
                sourceRoot: '/plugins/bundled-core',
                entries: { main: 'index.js' },
            }

            const catalog = new PluginCatalog({
                cpaVersion: '1.0.0',
                packages: [bundledPkg],
                enabledPluginIds: ['bundled-core'],
            })

            const loader: PluginModuleLoader = {
                async load(pkg, runtimeKind) {
                    if (pkg.entries[runtimeKind]) {
                        return {
                            runtime: runtimeKind,
                            activate() {},
                        }
                    }
                    return undefined
                },
            }

            const runtime = new PluginRuntime({ catalog, loader, entryKind: 'main' })

            const graphDTO = {
                revision: 'rev-graph-dto-summary-1',
                createdAt: Date.now(),
                plugins: [
                    {
                        id: 'bundled-core',
                        name: 'Bundled Core',
                        version: '1.0.0',
                        manifest: bundledPkg.manifest,
                        source: bundledPkg.source,
                        sourceKind: 'bundled' as const,
                        entries: { main: 'index.js' },
                        criticality: 'required' as const,
                        dependencies: {},
                    },
                    {
                        id: 'external-npm-plugin',
                        name: 'External NPM Plugin',
                        version: '0.9.0',
                        manifest: {
                            id: 'external-npm-plugin',
                            name: 'External NPM Plugin',
                            version: '0.9.0',
                            apiVersion: '1.0.0',
                            engines: { cpa: '^1.0.0' },
                            entries: { renderer: 'renderer.js' },
                            dependencies: {},
                            capabilities: [],
                            contributes: {},
                            description: 'A third party plugin',
                        },
                        source: { kind: 'npm' as const, spec: 'npm:external-npm-plugin@0.9.0' },
                        sourceKind: 'npm' as const,
                        entries: { renderer: 'renderer.js' },
                        criticality: 'optional' as const,
                        dependencies: {},
                    },
                ],
                activationOrder: ['bundled-core', 'external-npm-plugin'],
            }

            const prepared = await runtime.prepareGeneration(graphDTO, 1)
            await prepared.commit()

            // Catalog must not contain external plugin
            expect(catalog.hasPackage('external-npm-plugin')).toBe(false)
            expect(catalog.hasPackage('bundled-core')).toBe(true)

            // Summaries must include external plugin
            const summaries = runtime.getPluginSummaries()
            expect(summaries.map((s) => s.manifest.id)).toEqual(
                expect.arrayContaining(['bundled-core', 'external-npm-plugin']),
            )

            const externalSummary = runtime.getPluginSummary('external-npm-plugin')
            expect(externalSummary).toBeDefined()
            expect(externalSummary.manifest.id).toBe('external-npm-plugin')
            expect(externalSummary.status).toBe('inactive')
            expect(externalSummary.generation).toBe(1)
        })

        it('isolates staged event listeners and queued emits during prepareGeneration, commit, and rollback', async () => {
            const pkg = createPkg('plugin-event-test')
            const catalog = new PluginCatalog({
                cpaVersion: '1.0.0',
                packages: [pkg],
                enabledPluginIds: ['plugin-event-test'],
            })
            const registry = new ContributionRegistry()
            const eventBus = new PluginEventBus()
            const loader = new TestModuleLoader()

            const pluginReceived: string[] = []
            const hostReceived: string[] = []

            eventBus.on<string>('plugin:broadcast', (msg) => {
                hostReceived.push(`host:${msg}`)
            })

            loader.registerModule('plugin-event-test', {
                runtime: 'main',
                activate(ctx) {
                    ctx.events.on<string>('host:notify', (msg) => {
                        pluginReceived.push(`plugin:${msg}`)
                    })
                    void ctx.events.emit('plugin:broadcast', 'hello-from-staged')
                },
            })

            const runtime = new PluginRuntime({
                catalog,
                registry,
                eventBus,
                loader,
                entryKind: 'main',
            })

            const prepared = await runtime.prepareGeneration(catalog, 1)

            // During staging:
            // 1. Staged listener should NOT receive live bus events
            await eventBus.emit('host:notify', 'live-event-during-staging')
            expect(pluginReceived).toEqual([])

            // 2. Staged emit should NOT have reached host listener yet
            expect(hostReceived).toEqual([])

            // Commit generation
            await prepared.commit()

            // After commit:
            // 1. Queued emit is now flushed to host listener
            expect(hostReceived).toEqual(['host:hello-from-staged'])

            // 2. Plugin listener is now active and receives live bus events
            await eventBus.emit('host:notify', 'live-event-after-commit')
            expect(pluginReceived).toEqual(['plugin:live-event-after-commit'])
        })

        it('discards staged event listeners and queued emits completely on rollback', async () => {
            const pkg = createPkg('plugin-rollback-test')
            const catalog = new PluginCatalog({
                cpaVersion: '1.0.0',
                packages: [pkg],
                enabledPluginIds: ['plugin-rollback-test'],
            })
            const registry = new ContributionRegistry()
            const eventBus = new PluginEventBus()
            const loader = new TestModuleLoader()

            const pluginReceived: string[] = []
            const hostReceived: string[] = []

            eventBus.on<string>('plugin:broadcast', (msg) => {
                hostReceived.push(`host:${msg}`)
            })

            loader.registerModule('plugin-rollback-test', {
                runtime: 'main',
                activate(ctx) {
                    ctx.events.on<string>('host:notify', (msg) => {
                        pluginReceived.push(`plugin:${msg}`)
                    })
                    void ctx.events.emit('plugin:broadcast', 'staged-msg-will-rollback')
                },
            })

            const runtime = new PluginRuntime({
                catalog,
                registry,
                eventBus,
                loader,
                entryKind: 'main',
            })

            const prepared = await runtime.prepareGeneration(catalog, 1)
            await prepared.rollback()

            // Staged listener never active
            expect(eventBus.listenerCount('host:notify')).toBe(0)
            await eventBus.emit('host:notify', 'after-rollback')
            expect(pluginReceived).toEqual([])

            // Queued emits discarded
            expect(hostReceived).toEqual([])
        })

        it('replaces Generation N event listeners with Generation N+1 without double reception or leaks', async () => {
            const pkg = createPkg('plugin-gen-swap')
            const catalog = new PluginCatalog({
                cpaVersion: '1.0.0',
                packages: [pkg],
                enabledPluginIds: ['plugin-gen-swap'],
            })
            const registry = new ContributionRegistry()
            const eventBus = new PluginEventBus()
            const loader = new TestModuleLoader()

            const gen1Received: string[] = []
            const gen2Received: string[] = []

            loader.registerModule('plugin-gen-swap', {
                runtime: 'main',
                activate(ctx) {
                    ctx.events.on<string>('shared:topic', (msg) => {
                        gen1Received.push(`gen1:${msg}`)
                    })
                },
            })

            const runtime = new PluginRuntime({
                catalog,
                registry,
                eventBus,
                loader,
                entryKind: 'main',
            })

            await runtime.activateAll()
            expect(eventBus.listenerCount('shared:topic')).toBe(1)

            await eventBus.emit('shared:topic', 'first')
            expect(gen1Received).toEqual(['gen1:first'])

            // Update to Gen 2
            loader.registerModule('plugin-gen-swap', {
                runtime: 'main',
                activate(ctx) {
                    ctx.events.on<string>('shared:topic', (msg) => {
                        gen2Received.push(`gen2:${msg}`)
                    })
                    void ctx.events.emit('shared:topic', 'from-gen2-prepare')
                },
            })

            const prepared = await runtime.prepareGeneration(catalog, 2)

            // In prepare phase, Gen 1 is still active, Gen 2 is staged
            expect(eventBus.listenerCount('shared:topic')).toBe(1)
            await eventBus.emit('shared:topic', 'during-gen2-prepare')
            expect(gen1Received).toEqual(['gen1:first', 'gen1:during-gen2-prepare'])
            expect(gen2Received).toEqual([])

            // Commit Gen 2
            await prepared.commit()

            // Gen 1 listener revoked, Gen 2 listener active (count = 1)
            expect(eventBus.listenerCount('shared:topic')).toBe(1)

            // Queued emit from Gen 2 should have been delivered ONLY to Gen 2 (and any host listeners), NOT Gen 1!
            expect(gen1Received).toEqual(['gen1:first', 'gen1:during-gen2-prepare'])
            expect(gen2Received).toEqual(['gen2:from-gen2-prepare'])

            // Further live emits should only reach Gen 2
            await eventBus.emit('shared:topic', 'post-gen2-commit')
            expect(gen1Received).toEqual(['gen1:first', 'gen1:during-gen2-prepare'])
            expect(gen2Received).toEqual(['gen2:from-gen2-prepare', 'gen2:post-gen2-commit'])
        })
    })
})
