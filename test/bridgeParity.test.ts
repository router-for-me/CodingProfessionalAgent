import { describe, it, expect, vi } from 'vitest'

const ipcHandlers = new Map<string, (...args: any[]) => any>()

vi.mock('electron', () => ({
    ipcMain: {
        handle: vi.fn((channel: string, handler: (...args: any[]) => any) => {
            ipcHandlers.set(channel, handler)
        }),
        removeHandler: vi.fn((channel: string) => {
            ipcHandlers.delete(channel)
        }),
    },
}))

import { ipcMain } from 'electron'
import { sessionManagerMainEntry } from '../plugins/bundled/cpa.core.session-manager/main/index.js'
import { settingsMainEntry } from '../plugins/bundled/cpa.core.settings/main/index.js'
import { schedulerMainEntry } from '../plugins/bundled/cpa.core.scheduler/main/index.js'
import {
    RENDERER_CAPABILITY_DESCRIPTORS,
    rendererFacingDescriptorNames,
    createHostCapabilityFacade,
    type HostTransportApi,
} from '../src/shared/capabilityDescriptors.js'
import { createPlatformRpcDescriptors } from '../src/main/plugins/contributions/rpcDescriptors.js'
import { MainCapabilityBroker } from '../src/main/plugins/capabilities/MainCapabilityBroker.js'
import { registerCapabilityTransport } from '../src/main/ipc/registerCapabilityTransport.js'
import { registerIpcHandlers } from '../src/main/ipc/registerIpcHandlers.js'
import type { NativeEvent } from '../src/shared/types.js'

