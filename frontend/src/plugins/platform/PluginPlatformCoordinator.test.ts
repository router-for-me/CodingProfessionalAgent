import { describe, expect, it, vi } from 'vitest'
import type {
    PluginEntryDefinition,
    PluginManifest,
    ResolvedPluginGraphDTO,
    ResolvedPluginPackage,
} from '@cpa/plugin-api'
import { ContributionRegistry } from '@cpa/plugin-kernel'
import { RendererPluginRuntimeHost } from './RendererPluginRuntimeHost'
import { AgentPluginRuntimeHost } from './AgentPluginRuntimeHost'
import {
    PluginPlatformCoordinator,
    type MainGenerationParticipant,
} from './PluginPlatformCoordinator'
import { RendererRegistry } from './rendererRegistry'

function createAuthoritativePkg(
    id: string,
    options?: {
        criticality?: 'platform' | 'required' | 'optional'
        contributes?: Record<string, string[]>
        entries?: { renderer?: string; agent?: string }
    },
): ResolvedPluginPackage {
    const manifest: PluginManifest = {
        id,
        name: id,
        version: '1.0.0',
        apiVersion: '1.0.0',
        engines: { cpa: '>=1.0.0' },
        criticality: options?.criticality ?? 'required',
        entries: options?.entries ?? {
            renderer: './renderer.js',
            agent: './agent.js',
        },
        dependencies: {},
        capabilities: [],
        contributes: options?.contributes ?? {},
    }

    return {
        manifest,
        source: { kind: 'bundled', spec: `bundled:${id}` },
        sourceRoot: `plugins/bundled/${id}`,
        entries: manifest.entries,
    }
}

