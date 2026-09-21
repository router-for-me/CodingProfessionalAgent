import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { MainCapabilityBroker } from '../src/main/plugins/capabilities/MainCapabilityBroker.js'
import { createServices } from '../src/main/ipc/registerIpcHandlers.js'
import { WebServerService } from '../src/main/services/webServerService.js'

describe('Web Capability Grant and Invoke Integration', () => {
    let tmpDir: string
    let broker: MainCapabilityBroker
    let services: any

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cpa-web-cap-test-'))
        await fs.writeFile(path.join(tmpDir, 'index.html'), '<html><body>Web</body></html>')

        broker = new MainCapabilityBroker()
        broker.register({
            method: 'kvstore:get',
            capability: 'storage.kv',
            validate: (args: unknown[]) => {
                if (!Array.isArray(args)) throw new Error('Args must be an array')
            },
            invoke: async (ctx, key: string) => {
                return { key, runtime: ctx.runtime, pluginId: ctx.pluginId, success: true }
            },
        })

        const mockRuntimeHost: any = {
            capabilityBroker: broker,
            contributionRegistry: null,
            eventBus: null,
            dispose: vi.fn(),
        }

        services = createServices(() => null, {
            isDebug: true,
            homeDir: tmpDir,
            pluginRuntimeHost: mockRuntimeHost,
        })
    })

    afterEach(async () => {
        if (services) {
            await services.disposeAll()
        }
        await fs.rm(tmpDir, { recursive: true, force: true })
    })

    it('successfully redeems agent runtime grant ticket and invokes capability in web mode', async () => {
        const webServer = services.webServerService as WebServerService
        const dispatcher = webServer.getRpcDispatcher()
        expect(dispatcher).toBeDefined()

        const clientId = 'client_browser_test_agent'
        const agentTicket = broker.createGrantTicket({
            pluginId: 'cpa.core.web-search',
            runtime: 'agent',
            generation: 1,
            capabilities: ['storage.kv'],
            transport: 'web',
            clientId,
        })

        // Web RPC context with clientId
        const rpcContext: any = {
            clientId,
            transport: 'web',
            documentId: `web:${clientId}`,
        }

        // 1. Redeem agent ticket without explicit runtime in args
        const grantRes1 = (await dispatcher!(
            'capability:grant',
            [{ ticket: agentTicket }],
            rpcContext,
        )) as any

        expect(grantRes1).toEqual({
            ok: true,
            value: expect.stringMatching(/^cap_/),
        })

        const handle1 = grantRes1.value

        // 2. Invoke capability with redeemed handle
        const invokeRes1 = (await dispatcher!(
            'capability:invoke',
            [{ handle: handle1, method: 'kvstore:get', args: ['web_search_settings'] }],
            rpcContext,
        )) as any

        expect(invokeRes1).toEqual({
            key: 'web_search_settings',
            runtime: 'agent',
            pluginId: 'cpa.core.web-search',
            success: true,
        })
    })

    it('successfully redeems agent runtime grant ticket with explicit runtime in args', async () => {
        const webServer = services.webServerService as WebServerService
        const dispatcher = webServer.getRpcDispatcher()

        const clientId = 'client_browser_test_explicit'
        const agentTicket = broker.createGrantTicket({
            pluginId: 'cpa.core.web-search',
            runtime: 'agent',
            generation: 1,
            capabilities: ['storage.kv'],
            transport: 'web',
            clientId,
        })

        const rpcContext: any = {
            clientId,
            transport: 'web',
            documentId: `web:${clientId}`,
        }

        const grantRes = (await dispatcher!(
            'capability:grant',
            [{ ticket: agentTicket, runtime: 'agent' }],
            rpcContext,
        )) as any

        expect(grantRes).toEqual({
            ok: true,
            value: expect.stringMatching(/^cap_/),
        })

        const handle = grantRes.value

        const invokeRes = (await dispatcher!(
            'capability:invoke',
            [{ handle, method: 'kvstore:get', args: ['config'] }],
            rpcContext,
        )) as any

        expect(invokeRes).toEqual({
            key: 'config',
            runtime: 'agent',
            pluginId: 'cpa.core.web-search',
            success: true,
        })
    })

    it('rejects redeeming agent runtime ticket when sender claims mismatched runtime', async () => {
        const webServer = services.webServerService as WebServerService
        const dispatcher = webServer.getRpcDispatcher()

        const clientId = 'client_browser_test_mismatch'
        const agentTicket = broker.createGrantTicket({
            pluginId: 'cpa.core.web-search',
            runtime: 'agent',
            generation: 1,
            capabilities: ['storage.kv'],
            transport: 'web',
            clientId,
        })

        const rpcContext: any = {
            clientId,
            transport: 'web',
            documentId: `web:${clientId}`,
        }

        await expect(
            dispatcher!(
                'capability:grant',
                [{ ticket: agentTicket, runtime: 'renderer' }],
                rpcContext,
            ),
        ).rejects.toThrow('Capability grant ticket runtime mismatch')
    })
})
