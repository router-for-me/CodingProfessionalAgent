import { describe, it, expect } from 'vitest'
import type {
    PluginEntryDefinition,
    PluginManifest,
    ResolvedPluginGraphDTO,
    ResolvedPluginPackage,
} from '@cpa/plugin-api'
import { ContributionRegistry } from '@cpa/plugin-kernel'
import { MainPluginRuntimeHost } from '../src/main/plugins/runtime/MainPluginRuntimeHost.js'
import { MainPluginActivationCoordinator } from '../src/main/plugins/runtime/MainPluginActivationCoordinator.js'
import { MainPluginModuleLoader } from '../src/main/plugins/loading/MainPluginModuleLoader.js'
import { createServices } from '../src/main/ipc/registerIpcHandlers.js'

function createPkg(
    id: string,
    options?: {
        criticality?: 'platform' | 'required' | 'optional'
        contributes?: Record<string, string[]>
    },
): ResolvedPluginPackage {
    const manifest: PluginManifest = {
        id,
        name: id,
        version: '1.0.0',
        apiVersion: '1.0.0',
        engines: { cpa: '>=1.0.0' },
        criticality: options?.criticality ?? 'required',
        entries: { main: './main.js' },
        dependencies: {},
        capabilities: [],
        contributes: options?.contributes ?? {},
    }

    return {
        manifest,
        source: { kind: 'bundled', spec: `bundled:${id}` },
        sourceRoot: `/plugins/bundled/${id}`,
        entries: manifest.entries,
    }
}

