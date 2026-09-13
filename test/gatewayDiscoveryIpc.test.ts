import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { WebSocket } from 'ws'

const ipcHandlers = new Map<string, (...args: any[]) => any>()

vi.mock('electron', () => ({
    app: {
        isPackaged: false,
        getPath: vi.fn(() => '/tmp'),
    },
    BrowserWindow: vi.fn(),
    ipcMain: {
        handle: vi.fn((channel: string, handler: (...args: any[]) => any) => {
            ipcHandlers.set(channel, handler)
        }),
        removeHandler: vi.fn((channel: string) => {
            ipcHandlers.delete(channel)
        }),
    },
}))

import { GatewayDiscoveryService } from '../src/main/services/gatewayDiscoveryService.js'
import { MainCapabilityBroker } from '../src/main/plugins/capabilities/MainCapabilityBroker.js'
import { registerCapabilityTransport } from '../src/main/ipc/registerCapabilityTransport.js'
import { createServices } from '../src/main/ipc/registerIpcHandlers.js'
import { WebServerService } from '../src/main/services/webServerService.js'
import type { DiscoveredGateway } from '@cpa/plugin-api'

describe('Gateway Discovery IPC integration', () => {
    let tmpDir: string

    beforeEach(async () => {
        ipcHandlers.clear()
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cpa-gateway-ipc-test-'))
        await fs.writeFile(path.join(tmpDir, 'index.html'), '<html><body>Mock CPA Web</body></html>')
    })

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    })

    it('dispatches gateway:discover through RPC dispatcher (handleMethod)', async () => {
        const mockGatewayService = new GatewayDiscoveryService()
        const mockGateways: DiscoveredGateway[] = [
            {
                instanceName: 'Test Gateway',
                host: 'test.local',
                port: 8317,
                addresses: ['192.168.1.50'],
                primaryAddress: '192.168.1.50',
                baseUrl: 'http://192.168.1.50:8317',
                authRequired: true,
            },
        ]
        const discoverSpy = vi.spyOn(mockGatewayService, 'discover').mockResolvedValue(mockGateways)

        const services = createServices(() => null, {
            gatewayDiscoveryService: mockGatewayService,
        })

        try {
            const res = await services.handleMethod('gateway:discover', [2000])
            expect(discoverSpy).toHaveBeenCalledWith(2000)
            expect(res).toEqual(mockGateways)
        } finally {
            await services.disposeAll()
        }
    })

    it('routes gateway:discover through capability broker when capability is granted', async () => {
        const broker = new MainCapabilityBroker()
        const mockGatewayService = new GatewayDiscoveryService()
        const mockGateways: DiscoveredGateway[] = [
            {
                instanceName: 'LAN Gateway',
                host: 'cpa-gateway.local',
                port: 8317,
                addresses: ['10.0.0.100'],
                primaryAddress: '10.0.0.100',
                baseUrl: 'http://10.0.0.100:8317',
                authRequired: false,
            },
        ]
        const discoverSpy = vi.spyOn(mockGatewayService, 'discover').mockResolvedValue(mockGateways)

        const services = createServices(() => null, {
            gatewayDiscoveryService: mockGatewayService,
        })

        const unregister = registerCapabilityTransport({
            broker,
            services,
        })

        try {
            const sender = {
                pluginId: 'cpa.test.discovery',
                senderId: 1,
                frameUrl: 'cpa-plugin://cpa.test.discovery/index.html',
                transport: 'electron' as const,
                runtime: 'renderer' as const,
            }
            const handle = broker.grant(sender, ['gateway.discover'], 1)

            const result = await broker.invoke(
                handle,
                'gateway:discover',
                [2500],
                sender,
            )

            expect(result).toEqual(mockGateways)
            expect(discoverSpy).toHaveBeenCalledWith(2500)
        } finally {
            unregister()
            await services.disposeAll()
        }
    })

    it('rejects gateway:discover capability invocation if capability is not granted', async () => {
        const broker = new MainCapabilityBroker()
        const mockGatewayService = new GatewayDiscoveryService()
        const services = createServices(() => null, {
            gatewayDiscoveryService: mockGatewayService,
        })
        const unregister = registerCapabilityTransport({
            broker,
            services,
        })

        try {
            const sender = {
                pluginId: 'cpa.unauthorized.plugin',
                senderId: 2,
                frameUrl: 'cpa-plugin://cpa.unauthorized.plugin/index.html',
                transport: 'electron' as const,
                runtime: 'renderer' as const,
            }
            // Grant unrelated capability
            const handle = broker.grant(sender, ['filesystem.read'], 1)

            await expect(
                broker.invoke(handle, 'gateway:discover', [2000], sender),
            ).rejects.toThrow(/lacks capability gateway\.discover/)
        } finally {
            unregister()
            await services.disposeAll()
        }
    })

    it('includes gateway.discover in official platform handle bootstrap capabilities', async () => {
        const broker = new MainCapabilityBroker()
        const mockGatewayService = new GatewayDiscoveryService()
        const mockGateways: DiscoveredGateway[] = [
            {
                instanceName: 'Platform Gateway',
                host: 'platform.local',
                port: 8317,
                addresses: ['192.168.2.10'],
                primaryAddress: '192.168.2.10',
                baseUrl: 'http://192.168.2.10:8317',
                authRequired: true,
            },
        ]
        vi.spyOn(mockGatewayService, 'discover').mockResolvedValue(mockGateways)

        const fakeWindow = {
            isDestroyed: () => false,
            webContents: {
                id: 42,
                on: vi.fn(),
                once: vi.fn(),
                removeListener: vi.fn(),
            },
        } as any

        const services = createServices(() => null, {
            gatewayDiscoveryService: mockGatewayService,
        })

        const unregister = registerCapabilityTransport({
            broker,
            services,
            getMainWindow: () => fakeWindow,
            trustedUrls: ['cpa://app/index.html'],
        })

        try {
            const bootstrapHandler = ipcHandlers.get('cpa:capability:bootstrap')
            expect(bootstrapHandler).toBeDefined()

            const fakeSender = fakeWindow.webContents
            const fakeEvent = {
                sender: fakeSender,
                senderFrame: {
                    parent: null,
                    routingId: 1,
                    url: 'cpa://app/index.html',
                },
            } as any

            const response = await bootstrapHandler(fakeEvent)
            expect(response.ok).toBe(true)
            const handle = response.value

            // The host handle should be authorized to invoke gateway:discover
            const invokeResult = await broker.invoke(
                handle,
                'gateway:discover',
                [1800],
                {
                    pluginId: 'desktop-main',
                    senderId: 42,
                    frameUrl: 'cpa://app/index.html',
                    transport: 'electron',
                    runtime: 'renderer',
                    documentId: '42:1',
                    processId: undefined,
                    routingId: 1,
                },
            )

            expect(invokeResult).toEqual(mockGateways)
        } finally {
            unregister()
            await services.disposeAll()
        }
    })

    it('dispatches gateway:discover via WebServer HTTP RPC (/api/rpc) using unified dispatcher', async () => {
        const mockGatewayService = new GatewayDiscoveryService()
        const mockGateways: DiscoveredGateway[] = [
            {
                instanceName: 'Web Gateway',
                host: 'web.local',
                port: 8317,
                addresses: ['172.16.0.5'],
                primaryAddress: '172.16.0.5',
                baseUrl: 'http://172.16.0.5:8317',
                authRequired: false,
            },
        ]
        const discoverSpy = vi.spyOn(mockGatewayService, 'discover').mockResolvedValue(mockGateways)

        const services = createServices(() => null, {
            gatewayDiscoveryService: mockGatewayService,
        })

        const webServer = new WebServerService({ distDir: tmpDir })
        webServer.setRpcDispatcher(services.handleMethod)
        const status = await webServer.start({ host: '127.0.0.1', port: 0 })

        try {
            // 1. Normal discovery via HTTP POST /api/rpc
            const rpcResponse = await fetch(`http://127.0.0.1:${status.port}/api/rpc`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id: 'test-rpc-1',
                    method: 'gateway:discover',
                    args: [1500],
                }),
            })

            expect(rpcResponse.status).toBe(200)
            const json = await rpcResponse.json()
            expect(json.id).toBe('test-rpc-1')
            expect(json.result).toEqual(mockGateways)
            expect(discoverSpy).toHaveBeenCalledWith(1500)

            // 2. Error propagation via unified transport
            discoverSpy.mockRejectedValueOnce(new Error('Network scan failed'))
            const errorResponse = await fetch(`http://127.0.0.1:${status.port}/api/rpc`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id: 'test-rpc-err',
                    method: 'gateway:discover',
                    args: [1000],
                }),
            })

            expect(errorResponse.status).toBe(200)
            const errorJson = await errorResponse.json()
            expect(errorJson.id).toBe('test-rpc-err')
            expect(errorJson.error).toContain('Network scan failed')
        } finally {
            await webServer.stop()
            webServer.dispose()
            await services.disposeAll()
        }
    })

    it('dispatches gateway:discover via WebServer WebSocket RPC using unified dispatcher', async () => {
        const mockGatewayService = new GatewayDiscoveryService()
        const mockGateways: DiscoveredGateway[] = [
            {
                instanceName: 'WS Gateway',
                host: 'ws.local',
                port: 8317,
                addresses: ['10.1.1.5'],
                primaryAddress: '10.1.1.5',
                baseUrl: 'http://10.1.1.5:8317',
                authRequired: true,
            },
        ]
        const discoverSpy = vi.spyOn(mockGatewayService, 'discover').mockResolvedValue(mockGateways)

        const services = createServices(() => null, {
            gatewayDiscoveryService: mockGatewayService,
        })

        const webServer = new WebServerService({ distDir: tmpDir })
        webServer.setRpcDispatcher(services.handleMethod)
        const status = await webServer.start({ host: '127.0.0.1', port: 0 })

        try {
            const ws = new WebSocket(`ws://127.0.0.1:${status.port}/api/ws`)

            await new Promise<void>((resolve, reject) => {
                ws.once('open', () => resolve())
                ws.once('error', reject)
            })

            const waitForMessage = (expectedId: string) => {
                return new Promise<any>((resolve) => {
                    const listener = (data: any) => {
                        const parsed = JSON.parse(data.toString())
                        if (parsed.id === expectedId) {
                            ws.off('message', listener)
                            resolve(parsed)
                        }
                    }
                    ws.on('message', listener)
                })
            }

            // 1. Normal discovery via WebSocket
            const responsePromise = waitForMessage('ws-rpc-1')
            ws.send(JSON.stringify({
                type: 'rpc',
                id: 'ws-rpc-1',
                method: 'gateway:discover',
                args: [1200],
            }))

            const response = await responsePromise
            expect(response.type).toBe('rpc_result')
            expect(response.result).toEqual(mockGateways)
            expect(discoverSpy).toHaveBeenCalledWith(1200)

            // 2. Error propagation via WebSocket
            discoverSpy.mockRejectedValueOnce(new Error('WebSocket discovery timed out'))
            const errorPromise = waitForMessage('ws-rpc-err')
            ws.send(JSON.stringify({
                type: 'rpc',
                id: 'ws-rpc-err',
                method: 'gateway:discover',
                args: [1000],
            }))

            const errorResponse = await errorPromise
            expect(errorResponse.type).toBe('rpc_error')
            expect(errorResponse.id).toBe('ws-rpc-err')
            expect(errorResponse.error).toContain('WebSocket discovery timed out')

            ws.close()
        } finally {
            await webServer.stop()
            webServer.dispose()
            await services.disposeAll()
        }
    })

    it('wires gatewayDiscoveryService through createServices', async () => {
        const mockGatewayService = new GatewayDiscoveryService()
        const discoverSpy = vi.spyOn(mockGatewayService, 'discover').mockResolvedValue([])

        const services = createServices(() => null, {
            gatewayDiscoveryService: mockGatewayService,
        })

        expect(services.gatewayDiscoveryService).toBe(mockGatewayService)

        const res = await services.handleMethod('gateway:discover', [2200])
        expect(res).toEqual([])
        expect(discoverSpy).toHaveBeenCalledWith(2200)

        await services.disposeAll()
    })
})
