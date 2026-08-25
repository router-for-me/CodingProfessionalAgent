import { describe, it, expect, vi } from 'vitest'
import type {
    PluginManifest,
    ResolvedPluginGraphDTO,
    ResolvedPluginPackage,
} from '@cpa/plugin-api'
import { MainPluginRuntimeHost } from '../src/main/plugins/runtime/MainPluginRuntimeHost.js'
import { MainPluginActivationCoordinator } from '../src/main/plugins/runtime/MainPluginActivationCoordinator.js'
import { createServices } from '../src/main/ipc/registerIpcHandlers.js'

function createPkg(
    id: string,
    options?: {
        capabilities?: string[]
        entries?: { main?: string; renderer?: string; agent?: string }
    },
): ResolvedPluginPackage {
    const manifest: PluginManifest = {
        id,
        name: id,
        version: '1.0.0',
        apiVersion: '1.0.0',
        engines: { cpa: '>=1.0.0' },
        criticality: 'required',
        entries: options?.entries ?? { renderer: './renderer.js', agent: './agent.js' },
        dependencies: {},
        capabilities: options?.capabilities ?? ['filesystem.read'],
        contributes: {},
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
        revision: 'rev_reload_recovery_test',
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

describe('Renderer Reload Grant Recovery (Task 7)', () => {
    it('initial startup issues grant tickets in prepared phase, commits, and enables full capability invocation', async () => {
        const pkg = createPkg('cpa.core.file-viewer', { capabilities: ['filesystem.read'] })
        const graph = createGraphDTO([pkg])

        const host = new MainPluginRuntimeHost({ bundledPackages: [pkg] })
        host.capabilityBroker.register({
            method: 'native:readFile',
            capability: 'filesystem.read',
            validate: (args) => {
                if (typeof args[0] !== 'string') throw new Error('Path must be string')
            },
            invoke: async (_ctx, filePath) => `file contents of ${filePath}`,
        })

        const coordinator = new MainPluginActivationCoordinator({ host, graph })
        await coordinator.stage()

        const services = createServices(() => null, {
            pluginRuntimeHost: host,
            pluginActivationCoordinator: coordinator,
        } as any)

        // 1. Initial Renderer document 1 calls plugins:getPreparedState
        const doc1Context = {
            pluginId: 'desktop-main',
            senderId: 1,
            frameUrl: 'http://localhost:5173/',
            transport: 'electron' as const,
            processId: 2001,
            routingId: 1,
            documentId: '1:2001:1',
            clientId: 'desktop-main',
        }

        const state1 = (await services.handleMethod('plugins:getPreparedState', [], doc1Context)) as any
        expect(state1?.phase).toBe('prepared')
        expect(state1?.grantTickets?.['cpa.core.file-viewer']?.renderer).toMatch(/^ticket_/)
        const ticket1 = state1.grantTickets['cpa.core.file-viewer'].renderer

        // 2. Document 1 redeems grant ticket
        const redeemContext1 = {
            pluginId: 'cpa.core.file-viewer',
            senderId: 1,
            frameUrl: 'http://localhost:5173/',
            transport: 'electron' as const,
            processId: 2001,
            routingId: 1,
            documentId: '1:2001:1',
            runtime: 'renderer' as const,
        }
        const handle1 = host.capabilityBroker.redeemGrantTicket(ticket1, redeemContext1)
        expect(handle1).toBeDefined()

        // 3. Commit generation 1
        await services.handleMethod('plugins:commitGeneration', [graph.revision, 1], doc1Context)
        expect(coordinator.getGeneration()).toBe(1)

        // 4. Document 1 can invoke native:readFile capability
        const readResult1 = await host.capabilityBroker.invoke(
            handle1,
            'native:readFile',
            ['/test.txt'],
            redeemContext1,
        )
        expect(readResult1).toBe('file contents of /test.txt')

        // 5. Document 1 calls plugins:getPreparedState again: receives grantTickets: null
        const state1Again = (await services.handleMethod('plugins:getPreparedState', [], doc1Context)) as any
        expect(state1Again?.phase).toBe('active')
        expect(state1Again?.grantTickets).toBeNull()
    })

    it('recovers capability handles after renderer reload in active phase', async () => {
        const pkg = createPkg('cpa.core.editor', { capabilities: ['filesystem.read', 'filesystem.write'] })
        const graph = createGraphDTO([pkg])

        const host = new MainPluginRuntimeHost({ bundledPackages: [pkg] })
        host.capabilityBroker.register({
            method: 'native:readFile',
            capability: 'filesystem.read',
            validate: () => {},
            invoke: async (_ctx, p) => `read:${p}`,
        })

        const coordinator = new MainPluginActivationCoordinator({ host, graph })
        await coordinator.stage()
        await coordinator.commitPrepared(graph.revision, 1)

        const services = createServices(() => null, {
            pluginRuntimeHost: host,
            pluginActivationCoordinator: coordinator,
        } as any)

        // Renderer reloads: Fresh document (doc 2) with new routingId
        const reloadDocContext = {
            pluginId: 'desktop-main',
            senderId: 1,
            frameUrl: 'http://localhost:5173/',
            transport: 'electron' as const,
            processId: 2001,
            routingId: 2,
            documentId: '1:2001:2',
            clientId: 'desktop-main',
        }

        // 1. Reloaded document requests state
        const reloadState = (await services.handleMethod('plugins:getPreparedState', [], reloadDocContext)) as any
        expect(reloadState?.phase).toBe('active')
        expect(reloadState?.generation).toBe(1)
        expect(reloadState?.grantTickets?.['cpa.core.editor']?.renderer).toMatch(/^ticket_/)
        const reloadTicket = reloadState.grantTickets['cpa.core.editor'].renderer

        // 2. Reloaded document redeems ticket
        const reloadRedeemContext = {
            pluginId: 'cpa.core.editor',
            senderId: 1,
            frameUrl: 'http://localhost:5173/',
            transport: 'electron' as const,
            processId: 2001,
            routingId: 2,
            documentId: '1:2001:2',
            runtime: 'renderer' as const,
        }
        const reloadHandle = host.capabilityBroker.redeemGrantTicket(reloadTicket, reloadRedeemContext)
        expect(reloadHandle).toBeDefined()

        // 3. Reloaded document can successfully invoke capabilities
        const result = await host.capabilityBroker.invoke(
            reloadHandle,
            'native:readFile',
            ['/file.ts'],
            reloadRedeemContext,
        )
        expect(result).toBe('read:/file.ts')

        // 4. Reloaded document second call returns grantTickets: null
        const secondState = (await services.handleMethod('plugins:getPreparedState', [], reloadDocContext)) as any
        expect(secondState?.phase).toBe('active')
        expect(secondState?.grantTickets).toBeNull()
    })

    it('rejects redeeming tickets with wrong document/frame context', async () => {
        const pkg = createPkg('cpa.core.secure', { capabilities: ['filesystem.read'] })
        const graph = createGraphDTO([pkg])

        const host = new MainPluginRuntimeHost({ bundledPackages: [pkg] })
        const coordinator = new MainPluginActivationCoordinator({ host, graph })
        await coordinator.stage()
        await coordinator.commitPrepared(graph.revision, 1)

        const services = createServices(() => null, {
            pluginRuntimeHost: host,
            pluginActivationCoordinator: coordinator,
        } as any)

        // Document A requests tickets
        const docAContext = {
            pluginId: 'desktop-main',
            senderId: 1,
            frameUrl: 'http://localhost:5173/',
            transport: 'electron' as const,
            processId: 3001,
            routingId: 10,
            documentId: '1:3001:10',
            clientId: 'desktop-main',
        }
        const stateA = (await services.handleMethod('plugins:getPreparedState', [], docAContext)) as any
        const ticketA = stateA.grantTickets['cpa.core.secure'].renderer

        // Document B attempts to redeem Document A's ticket: MUST be rejected
        const docBRedeemContext = {
            pluginId: 'cpa.core.secure',
            senderId: 1,
            frameUrl: 'http://localhost:5173/',
            transport: 'electron' as const,
            processId: 3001,
            routingId: 20, // Different routingId
            documentId: '1:3001:20',
            runtime: 'renderer' as const,
        }

        expect(() => host.capabilityBroker.redeemGrantTicket(ticketA, docBRedeemContext)).toThrow(
            /sender mismatch/i,
        )
    })
})