function createGraphDTO(packages: readonly ResolvedPluginPackage[]): ResolvedPluginGraphDTO {
    return {
        revision: 'rev_stage_test_123456',
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

describe('MainPluginActivationCoordinator (Staging & Production Handshake)', () => {
    it('1. stages Main entries without committing: active registry remains empty, generation is 0', async () => {
        let entryActivated = false
        const pkg = createPkg('cpa.core.stage', { contributes: { service: ['staged-svc'] } })
        const graph = createGraphDTO([pkg])

        const registry = new ContributionRegistry()
        const def: PluginEntryDefinition = {
            runtime: 'main',
            activate(ctx) {
                entryActivated = true
                ctx.register({
                    kind: 'service',
                    id: 'staged-svc',
                    value: { isStaged: true },
                })
            },
        }

        const host = new MainPluginRuntimeHost({
            contributionRegistry: registry,
            bundledPackages: [pkg],
            moduleLoader: new MainPluginModuleLoader(undefined, { 'cpa.core.stage': def }),
        })

        const coordinator = new MainPluginActivationCoordinator({ host, graph })

        // Stage Main entries
        const prepared = await coordinator.stage()

        // Entry activate() ran in staging transaction, but active registry has 0 items
        expect(entryActivated).toBe(true)
        expect(registry.list('service')).toHaveLength(0)
        expect(host.getGeneration()).toBe(0)
        expect(coordinator.getGeneration()).toBe(0)
        expect(prepared.revision).toBe(graph.revision)
        expect(prepared.generation).toBe(1)

        // getPreparedState returns the pending staged state
        const state = coordinator.getPreparedState()
        expect(state).toMatchObject({
            phase: 'prepared',
            revision: graph.revision,
            generation: 1,
            graph,
        })
    })

    it('2. commits prepared generation atomically when revision and generation match', async () => {
        const pkg = createPkg('cpa.core.commit', { contributes: { service: ['commit-svc'] } })
        const graph = createGraphDTO([pkg])

        const registry = new ContributionRegistry()
        const def: PluginEntryDefinition = {
            runtime: 'main',
            activate(ctx) {
                ctx.register({
                    kind: 'service',
                    id: 'commit-svc',
                    value: { committed: true },
                })
            },
        }

        const host = new MainPluginRuntimeHost({
            contributionRegistry: registry,
            bundledPackages: [pkg],
            moduleLoader: new MainPluginModuleLoader(undefined, { 'cpa.core.commit': def }),
        })

        const coordinator = new MainPluginActivationCoordinator({ host, graph })
        await coordinator.stage()

        // Commit prepared generation
        await coordinator.commitPrepared(graph.revision, 1)

        // Active registry is now populated, generation is 1
        expect(registry.list('service')).toHaveLength(1)
        expect(registry.get('service', 'commit-svc')).toEqual({ committed: true })
        expect(host.getGeneration()).toBe(1)
        expect(coordinator.getGeneration()).toBe(1)
        expect(coordinator.getPreparedState()).toMatchObject({
            phase: 'active',
            revision: graph.revision,
            generation: 1,
            graph,
        })
    })

    it('3. rejects commit and rollback when revision or generation mismatch', async () => {
        const pkg = createPkg('cpa.core.mismatch', { contributes: { service: ['mismatch-svc'] } })
        const graph = createGraphDTO([pkg])

        const host = new MainPluginRuntimeHost({
            contributionRegistry: new ContributionRegistry(),
            bundledPackages: [pkg],
            moduleLoader: new MainPluginModuleLoader(undefined, {
                'cpa.core.mismatch': {
                    runtime: 'main',
                    activate(ctx) {
                        ctx.register({ kind: 'service', id: 'mismatch-svc', value: {} })
                    },
                },
            }),
        })

        const coordinator = new MainPluginActivationCoordinator({ host, graph })
        await coordinator.stage()

        // Mismatched revision on commit
        await expect(coordinator.commitPrepared('wrong-revision', 1)).rejects.toThrow(/mismatched/i)

        // Mismatched generation on commit
        await expect(coordinator.commitPrepared(graph.revision, 999)).rejects.toThrow(/mismatched/i)

        // Mismatched revision on rollback
        await expect(coordinator.rollbackPrepared('wrong-revision', 1)).rejects.toThrow(/mismatched/i)

        // Mismatched generation on rollback
        await expect(coordinator.rollbackPrepared(graph.revision, 999)).rejects.toThrow(/mismatched/i)

        // Commit with no pending generation throws
        await coordinator.rollbackPrepared(graph.revision, 1)
        await expect(coordinator.commitPrepared(graph.revision, 1)).rejects.toThrow(/no pending/i)
    })

    it('4. rolls back staged generation cleanly leaving active registry empty', async () => {
        let rolledBack = false
        const pkg = createPkg('cpa.core.rollback', { contributes: { service: ['rb-svc'] } })
        const graph = createGraphDTO([pkg])

        const registry = new ContributionRegistry()
        const host = new MainPluginRuntimeHost({
            contributionRegistry: registry,
            bundledPackages: [pkg],
            moduleLoader: new MainPluginModuleLoader(undefined, {
                'cpa.core.rollback': {
                    runtime: 'main',
                    activate(ctx) {
                        ctx.register({ kind: 'service', id: 'rb-svc', value: {} })
                    },
                    deactivate() {
                        rolledBack = true
                    },
                },
            }),
        })

        const coordinator = new MainPluginActivationCoordinator({ host, graph })
        await coordinator.stage()

        await coordinator.rollbackPrepared(graph.revision, 1)

        expect(rolledBack).toBe(true)
        expect(registry.list('service')).toHaveLength(0)
        expect(host.getGeneration()).toBe(0)
        expect(coordinator.getPreparedState()).toBeNull()
    })

    it('5. rolls back pending generation on dispose without leaks', async () => {
        let disposed = false
        const pkg = createPkg('cpa.core.leak', { contributes: { service: ['leak-svc'] } })
        const graph = createGraphDTO([pkg])

        const registry = new ContributionRegistry()
        const host = new MainPluginRuntimeHost({
            contributionRegistry: registry,
            bundledPackages: [pkg],
            moduleLoader: new MainPluginModuleLoader(undefined, {
                'cpa.core.leak': {
                    runtime: 'main',
                    activate(ctx) {
                        ctx.register({ kind: 'service', id: 'leak-svc', value: {} })
                    },
                    deactivate() {
                        disposed = true
                    },
                },
            }),
        })

        const coordinator = new MainPluginActivationCoordinator({ host, graph })
        await coordinator.stage()
        expect(coordinator.getPreparedState()).not.toBeNull()

        await coordinator.dispose()

        expect(disposed).toBe(true)
        expect(coordinator.getPreparedState()).toBeNull()
        expect(registry.list('service')).toHaveLength(0)
        expect(host.getGeneration()).toBe(0)
    })

    it('6. dispatches getPreparedState, commitGeneration, and rollbackGeneration via RPC descriptors', async () => {
        const pkg = createPkg('cpa.core.rpc', { contributes: { service: ['rpc-svc'] } })
        const graph = createGraphDTO([pkg])

        const host = new MainPluginRuntimeHost({
            contributionRegistry: new ContributionRegistry(),
            bundledPackages: [pkg],
            moduleLoader: new MainPluginModuleLoader(undefined, {
                'cpa.core.rpc': {
                    runtime: 'main',
                    activate(ctx) {
                        ctx.register({ kind: 'service', id: 'rpc-svc', value: {} })
                    },
                },
            }),
        })

        const coordinator = new MainPluginActivationCoordinator({ host, graph })
        await coordinator.stage()

        const services = createServices(() => null, {
            pluginRuntimeHost: host,
            pluginActivationCoordinator: coordinator,
        } as any)

        // Query prepared state via RPC
        const stateRes = await services.handleMethod('plugins:getPreparedState', [])
        expect(stateRes).toMatchObject({
            phase: 'prepared',
            revision: graph.revision,
            generation: 1,
            graph,
        })

        // Commit via RPC
        const commitRes = await services.handleMethod('plugins:commitGeneration', [graph.revision, 1])
        expect(commitRes).toEqual({ ok: true })
        expect(host.getGeneration()).toBe(1)

        // After commit, getPreparedState returns active state
        const stateAfter = await services.handleMethod('plugins:getPreparedState', [])
        expect(stateAfter).toMatchObject({
            phase: 'active',
            revision: graph.revision,
            generation: 1,
            graph,
        })
    })

    it('7. commitPrepared is idempotent when already active with matching revision and generation', async () => {
        const pkg = createPkg('cpa.core.idempotent', { contributes: { service: ['idem-svc'] } })
        const graph = createGraphDTO([pkg])

        const host = new MainPluginRuntimeHost({
            contributionRegistry: new ContributionRegistry(),
            bundledPackages: [pkg],
            moduleLoader: new MainPluginModuleLoader(undefined, {
                'cpa.core.idempotent': {
                    runtime: 'main',
                    activate(ctx) {
                        ctx.register({ kind: 'service', id: 'idem-svc', value: {} })
                    },
                },
            }),
        })

        const coordinator = new MainPluginActivationCoordinator({ host, graph })
        await coordinator.stage()
        await coordinator.commitPrepared(graph.revision, 1)

        expect(coordinator.getGeneration()).toBe(1)
        expect(coordinator.getPreparedState()?.phase).toBe('active')

        // Second commitPrepared with same revision and generation should succeed idempotently
        await expect(coordinator.commitPrepared(graph.revision, 1)).resolves.toBeUndefined()

        // Mismatched revision/generation on already active coordinator must reject
        await expect(coordinator.commitPrepared('other-revision', 1)).rejects.toThrow()
        await expect(coordinator.commitPrepared(graph.revision, 2)).rejects.toThrow()
    })

    it('8. issues grant tickets per document in prepared state, denies second request from same document, and allows new document on active reload', async () => {
        const rendererPkg: ResolvedPluginPackage = {
            manifest: {
                id: 'cpa.core.ui-plugin',
                name: 'UI Plugin',
                version: '1.0.0',
                apiVersion: '1.0.0',
                engines: { cpa: '>=1.0.0' },
                entries: { renderer: './renderer.js', agent: './agent.js' },
                dependencies: {},
                capabilities: ['filesystem.read'],
                contributes: {},
            },
            source: { kind: 'bundled', spec: 'bundled:cpa.core.ui-plugin' },
            sourceRoot: '/plugins/bundled/cpa.core.ui-plugin',
            entries: { renderer: './renderer.js', agent: './agent.js' },
        }
        const graph = createGraphDTO([rendererPkg])

        const host = new MainPluginRuntimeHost({
            bundledPackages: [rendererPkg],
        })
        const coordinator = new MainPluginActivationCoordinator({ host, graph })

        await coordinator.stage()

        // 1. Without context: returns null grantTickets
        const noContextState = coordinator.getPreparedState()
        expect(noContextState?.phase).toBe('prepared')
        expect(noContextState?.grantTickets).toBeNull()

        // 2. Initial prepared state issuance to document 1
        const doc1Context = {
            pluginId: 'desktop-main',
            senderId: 1,
            frameUrl: 'http://localhost:5173/index.html',
            transport: 'electron' as const,
            processId: 1001,
            routingId: 1,
            documentId: '1:1001:1',
        }
        const preparedState1 = coordinator.getPreparedState(doc1Context)
        expect(preparedState1?.phase).toBe('prepared')
        expect(preparedState1?.grantTickets).toBeDefined()
        const rendererTicket1 = preparedState1?.grantTickets?.['cpa.core.ui-plugin']?.renderer
        const agentTicket1 = preparedState1?.grantTickets?.['cpa.core.ui-plugin']?.agent
        expect(rendererTicket1).toMatch(/^ticket_/)
        expect(agentTicket1).toMatch(/^ticket_/)

        // Document 1 redeems the ticket successfully
        const handle1 = host.capabilityBroker.redeemGrantTicket(rendererTicket1!, {
            pluginId: 'cpa.core.ui-plugin',
            runtime: 'renderer',
            senderId: 1,
            frameUrl: 'http://localhost:5173/index.html',
            transport: 'electron',
            processId: 1001,
            routingId: 1,
            documentId: '1:1001:1',
        })
        expect(handle1).toBeDefined()

        // 3. Document 1 calls getPreparedState a SECOND time in prepared phase: MUST return null grantTickets
        const preparedState1Second = coordinator.getPreparedState(doc1Context)
        expect(preparedState1Second?.grantTickets).toBeNull()

        // 4. Commit generation to active
        await coordinator.commitPrepared(graph.revision, 1)

        // Document 1 calls getPreparedState in active phase: MUST still return null grantTickets
        const activeState1 = coordinator.getPreparedState(doc1Context)
        expect(activeState1?.phase).toBe('active')
        expect(activeState1?.grantTickets).toBeNull()

        // 5. Renderer Reload: Document 2 (new routingId/documentId) calls getPreparedState in active phase
        const doc2Context = {
            pluginId: 'desktop-main',
            senderId: 1,
            frameUrl: 'http://localhost:5173/index.html',
            transport: 'electron' as const,
            processId: 1001,
            routingId: 2, // New routingId after reload
            documentId: '1:1001:2',
        }
        const activeState2 = coordinator.getPreparedState(doc2Context)
        expect(activeState2?.phase).toBe('active')
        expect(activeState2?.grantTickets).toBeDefined()
        const rendererTicket2 = activeState2?.grantTickets?.['cpa.core.ui-plugin']?.renderer
        expect(rendererTicket2).toMatch(/^ticket_/)

        // Document 2 redeems ticket
        const handle2 = host.capabilityBroker.redeemGrantTicket(rendererTicket2!, {
            pluginId: 'cpa.core.ui-plugin',
            runtime: 'renderer',
            senderId: 1,
            frameUrl: 'http://localhost:5173/index.html',
            transport: 'electron',
            processId: 1001,
            routingId: 2,
            documentId: '1:1001:2',
        })
        expect(handle2).toBeDefined()

        // Document 2 calls getPreparedState a second time in active phase: MUST return null grantTickets
        const activeState2Second = coordinator.getPreparedState(doc2Context)
        expect(activeState2Second?.grantTickets).toBeNull()
    })

    it('10. clears document issuance and unredeemed tickets on generation rollback or dispose', async () => {
        const rendererPkg: ResolvedPluginPackage = {
            manifest: {
                id: 'cpa.core.cleanup-test',
                name: 'Cleanup Plugin',
                version: '1.0.0',
                apiVersion: '1.0.0',
                engines: { cpa: '>=1.0.0' },
                entries: { renderer: './renderer.js' },
                dependencies: {},
                capabilities: ['filesystem.read'],
                contributes: {},
            },
            source: { kind: 'bundled', spec: 'bundled:cpa.core.cleanup-test' },
            sourceRoot: '/plugins/bundled/cpa.core.cleanup-test',
            entries: { renderer: './renderer.js' },
        }
        const graph = createGraphDTO([rendererPkg])

        const host = new MainPluginRuntimeHost({
            bundledPackages: [rendererPkg],
        })
        const coordinator = new MainPluginActivationCoordinator({ host, graph })

        await coordinator.stage()

        const docContext = {
            pluginId: 'desktop-main',
            senderId: 1,
            frameUrl: 'http://localhost:5173/index.html',
            transport: 'electron' as const,
            documentId: 'doc-cleanup-1',
        }

        const state = coordinator.getPreparedState(docContext)
        const ticket = state?.grantTickets?.['cpa.core.cleanup-test']?.renderer!
        expect(ticket).toMatch(/^ticket_/)

        // Roll back prepared generation
        await coordinator.rollbackPrepared(graph.revision, 1)

        // Ticket must be revoked
        expect(() =>
            host.capabilityBroker.redeemGrantTicket(ticket, {
                pluginId: 'cpa.core.cleanup-test',
                runtime: 'renderer',
                senderId: 1,
                frameUrl: 'http://localhost:5173/index.html',
                transport: 'electron',
                documentId: 'doc-cleanup-1',
            }),
        ).toThrow(/invalid, expired, or already redeemed/i)
    })

    it('9. revokes previous generation handles when committing generation N+1', async () => {
        const pkg = createPkg('cpa.core.lifecycle')
        pkg.manifest.capabilities = ['filesystem.read']
        const graph1 = createGraphDTO([pkg])
        graph1.revision = 'rev_1'
        const graph2 = createGraphDTO([pkg])
        graph2.revision = 'rev_2'

        const host = new MainPluginRuntimeHost({
            bundledPackages: [pkg],
            moduleLoader: new MainPluginModuleLoader(undefined, {
                'cpa.core.lifecycle': {
                    runtime: 'main',
                    activate: () => {},
                },
            }),
        })
        host.capabilityBroker.register({
            method: 'native:readFile',
            capability: 'filesystem.read',
            validate: () => {},
            invoke: async () => 'data',
        })
        const coordinator = new MainPluginActivationCoordinator({ host, graph: graph1 })

        // Stage & Commit generation 1
        await coordinator.stage(graph1)
        await coordinator.commitPrepared(graph1.revision, 1)

        // Directly grant a handle in generation 1
        const gen1Handle = host.capabilityBroker.grant(
            { pluginId: 'cpa.core.lifecycle', senderId: 1, frameUrl: '', transport: 'electron', runtime: 'renderer' },
            ['filesystem.read'],
            1,
        )

        // Stage & Commit generation 2
        await coordinator.stage(graph2, { generation: 2 })
        await coordinator.commitPrepared(graph2.revision, 2)

        // gen1Handle must now be revoked
        await expect(
            host.capabilityBroker.invoke(
                gen1Handle,
                'native:readFile',
                ['/tmp/test'],
                { pluginId: 'cpa.core.lifecycle', senderId: 1, frameUrl: '', transport: 'electron', runtime: 'renderer' },
            ),
        ).rejects.toThrow('Invalid or expired capability handle')
    })

    it('retries staging via ensurePrepared after the initial stage() failure', async () => {
        let attempts = 0
        const pkg = createPkg('cpa.core.retry-stage', { contributes: { service: ['retry-svc'] } })
        const graph = createGraphDTO([pkg])
        const registry = new ContributionRegistry()
        const host = new MainPluginRuntimeHost({
            contributionRegistry: registry,
            bundledPackages: [pkg],
            moduleLoader: new MainPluginModuleLoader(undefined, {
                'cpa.core.retry-stage': {
                    runtime: 'main',
                    activate(ctx) {
                        attempts += 1
                        if (attempts === 1) {
                            throw new Error('native module bridge not ready')
                        }
                        ctx.register({ kind: 'service', id: 'retry-svc', value: { ok: true } })
                    },
                },
            }),
        })
        const coordinator = new MainPluginActivationCoordinator({ host, graph })

        await expect(coordinator.stage()).rejects.toThrow(/native module bridge not ready/)
        expect(coordinator.getPendingGeneration()).toBeNull()
        expect(coordinator.getGeneration()).toBe(0)

        await coordinator.ensurePrepared()
        expect(coordinator.getPendingGeneration()?.generation).toBe(1)
        expect(attempts).toBe(2)

        await coordinator.commitPrepared(graph.revision, 1)
        expect(coordinator.getGeneration()).toBe(1)
        expect(registry.get('service', 'retry-svc')).toEqual({ ok: true })
    })

    it('surfaces the last stage error when committing with no pending generation', async () => {
        const pkg = createPkg('cpa.core.stage-error', { contributes: { service: ['err-svc'] } })
        const graph = createGraphDTO([pkg])
        const host = new MainPluginRuntimeHost({
            contributionRegistry: new ContributionRegistry(),
            bundledPackages: [pkg],
            moduleLoader: new MainPluginModuleLoader(undefined, {
                'cpa.core.stage-error': {
                    runtime: 'main',
                    activate() {
                        throw new Error('native module bridge not ready')
                    },
                },
            }),
        })
        const coordinator = new MainPluginActivationCoordinator({ host, graph })

        await expect(coordinator.stage()).rejects.toThrow(/native module bridge not ready/)
        await expect(coordinator.commitPrepared(graph.revision, 1)).rejects.toThrow(
            /No pending prepared plugin generation to commit.*native module bridge not ready/,
        )
    })

    it('getPreparedState and commitGeneration RPCs restage when startup stage was skipped', async () => {
        const pkg = createPkg('cpa.core.rpc-restage', { contributes: { service: ['rpc-restage-svc'] } })
        const graph = createGraphDTO([pkg])
        const registry = new ContributionRegistry()
        const host = new MainPluginRuntimeHost({
            contributionRegistry: registry,
            bundledPackages: [pkg],
            moduleLoader: new MainPluginModuleLoader(undefined, {
                'cpa.core.rpc-restage': {
                    runtime: 'main',
                    activate(ctx) {
                        ctx.register({ kind: 'service', id: 'rpc-restage-svc', value: { ok: true } })
                    },
                },
            }),
        })
        const coordinator = new MainPluginActivationCoordinator({ host, graph })
        const services = createServices(() => null, {
            pluginRuntimeHost: host,
            pluginActivationCoordinator: coordinator,
        } as any)

        const stateRes = await services.handleMethod('plugins:getPreparedState', [])
        expect(stateRes).toMatchObject({
            phase: 'prepared',
            revision: graph.revision,
            generation: 1,
            graph,
        })

        const commitRes = await services.handleMethod('plugins:commitGeneration', [graph.revision, 1])
        expect(commitRes).toEqual({ ok: true })
        expect(coordinator.getGeneration()).toBe(1)
        expect(registry.get('service', 'rpc-restage-svc')).toEqual({ ok: true })
    })
})