function createGraphDTO(packages: readonly ResolvedPluginPackage[]): ResolvedPluginGraphDTO {
    return {
        revision: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
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

describe('PluginPlatformCoordinator', () => {
    it('coordinates renderer and agent runtimes with shared generation and graph revision', async () => {
        const pkg = createAuthoritativePkg('cpa.core.feature', {
            contributes: {
                view: ['feature-view'],
                'tool-factory': ['feature-tool'],
            },
        })

        const rendererRegistry = new RendererRegistry(new ContributionRegistry())
        const agentRegistry = new ContributionRegistry()

        const rendererDef: PluginEntryDefinition = {
            runtime: 'renderer',
            activate(ctx) {
                ctx.register({
                    kind: 'view',
                    id: 'feature-view',
                    value: { title: 'Feature View' },
                })
            },
        }

        const agentDef: PluginEntryDefinition = {
            runtime: 'agent',
            activate(ctx) {
                ctx.register({
                    kind: 'tool-factory',
                    id: 'feature-tool',
                    value: { name: 'feature_tool' },
                })
            },
        }

        const rendererHost = new RendererPluginRuntimeHost({
            registry: rendererRegistry,
            bundledPackages: [pkg],
            defaultDefinitions: {
                'cpa.core.feature': rendererDef,
            },
        })

        const agentHost = new AgentPluginRuntimeHost({
            contributionRegistry: agentRegistry,
            bundledPackages: [pkg],
            defaultDefinitions: {
                'cpa.core.feature': agentDef,
            },
        })

        const coordinator = new PluginPlatformCoordinator({
            rendererHost,
            agentHost,
        })

        const graph = createGraphDTO([pkg])

        // Stage via coordinator
        const prepared = await coordinator.prepareGeneration(graph)

        // Before commit: registries are completely untouched
        expect(rendererRegistry.kernelRegistry.list('view')).toHaveLength(0)
        expect(agentRegistry.list('tool-factory')).toHaveLength(0)
        expect(coordinator.getGeneration()).toBe(0)

        // Commit: both runtimes advance to generation 1 and activate contributions
        await prepared.commit()

        expect(rendererRegistry.kernelRegistry.list('view')).toHaveLength(1)
        expect(rendererRegistry.kernelRegistry.get('view', 'feature-view')).toEqual({
            title: 'Feature View',
        })

        expect(agentRegistry.list('tool-factory')).toHaveLength(1)
        expect(agentRegistry.get('tool-factory', 'feature-tool')).toEqual({
            name: 'feature_tool',
        })

        expect(coordinator.getGeneration()).toBe(1)
        expect(coordinator.getRevision()).toBe(graph.revision)
        expect(coordinator.isReady()).toBe(true)
    })

    it('rolls back both renderer and agent runtimes when a required agent entry fails', async () => {
        const pkg = createAuthoritativePkg('cpa.core.failing', {
            criticality: 'required',
            contributes: {
                view: ['failing-view'],
                'tool-factory': ['failing-tool'],
            },
        })

        const rendererRegistry = new RendererRegistry(new ContributionRegistry())
        const agentRegistry = new ContributionRegistry()

        const rendererDef: PluginEntryDefinition = {
            runtime: 'renderer',
            activate(ctx) {
                ctx.register({
                    kind: 'view',
                    id: 'failing-view',
                    value: { title: 'Failing View' },
                })
            },
        }

        const agentDef: PluginEntryDefinition = {
            runtime: 'agent',
            activate() {
                throw new Error('agent activation failed')
            },
        }

        const rendererHost = new RendererPluginRuntimeHost({
            registry: rendererRegistry,
            bundledPackages: [pkg],
            defaultDefinitions: {
                'cpa.core.failing': rendererDef,
            },
        })

        const agentHost = new AgentPluginRuntimeHost({
            contributionRegistry: agentRegistry,
            bundledPackages: [pkg],
            defaultDefinitions: {
                'cpa.core.failing': agentDef,
            },
        })

        const coordinator = new PluginPlatformCoordinator({
            rendererHost,
            agentHost,
        })

        const graph = createGraphDTO([pkg])

        await expect(coordinator.activate(graph)).rejects.toThrow('agent activation failed')

        // All runtimes rolled back; no exposed contributions
        expect(rendererRegistry.kernelRegistry.list('view')).toHaveLength(0)
        expect(agentRegistry.list('tool-factory')).toHaveLength(0)
        expect(coordinator.getGeneration()).toBe(0)
        expect(coordinator.isReady()).toBe(false)
    })

    it('preserves active registry isolation between renderer and agent runtimes', async () => {
        const pkg = createAuthoritativePkg('cpa.core.isolated', {
            contributes: {
                view: ['isolated-view'],
                'tool-factory': ['isolated-tool'],
            },
        })

        const rendererRegistry = new RendererRegistry(new ContributionRegistry())
        const agentRegistry = new ContributionRegistry()

        const rendererHost = new RendererPluginRuntimeHost({
            registry: rendererRegistry,
            bundledPackages: [pkg],
            defaultDefinitions: {
                'cpa.core.isolated': {
                    runtime: 'renderer',
                    activate(ctx) {
                        ctx.register({
                            kind: 'view',
                            id: 'isolated-view',
                            value: { title: 'Isolated View' },
                        })
                    },
                },
            },
        })

        const agentHost = new AgentPluginRuntimeHost({
            contributionRegistry: agentRegistry,
            bundledPackages: [pkg],
            defaultDefinitions: {
                'cpa.core.isolated': {
                    runtime: 'agent',
                    activate(ctx) {
                        ctx.register({
                            kind: 'tool-factory',
                            id: 'isolated-tool',
                            value: { name: 'isolated_tool' },
                        })
                    },
                },
            },
        })

        const coordinator = new PluginPlatformCoordinator({
            rendererHost,
            agentHost,
        })

        const graph = createGraphDTO([pkg])
        await coordinator.activate(graph)

        // Renderer registry only contains view, not tool-factory
        expect(rendererRegistry.kernelRegistry.list('view')).toHaveLength(1)
        expect(rendererRegistry.kernelRegistry.list('tool-factory')).toHaveLength(0)

        // Agent registry only contains tool-factory, not view
        expect(agentRegistry.list('tool-factory')).toHaveLength(1)
        expect(agentRegistry.list('view')).toHaveLength(0)
    })

    it('handles optional plugin failures by isolating the failed plugin and committing remaining', async () => {
        const pkgRequired = createAuthoritativePkg('cpa.core.req', {
            criticality: 'required',
            contributes: {
                view: ['req-view'],
            },
        })
        const pkgOptional = createAuthoritativePkg('cpa.core.opt', {
            criticality: 'optional',
            contributes: {
                'tool-factory': ['opt-tool'],
            },
        })

        const rendererRegistry = new RendererRegistry(new ContributionRegistry())
        const agentRegistry = new ContributionRegistry()

        const rendererHost = new RendererPluginRuntimeHost({
            registry: rendererRegistry,
            bundledPackages: [pkgRequired, pkgOptional],
            defaultDefinitions: {
                'cpa.core.req': {
                    runtime: 'renderer',
                    activate(ctx) {
                        ctx.register({ kind: 'view', id: 'req-view', value: { title: 'Req View' } })
                    },
                },
            },
        })

        const agentHost = new AgentPluginRuntimeHost({
            contributionRegistry: agentRegistry,
            bundledPackages: [pkgRequired, pkgOptional],
            defaultDefinitions: {
                'cpa.core.opt': {
                    runtime: 'agent',
                    activate() {
                        throw new Error('optional agent failure')
                    },
                },
            },
        })

        const coordinator = new PluginPlatformCoordinator({
            rendererHost,
            agentHost,
        })

        const graph = createGraphDTO([pkgRequired, pkgOptional])
        const prepared = await coordinator.prepareGeneration(graph)
        await prepared.commit()

        expect(rendererRegistry.kernelRegistry.list('view')).toHaveLength(1)
        expect(agentHost.getPluginSummary('cpa.core.opt')?.status).toBe('error')
        expect(coordinator.getGeneration()).toBe(1)
        expect(coordinator.isReady()).toBe(true)
    })

    describe('Cross-process Production Handshake with MainGenerationParticipant', () => {
        it('stages and commits Renderer and Agent coordinated with MainGenerationParticipant', async () => {
            const pkg = createAuthoritativePkg('cpa.core.handshake', {
                contributes: {
                    view: ['handshake-view'],
                    'tool-factory': ['handshake-tool'],
                },
            })

            const rendererRegistry = new RendererRegistry(new ContributionRegistry())
            const agentRegistry = new ContributionRegistry()

            const rendererHost = new RendererPluginRuntimeHost({
                registry: rendererRegistry,
                bundledPackages: [pkg],
                defaultDefinitions: {
                    'cpa.core.handshake': {
                        runtime: 'renderer',
                        activate(ctx) {
                            ctx.register({ kind: 'view', id: 'handshake-view', value: { ok: true } })
                        },
                    },
                },
            })

            const agentHost = new AgentPluginRuntimeHost({
                contributionRegistry: agentRegistry,
                bundledPackages: [pkg],
                defaultDefinitions: {
                    'cpa.core.handshake': {
                        runtime: 'agent',
                        activate(ctx) {
                            ctx.register({ kind: 'tool-factory', id: 'handshake-tool', value: { ok: true } })
                        },
                    },
                },
            })

            const graph = createGraphDTO([pkg])
            let mainCommitted = false
            let mainRollbackCalled = false

            const mainParticipant = {
                async getPreparedState() {
                    return { revision: graph.revision, generation: 1, graph }
                },
                async commit(revision: string, generation: number) {
                    if (revision !== graph.revision || generation !== 1) {
                        throw new Error('Mismatched participant commit args')
                    }
                    mainCommitted = true
                },
                async rollback() {
                    mainRollbackCalled = true
                },
            }

            const coordinator = new PluginPlatformCoordinator({
                rendererHost,
                agentHost,
                mainParticipant,
            })

            const prepared = await coordinator.prepareGeneration()
            expect(prepared.revision).toBe(graph.revision)
            expect(prepared.generation).toBe(1)

            // Before commit: not committed, registries empty
            expect(mainCommitted).toBe(false)
            expect(rendererRegistry.kernelRegistry.list('view')).toHaveLength(0)
            expect(agentRegistry.list('tool-factory')).toHaveLength(0)

            await prepared.commit()

            // After commit: main committed first, then local runtimes committed
            expect(mainCommitted).toBe(true)
            expect(mainRollbackCalled).toBe(false)
            expect(rendererRegistry.kernelRegistry.list('view')).toHaveLength(1)
            expect(agentRegistry.list('tool-factory')).toHaveLength(1)
            expect(coordinator.getGeneration()).toBe(1)
            expect(coordinator.getRevision()).toBe(graph.revision)
            expect(coordinator.isReady()).toBe(true)
        })

        it('triggers Main rollback when local required entry fails during prepare', async () => {
            const pkg = createAuthoritativePkg('cpa.core.localfail', {
                criticality: 'required',
                contributes: {
                    view: ['lf-view'],
                    'tool-factory': ['lf-tool'],
                },
            })

            const rendererRegistry = new RendererRegistry(new ContributionRegistry())
            const agentRegistry = new ContributionRegistry()

            const rendererHost = new RendererPluginRuntimeHost({
                registry: rendererRegistry,
                bundledPackages: [pkg],
                defaultDefinitions: {
                    'cpa.core.localfail': {
                        runtime: 'renderer',
                        activate() {
                            throw new Error('renderer activation exploded')
                        },
                    },
                },
            })

            const agentHost = new AgentPluginRuntimeHost({
                contributionRegistry: agentRegistry,
                bundledPackages: [pkg],
            })

            const graph = createGraphDTO([pkg])
            let mainRollbackArgs: { revision?: string; generation?: number } | null = null

            const mainParticipant = {
                async getPreparedState() {
                    return { revision: graph.revision, generation: 1, graph }
                },
                async commit() {},
                async rollback(revision?: string, generation?: number) {
                    mainRollbackArgs = { revision, generation }
                },
            }

            const coordinator = new PluginPlatformCoordinator({
                rendererHost,
                agentHost,
                mainParticipant,
            })

            await expect(coordinator.activate()).rejects.toThrow('renderer activation exploded')

            // Main participant rollback was called with the staged revision & generation
            expect(mainRollbackArgs).toEqual({
                revision: graph.revision,
                generation: 1,
            })

            // Local runtimes are rolled back
            expect(rendererRegistry.kernelRegistry.list('view')).toHaveLength(0)
            expect(coordinator.getGeneration()).toBe(0)
            expect(coordinator.isReady()).toBe(false)
        })

        it('fails prepare when Main getPreparedState rejects instead of committing a missing generation', async () => {
            const pkg = createAuthoritativePkg('cpa.core.mainstatefail', {
                contributes: {
                    view: ['msf-view'],
                },
            })

            const rendererHost = new RendererPluginRuntimeHost({
                bundledPackages: [pkg],
                defaultDefinitions: {
                    'cpa.core.mainstatefail': {
                        runtime: 'renderer',
                        activate() {},
                    },
                },
            })
            const agentHost = new AgentPluginRuntimeHost({
                bundledPackages: [pkg],
            })
            const graph = createGraphDTO([pkg])
            const coordinator = new PluginPlatformCoordinator({
                rendererHost,
                agentHost,
                mainParticipant: {
                    async getPreparedState() {
                        throw new Error('native module bridge not ready')
                    },
                    async commit() {
                        throw new Error('should not commit')
                    },
                    async rollback() {},
                },
            })

            await expect(coordinator.prepareGeneration(graph)).rejects.toThrow(
                'native module bridge not ready',
            )
        })

        it('rolls back local prepared generations if Main participant commit throws', async () => {
            const pkg = createAuthoritativePkg('cpa.core.maincommitfail', {
                contributes: {
                    view: ['mcf-view'],
                    'tool-factory': ['mcf-tool'],
                },
            })

            const rendererRegistry = new RendererRegistry(new ContributionRegistry())
            const agentRegistry = new ContributionRegistry()

            const rendererHost = new RendererPluginRuntimeHost({
                registry: rendererRegistry,
                bundledPackages: [pkg],
                defaultDefinitions: {
                    'cpa.core.maincommitfail': {
                        runtime: 'renderer',
                        activate(ctx) {
                            ctx.register({ kind: 'view', id: 'mcf-view', value: {} })
                        },
                    },
                },
            })

            const agentHost = new AgentPluginRuntimeHost({
                contributionRegistry: agentRegistry,
                bundledPackages: [pkg],
                defaultDefinitions: {
                    'cpa.core.maincommitfail': {
                        runtime: 'agent',
                        activate(ctx) {
                            ctx.register({ kind: 'tool-factory', id: 'mcf-tool', value: {} })
                        },
                    },
                },
            })

            const graph = createGraphDTO([pkg])
            const mainParticipant = {
                async getPreparedState() {
                    return { revision: graph.revision, generation: 1, graph }
                },
                async commit() {
                    throw new Error('IPC commit error: Main process crashed')
                },
                async rollback() {},
            }

            const coordinator = new PluginPlatformCoordinator({
                rendererHost,
                agentHost,
                mainParticipant,
            })

            await expect(coordinator.activate()).rejects.toThrow('IPC commit error: Main process crashed')

            // Local staged state rolled back; active registries remain empty
            expect(rendererRegistry.kernelRegistry.list('view')).toHaveLength(0)
            expect(agentRegistry.list('tool-factory')).toHaveLength(0)
            expect(rendererHost.getGeneration()).toBe(0)
            expect(agentHost.getGeneration()).toBe(0)
            expect(coordinator.getGeneration()).toBe(0)
            expect(coordinator.isReady()).toBe(false)
        })

        it('reload safety: new Renderer context restores from active Main state without calling Main commit', async () => {
            const pkg = createAuthoritativePkg('cpa.core.reload', {
                contributes: {
                    view: ['reload-view'],
                    'tool-factory': ['reload-tool'],
                },
            })

            const rendererRegistry = new RendererRegistry(new ContributionRegistry())
            const agentRegistry = new ContributionRegistry()

            const rendererHost = new RendererPluginRuntimeHost({
                registry: rendererRegistry,
                bundledPackages: [pkg],
                defaultDefinitions: {
                    'cpa.core.reload': {
                        runtime: 'renderer',
                        activate(ctx) {
                            ctx.register({
                                kind: 'view',
                                id: 'reload-view',
                                value: { name: 'Reload View' },
                            })
                        },
                    },
                },
            })

            const agentHost = new AgentPluginRuntimeHost({
                contributionRegistry: agentRegistry,
                bundledPackages: [pkg],
                defaultDefinitions: {
                    'cpa.core.reload': {
                        runtime: 'agent',
                        activate(ctx) {
                            ctx.register({
                                kind: 'tool-factory',
                                id: 'reload-tool',
                                value: { name: 'Reload Tool' },
                            })
                        },
                    },
                },
            })

            const graph = createGraphDTO([pkg])
            let commitCallCount = 0
            let rollbackCallCount = 0

            // Main is already committed / active (phase === 'active')
            const mainParticipant = {
                async getPreparedState() {
                    return {
                        phase: 'active' as const,
                        revision: graph.revision,
                        generation: 1,
                        graph,
                    }
                },
                async commit() {
                    commitCallCount++
                },
                async rollback() {
                    rollbackCallCount++
                },
            }

            // Fresh renderer context (generation is 0)
            const coordinator = new PluginPlatformCoordinator({
                rendererHost,
                agentHost,
                mainParticipant,
            })

            expect(coordinator.getGeneration()).toBe(0)
            expect(coordinator.isReady()).toBe(false)

            // Activate on reload
            await coordinator.activate()

            // Main commit was NOT called because Main was already active
            expect(commitCallCount).toBe(0)
            expect(rollbackCallCount).toBe(0)

            // Local runtimes are restored to generation 1 and ready
            expect(coordinator.getGeneration()).toBe(1)
            expect(coordinator.getRevision()).toBe(graph.revision)
            expect(coordinator.isReady()).toBe(true)
            expect(rendererRegistry.kernelRegistry.list('view')).toHaveLength(1)
            expect(agentRegistry.list('tool-factory')).toHaveLength(1)
        })

        it('repeated activate on already ready coordinator is a no-op and does not advance generation', async () => {
            const pkg = createAuthoritativePkg('cpa.core.noop', {
                contributes: {
                    view: ['noop-view'],
                },
            })

            const rendererRegistry = new RendererRegistry(new ContributionRegistry())
            const agentRegistry = new ContributionRegistry()

            const rendererHost = new RendererPluginRuntimeHost({
                registry: rendererRegistry,
                bundledPackages: [pkg],
                defaultDefinitions: {
                    'cpa.core.noop': {
                        runtime: 'renderer',
                        activate(ctx) {
                            ctx.register({
                                kind: 'view',
                                id: 'noop-view',
                                value: {},
                            })
                        },
                    },
                },
            })

            const agentHost = new AgentPluginRuntimeHost({
                contributionRegistry: agentRegistry,
                bundledPackages: [pkg],
            })

            const graph = createGraphDTO([pkg])
            let commitCallCount = 0

            const mainParticipant = {
                async getPreparedState() {
                    return {
                        phase: 'prepared' as const,
                        revision: graph.revision,
                        generation: 1,
                        graph,
                    }
                },
                async commit() {
                    commitCallCount++
                },
                async rollback() {},
            }

            const coordinator = new PluginPlatformCoordinator({
                rendererHost,
                agentHost,
                mainParticipant,
            })

            // 1st activation
            await coordinator.activate()
            expect(coordinator.getGeneration()).toBe(1)
            expect(commitCallCount).toBe(1)
            expect(coordinator.isReady()).toBe(true)

            // 2nd activation with same revision & generation (e.g. repeated bootstrap)
            const secondPrepared = await coordinator.prepareGeneration(graph, {
                generation: 1,
            })
            await secondPrepared.commit()

            // Must NOT advance generation or call main commit again
            expect(coordinator.getGeneration()).toBe(1)
            expect(commitCallCount).toBe(1)
        })

        it('local prepare failure when Main is in active phase does not call Main rollback', async () => {
            const pkg = createAuthoritativePkg('cpa.core.failactive', {
                criticality: 'required',
                contributes: {
                    view: ['fa-view'],
                },
            })

            const rendererRegistry = new RendererRegistry(new ContributionRegistry())
            const agentRegistry = new ContributionRegistry()

            const rendererHost = new RendererPluginRuntimeHost({
                registry: rendererRegistry,
                bundledPackages: [pkg],
                defaultDefinitions: {
                    'cpa.core.failactive': {
                        runtime: 'renderer',
                        activate() {
                            throw new Error('renderer explode during active restore')
                        },
                    },
                },
            })

            const agentHost = new AgentPluginRuntimeHost({
                contributionRegistry: agentRegistry,
                bundledPackages: [pkg],
            })

            const graph = createGraphDTO([pkg])
            let mainRollbackCalled = false

            const mainParticipant = {
                async getPreparedState() {
                    return {
                        phase: 'active' as const,
                        revision: graph.revision,
                        generation: 1,
                        graph,
                    }
                },
                async commit() {},
                async rollback() {
                    mainRollbackCalled = true
                },
            }

            const coordinator = new PluginPlatformCoordinator({
                rendererHost,
                agentHost,
                mainParticipant,
            })

            await expect(coordinator.activate()).rejects.toThrow('renderer explode during active restore')

            // Main rollback was NOT called because Main was already active
            expect(mainRollbackCalled).toBe(false)
        })

        it('redeems grant tickets from prepared state and injects authentic capability handles before activating plugins', async () => {
            const pkg: ResolvedPluginPackage = {
                manifest: {
                    id: 'cpa.test.secured',
                    name: 'Secured Plugin',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '>=1.0.0' },
                    entries: { renderer: './index.ts' },
                    dependencies: {},
                    capabilities: ['filesystem.read'],
                    contributes: {},
                },
                source: { kind: 'bundled', spec: 'bundled:cpa.test.secured' },
                sourceRoot: '/plugins/bundled/cpa.test.secured',
                entries: { renderer: './index.ts' },
            }

            let capturedClient: any = null
            const rendererHost = new RendererPluginRuntimeHost({
                bundledPackages: [pkg],
                defaultDefinitions: {
                    'cpa.test.secured': {
                        runtime: 'renderer',
                        activate: (ctx) => {
                            capturedClient = ctx.capabilityClient
                        },
                    },
                },
            })

            const redeemedCalls: Array<{ ticket: string; runtime?: string }> = []
            const grantTransport = vi.fn().mockImplementation(async (ticket: string, runtime?: string) => {
                redeemedCalls.push({ ticket, runtime })
                return { ok: true, value: `handle_for_${ticket}` }
            })

            let capturedAgentClient: any = null
            const pkgWithBoth: ResolvedPluginPackage = {
                manifest: {
                    id: 'cpa.test.secured',
                    name: 'Secured Plugin',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '>=1.0.0' },
                    criticality: 'required',
                    entries: { renderer: './renderer.ts', agent: './agent.ts' },
                    dependencies: {},
                    capabilities: ['filesystem.read', 'storage.kv'],
                    contributes: {},
                },
                source: { kind: 'bundled', spec: 'bundled:cpa.test.secured' },
                sourceRoot: '/plugins/bundled/cpa.test.secured',
                entries: { renderer: './renderer.ts', agent: './agent.ts' },
            }
            const graphWithBoth = createGraphDTO([pkgWithBoth])

            const testAgentHost = new AgentPluginRuntimeHost({
                bundledPackages: [pkgWithBoth],
                defaultDefinitions: {
                    'cpa.test.secured': {
                        runtime: 'agent',
                        activate: (ctx) => {
                            capturedAgentClient = ctx.capabilityClient
                        },
                    },
                },
            })

            const mainParticipant: MainGenerationParticipant = {
                async getPreparedState() {
                    return {
                        phase: 'prepared',
                        revision: graphWithBoth.revision,
                        generation: 1,
                        graph: graphWithBoth,
                        grantTickets: {
                            'cpa.test.secured': {
                                renderer: 'ticket_sec_12345',
                                agent: 'ticket_agent_67890',
                            },
                        },
                    }
                },
                async commit() {},
                async rollback() {},
            }

            const coordinator = new PluginPlatformCoordinator({
                rendererHost,
                agentHost: testAgentHost,
                mainParticipant,
                grantTicketTransport: grantTransport,
            })

            const prepared = await coordinator.prepareGeneration(graphWithBoth)
            await prepared.commit()

            expect(redeemedCalls).toEqual([
                { ticket: 'ticket_sec_12345', runtime: 'renderer' },
                { ticket: 'ticket_agent_67890', runtime: 'agent' },
            ])
            expect(capturedClient).toBeDefined()
            expect(capturedClient.has('filesystem.read')).toBe(true)
            expect(capturedClient.getHandle()).toBe('handle_for_ticket_sec_12345')

            expect(capturedAgentClient).toBeDefined()
            expect(capturedAgentClient.has('storage.kv')).toBe(true)
            expect(capturedAgentClient.getHandle()).toBe('handle_for_ticket_agent_67890')
        })
    })

    describe('Cross-Runtime Plugin Status Aggregation', () => {
        it('reflects active status for agent-only plugins when active in agent runtime', async () => {
            const agentOnlyPkg: ResolvedPluginPackage = {
                manifest: {
                    id: 'cpa.test.agent-only',
                    name: 'Agent Only Plugin',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '>=1.0.0' },
                    entries: { agent: './agent/index.ts' },
                    dependencies: {},
                    capabilities: [],
                    contributes: {
                        'tool-factory': ['test-agent-tool'],
                    },
                },
                source: { kind: 'bundled', spec: 'bundled:cpa.test.agent-only' },
                sourceRoot: '/plugins/bundled/cpa.test.agent-only',
                entries: { agent: './agent/index.ts' },
            }

            const agentDef: PluginEntryDefinition = {
                runtime: 'agent',
                activate(ctx) {
                    ctx.register({
                        kind: 'tool-factory',
                        id: 'test-agent-tool',
                        value: { name: 'test_tool' },
                    })
                },
            }

            const rendererHost = new RendererPluginRuntimeHost({
                bundledPackages: [agentOnlyPkg],
            })
            const agentHost = new AgentPluginRuntimeHost({
                bundledPackages: [agentOnlyPkg],
                defaultDefinitions: {
                    'cpa.test.agent-only': agentDef,
                },
            })

            const coordinator = new PluginPlatformCoordinator({
                rendererHost,
                agentHost,
            })

            const graph = createGraphDTO([agentOnlyPkg])
            await coordinator.activate(graph)

            // Agent host is active
            expect(agentHost.isPluginActive('cpa.test.agent-only')).toBe(true)

            // Renderer runtime runtime-kernel does NOT host agent entries directly,
            // but via coordinator / peerHost it reflects active
            expect(coordinator.isPluginActive('cpa.test.agent-only')).toBe(true)
            expect(rendererHost.isPluginActive('cpa.test.agent-only')).toBe(true)

            const summary = coordinator.getPluginSummary('cpa.test.agent-only')
            expect(summary.status).toBe('active')
            expect(summary.isCore).toBe(true)

            const allSummaries = coordinator.getPluginSummaries()
            const found = allSummaries.find((s) => s.manifest.id === 'cpa.test.agent-only')
            expect(found).toBeDefined()
            expect(found?.status).toBe('active')
        })

        it('notifies subscribers when either runtime status changes', async () => {
            const rendererHost = new RendererPluginRuntimeHost({ bundledPackages: [] })
            const agentHost = new AgentPluginRuntimeHost({ bundledPackages: [] })

            const coordinator = new PluginPlatformCoordinator({
                rendererHost,
                agentHost,
            })

            let notifiedCount = 0
            const unsub = coordinator.subscribe(() => {
                notifiedCount++
            })

            await rendererHost.activateAll()
            expect(notifiedCount).toBeGreaterThan(0)

            const prev = notifiedCount
            await agentHost.activateAll()
            expect(notifiedCount).toBeGreaterThan(prev)

            unsub()
            const current = notifiedCount
            await rendererHost.activateAll()
            expect(notifiedCount).toBe(current)
        })
    })
})