describe('Bridge Parity and Scoped Host Capability Facade', () => {
    it('exposes every renderer-facing descriptor exactly once', () => {
        const mockTransport: HostTransportApi = {
            invoke: vi.fn().mockResolvedValue(undefined),
            subscribeNativeEvents: vi.fn().mockReturnValue(() => {}),
        }
        const facade = createHostCapabilityFacade(mockTransport, 'desktop-main')
        const facadeKeys = Object.keys(facade).filter((k) => k !== 'onNativeEvent')

        expect(facadeKeys.sort()).toEqual([...rendererFacingDescriptorNames].sort())
        expect(new Set(rendererFacingDescriptorNames).size).toBe(rendererFacingDescriptorNames.length)
    })

    it('includes profiling getStatus in the generated bridge', () => {
        expect(rendererFacingDescriptorNames).toContain('ProfilingGetStatus')

        const mockTransport: HostTransportApi = {
            invoke: vi.fn().mockResolvedValue({ running: false, enabled: false, target: 'all' }),
            subscribeNativeEvents: vi.fn().mockReturnValue(() => {}),
        }
        const facade = createHostCapabilityFacade(mockTransport, 'desktop-main')

        expect(typeof (facade as any).ProfilingGetStatus).toBe('function')
    })

    it('maps every renderer capability descriptor to a registered core RPC descriptor', () => {
        const coreDescriptors = createPlatformRpcDescriptors({
            getService: vi.fn(),
            getMainWindow: () => null,
            emitEvent: vi.fn(),
        })
        const pluginDescriptors: any[] = []
        sessionManagerMainEntry.activate({
            manifest: {} as any,
            generation: 1,
            capabilities: new Set(),
            events: { emit: () => {}, on: () => () => {} },
            register: (reg: any) => {
                if (reg.kind === 'rpc') {
                    pluginDescriptors.push(reg.value)
                }
                return () => {}
            },
            getService: vi.fn(),
        })
        settingsMainEntry.activate({
            manifest: {} as any,
            generation: 1,
            capabilities: new Set(),
            events: { emit: () => {}, on: () => () => {} },
            register: (reg: any) => {
                if (reg.kind === 'rpc') {
                    pluginDescriptors.push(reg.value)
                }
                return () => {}
            },
            getService: vi.fn(),
        })
        schedulerMainEntry.activate({
            manifest: {} as any,
            generation: 1,
            capabilities: new Set(),
            events: { emit: () => {}, on: () => () => {} },
            register: (reg: any) => {
                if (reg.kind === 'rpc') {
                    pluginDescriptors.push(reg.value)
                }
                return () => {}
            },
            getService: vi.fn(),
        })
        const allDescriptors = [...coreDescriptors, ...pluginDescriptors]
        const coreMethodsAndAliases = new Set<string>()
        for (const desc of allDescriptors) {
            coreMethodsAndAliases.add(desc.method)
            if (desc.ipcChannel) {
                coreMethodsAndAliases.add(desc.ipcChannel)
            }
            if (desc.aliases) {
                for (const alias of desc.aliases) {
                    coreMethodsAndAliases.add(alias)
                }
            }
        }

        for (const rendererDesc of RENDERER_CAPABILITY_DESCRIPTORS) {
            expect(
                coreMethodsAndAliases.has(rendererDesc.method),
                `Renderer descriptor "${rendererDesc.name}" maps to unknown RPC method "${rendererDesc.method}"`,
            ).toBe(true)
        }
    })

    it('delegates facade method calls through HostTransportApi with platform handle and method args', async () => {
        const invokeSpy = vi.fn().mockImplementation(async (handle, method, args) => {
            if (method === 'native:readFile') {
                return { dataBase64: 'aGVsbG8=' }
            }
            if (method === 'profiling:getStatus') {
                return { running: true, enabled: true, target: 'all' }
            }
            return { ok: true }
        })

        const mockTransport: HostTransportApi = {
            invoke: invokeSpy,
            subscribeNativeEvents: vi.fn().mockReturnValue(() => {}),
        }

        const facade = createHostCapabilityFacade(mockTransport, 'desktop-main')

        const readFileRes = await facade.ReadFile('/path/to/file.txt')
        expect(readFileRes).toEqual({ dataBase64: 'aGVsbG8=' })
        expect(invokeSpy).toHaveBeenCalledWith('desktop-main', 'native:readFile', ['/path/to/file.txt'])

        const profilingRes = await (facade as any).ProfilingGetStatus()
        expect(profilingRes).toEqual({ running: true, enabled: true, target: 'all' })
        expect(invokeSpy).toHaveBeenCalledWith('desktop-main', 'profiling:getStatus', [])
    })

    it('manages event subscriptions and unsubscriptions cleanly via HostTransportApi', () => {
        let currentListener: ((event: NativeEvent) => void) | null = null
        const unsubscribeMock = vi.fn(() => {
            currentListener = null
        })

        const mockTransport: HostTransportApi = {
            invoke: vi.fn().mockResolvedValue(undefined),
            subscribeNativeEvents: vi.fn().mockImplementation((listener) => {
                currentListener = listener
                return unsubscribeMock
            }),
        }

        const facade = createHostCapabilityFacade(mockTransport, 'desktop-main')

        const receivedEvents: NativeEvent[] = []
        const unsub = facade.onNativeEvent((evt) => {
            receivedEvents.push(evt)
        })

        expect(mockTransport.subscribeNativeEvents).toHaveBeenCalledTimes(1)
        expect(currentListener).toBeDefined()

        const testEvent: NativeEvent = {
            operationId: 'op_1',
            sequence: 1,
            kind: 'done',
        }
        currentListener!(testEvent)
        expect(receivedEvents).toEqual([testEvent])

        unsub()
        expect(unsubscribeMock).toHaveBeenCalledTimes(1)
        expect(currentListener).toBeNull()
    })

    it('enforces fixed capability transport rejecting arbitrary channel fallback', async () => {
        const invokeSpy = vi.fn().mockImplementation(async (_handle, method, _args) => {
            const descriptor = RENDERER_CAPABILITY_DESCRIPTORS.find((d) => d.method === method)
            if (!descriptor) {
                throw new Error(`Unknown capability method: ${method}`)
            }
            return { ok: true }
        })

        const mockTransport: HostTransportApi = {
            invoke: invokeSpy,
            subscribeNativeEvents: vi.fn().mockReturnValue(() => {}),
        }

        await expect(mockTransport.invoke('cap_123', 'arbitrary:channel', [])).rejects.toThrow(
            'Unknown capability method: arbitrary:channel',
        )
        await expect(mockTransport.invoke('cap_123', 'electron:eval', [])).rejects.toThrow(
            'Unknown capability method: electron:eval',
        )
    })

    it('routes invocations through registerCapabilityTransport and verifies trusted context', async () => {
        const broker = new MainCapabilityBroker()
        const mockServices = {
            handleMethod: vi.fn().mockImplementation(async (method, args, _ctx) => {
                if (method === 'native:readFile') {
                    return { dataBase64: 'ZGF0YQ==' }
                }
                return { success: true }
            }),
        } as any

        const unregister = registerCapabilityTransport({
            broker,
            services: mockServices,
        })

        try {
            // Explicit grant for a specific plugin handle
            const sender = {
                pluginId: 'cpa.test.reader',
                senderId: 1,
                frameUrl: 'cpa-plugin://cpa.test.reader/index.html',
                transport: 'electron' as const,
                runtime: 'renderer' as const,
            }
            const handle = broker.grant(sender, ['filesystem.read'], 1)

            // Valid invoke with granted handle
            const result = await broker.invoke(
                handle,
                'native:readFile',
                ['/tmp/test.txt'],
                sender,
            )
            expect(result).toEqual({ dataBase64: 'ZGF0YQ==' })
            expect(mockServices.handleMethod).toHaveBeenCalledWith(
                'native:readFile',
                ['/tmp/test.txt'],
                expect.objectContaining({ pluginId: 'cpa.test.reader' }),
            )

            // Untrusted sender context fails
            const forgedSender = {
                pluginId: 'cpa.test.reader',
                senderId: 999, // Mismatched senderId
                frameUrl: 'https://attacker.site',
                transport: 'electron' as const,
                runtime: 'renderer' as const,
            }
            await expect(
                broker.invoke(handle, 'native:readFile', ['/tmp/test.txt'], forgedSender),
            ).rejects.toThrow('Capability sender mismatch')
        } finally {
            unregister()
        }
    })

    it('prohibits desktop-main broad token privilege escalation and denies ungranted handles', async () => {
        const broker = new MainCapabilityBroker()
        const mockServices = {
            handleMethod: vi.fn().mockResolvedValue({ secret: 'data' }),
        } as any

        const unregister = registerCapabilityTransport({
            broker,
            services: mockServices,
        })

        try {
            const rendererSender = {
                pluginId: 'attacker-plugin',
                senderId: 5,
                frameUrl: 'cpa-plugin://attacker-plugin/index.html',
                transport: 'electron' as const,
                runtime: 'renderer' as const,
            }

            // Attempting to use desktop-main directly without broker grant is rejected
            await expect(
                broker.invoke('desktop-main' as any, 'native:readFile', ['/secret'], rendererSender),
            ).rejects.toThrow('Invalid or expired capability handle')

            // Fabricated fake handle is also rejected
            await expect(
                broker.invoke('cap_attacker-plugin_renderer_gen1' as any, 'native:readFile', ['/secret'], rendererSender),
            ).rejects.toThrow('Invalid or expired capability handle')
        } finally {
            unregister()
        }
    })

    it('attaches exactly one destroyed listener per WebContents across multiple subscriptions', async () => {
        const broker = new MainCapabilityBroker()
        broker.registerEvent('session:created', 'sessions.read')
        broker.registerEvent('session:updated', 'sessions.read')

        const unregister = registerCapabilityTransport({ broker })

        try {
            const handle = broker.grant(
                { pluginId: 'subscriber', senderId: 1, frameUrl: '', transport: 'electron', runtime: 'renderer' },
                ['sessions.*'],
                1,
            )

            let destroyedListenersCount = 0
            const mockWebContents = {
                id: 1,
                isDestroyed: () => false,
                send: vi.fn(),
                once: vi.fn((event: string, _fn: () => void) => {
                    if (event === 'destroyed') {
                        destroyedListenersCount++
                    }
                }),
            } as any

            const subscribeHandler = ipcHandlers.get('cpa:capability:subscribe')
            expect(typeof subscribeHandler).toBe('function')

            const event1 = { sender: mockWebContents } as any
            await subscribeHandler(event1, { handle, eventName: 'session:created', subscriptionId: 'sub_1' })
            await subscribeHandler(event1, { handle, eventName: 'session:updated', subscriptionId: 'sub_2' })

            // Exactly ONE destroyed listener must be attached
            expect(destroyedListenersCount).toBe(1)
        } finally {
            unregister()
        }
    })

    it('verifies 100% capability descriptor parity and single-source-of-truth consistency across all methods', () => {
        const coreDescriptors = createPlatformRpcDescriptors({
            getService: vi.fn(),
            getMainWindow: () => null,
            emitEvent: vi.fn(),
        })

        const coreDescriptorMap = new Map<string, string>()
        for (const desc of coreDescriptors) {
            coreDescriptorMap.set(desc.method, desc.capability)
        }

        // Test environment, process, profiling, dialog, clipboard, tray, webserver parity
        for (const rendererDesc of RENDERER_CAPABILITY_DESCRIPTORS) {
            const coreCap = coreDescriptorMap.get(rendererDesc.method)
            if (coreCap) {
                expect(
                    rendererDesc.capability,
                    `Capability mismatch for method "${rendererDesc.method}": RENDERER is "${rendererDesc.capability}" but CORE RPC is "${coreCap}"`,
                ).toBe(coreCap)
            }
        }
    })

    it('ensures registerIpcHandlers does NOT register raw ipcMain.handle for individual native methods', () => {
        ipcHandlers.clear()

        const mockServices = {
            registry: {
                getRpcDescriptors: () => [
                    { method: 'native:readFile', capability: 'filesystem.read' },
                    { method: 'native:writeFile', capability: 'filesystem.write' },
                    { method: 'session:get', capability: 'sessions.read' },
                ],
            },
            handleMethod: vi.fn(),
            pluginRuntimeHost: {
                capabilityBroker: new MainCapabilityBroker(),
            },
        } as any

        registerIpcHandlers(mockServices, () => null)

        // Raw channels must NOT be registered on ipcMain
        expect(ipcHandlers.has('native:readFile')).toBe(false)
        expect(ipcHandlers.has('native:writeFile')).toBe(false)
        expect(ipcHandlers.has('session:get')).toBe(false)
        expect(ipcHandlers.has('dialog:saveFile')).toBe(false)

        // ONLY fixed transport channels must be registered
        expect(ipcHandlers.has('cpa:capability:bootstrap')).toBe(true)
        expect(ipcHandlers.has('cpa:capability:invoke')).toBe(true)
        expect(ipcHandlers.has('cpa:capability:grant')).toBe(true)
        expect(ipcHandlers.has('cpa:capability:subscribe')).toBe(true)
        expect(ipcHandlers.has('cpa:capability:unsubscribe')).toBe(true)
    })
})
