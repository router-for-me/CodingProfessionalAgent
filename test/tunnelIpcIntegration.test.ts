import { describe, it, expect, vi, beforeEach } from 'vitest'

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

import {
    HOST_SERVICE_TOKENS,
    TUNNEL_MANAGE_CAPABILITY,
    TUNNEL_READ_CAPABILITY,
    TunnelServiceToken,
} from '@cpa/plugin-api'
import {
    METHOD_CAPABILITY_MAP,
    RENDERER_CAPABILITY_DESCRIPTORS,
    rendererFacingDescriptorNames,
} from '../src/shared/capabilityDescriptors.js'
import { MainCapabilityBroker } from '../src/main/plugins/capabilities/MainCapabilityBroker.js'
import { registerCapabilityTransport } from '../src/main/ipc/registerCapabilityTransport.js'
import { createServices } from '../src/main/ipc/registerIpcHandlers.js'

describe('CLIProxyAPI Tunnel IPC & Capability Broker Integration', () => {
    beforeEach(() => {
        ipcHandlers.clear()
    })

    it('registers TunnelGetStatus and TunnelSyncConfig in capability descriptors and service tokens', () => {
        expect(TUNNEL_READ_CAPABILITY).toBe('tunnel.read')
        expect(TUNNEL_MANAGE_CAPABILITY).toBe('tunnel.manage')
        expect(TunnelServiceToken.id).toBe('host.services.tunnel')
        expect(HOST_SERVICE_TOKENS.tunnel).toBe(TunnelServiceToken)

        expect(rendererFacingDescriptorNames).toContain('TunnelGetStatus')
        expect(rendererFacingDescriptorNames).toContain('TunnelSyncConfig')
        expect(METHOD_CAPABILITY_MAP.get('tunnel:getStatus')).toBe('tunnel.read')
        expect(METHOD_CAPABILITY_MAP.get('tunnel:syncConfig')).toBe('tunnel.manage')

        const getDesc = RENDERER_CAPABILITY_DESCRIPTORS.find((d) => d.name === 'TunnelGetStatus')
        expect(getDesc).toEqual({
            name: 'TunnelGetStatus',
            method: 'tunnel:getStatus',
            capability: 'tunnel.read',
        })
    })

    it('routes tunnel:getStatus, tunnel:syncConfig, and tunnel:status-changed through MainCapabilityBroker and rejects unauthorized handles', async () => {
        const broker = new MainCapabilityBroker()
        const mockRuntimeHost = {
            capabilityBroker: broker,
            contributionRegistry: undefined,
            eventBus: undefined,
            dispose: vi.fn(),
        } as any

        const services = createServices(() => null, {
            pluginRuntimeHost: mockRuntimeHost,
        })
        const unregister = registerCapabilityTransport({
            broker,
            services,
        })

        try {
            const authorizedContext = {
                pluginId: 'cpa.core.settings',
                senderId: 101,
                frameUrl: 'file:///index.html',
                transport: 'electron' as const,
                runtime: 'renderer' as const,
            }
            const handle = broker.grant(authorizedContext, ['tunnel.*'], 1)

            const initial = (await broker.invoke(
                handle,
                'tunnel:getStatus',
                [],
                authorizedContext,
            )) as any
            expect(initial.phase).toBe('stopped')
            expect(initial.enabled).toBe(false)

            const liveStatuses: any[] = []
            const unsub = broker.subscribe(
                handle,
                'tunnel:status-changed',
                (payload) => {
                    liveStatuses.push(payload)
                },
                authorizedContext,
            )

            const synced = (await broker.invoke(
                handle,
                'tunnel:syncConfig',
                [{ enabled: true, baseUrl: '', apiKey: '' }],
                authorizedContext,
            )) as any
            expect(synced.phase).toBe('error')
            expect(synced.errorCode).toBe('missing_config')
            expect(liveStatuses.length).toBeGreaterThanOrEqual(1)
            expect(liveStatuses[liveStatuses.length - 1].errorCode).toBe('missing_config')

            unsub()

            // tunnel.manage must NOT be able to clear WebServer password via tunnel:syncConfig
            const configureSpy = vi.spyOn(services.webServerService, 'configure')
            await broker.invoke(
                handle,
                'tunnel:syncConfig',
                [{ enabled: false, baseUrl: '', apiKey: '', webPassword: '' }],
                authorizedContext,
            )
            expect(configureSpy).not.toHaveBeenCalled()

            // Unauthorized handle must be rejected
            const unauthContext = {
                pluginId: 'cpa.untrusted.plugin',
                senderId: 102,
                frameUrl: 'file:///index.html',
                transport: 'electron' as const,
                runtime: 'renderer' as const,
            }
            const unauthHandle = broker.grant(unauthContext, ['sessions.read'], 1)
            await expect(
                broker.invoke(unauthHandle, 'tunnel:syncConfig', [{ enabled: false, baseUrl: '', apiKey: '' }], unauthContext),
            ).rejects.toThrow(/capability/i)
        } finally {
            unregister()
            await services.disposeAll()
        }
    })
})
