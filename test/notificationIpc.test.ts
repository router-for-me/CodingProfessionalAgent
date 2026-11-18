import { describe, it, expect, vi, beforeEach } from 'vitest'

const ipcHandlers = new Map<string, (...args: any[]) => any>()

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/tmp'),
    dock: {
      setBadge: vi.fn(),
      bounce: vi.fn(),
    },
    setBadgeCount: vi.fn(),
  },
  BrowserWindow: vi.fn(),
  Notification: vi.fn().mockImplementation(() => ({
    show: vi.fn(),
    on: vi.fn(),
  })),
  nativeImage: {
    createFromDataURL: vi.fn(() => ({ isEmpty: () => false })),
  },
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
  createServices,
  registerIpcHandlers,
  type AppServices,
} from '../src/main/ipc/registerIpcHandlers.js'
import { registerCapabilityTransport } from '../src/main/ipc/registerCapabilityTransport.js'
import { MainCapabilityBroker } from '../src/main/plugins/capabilities/MainCapabilityBroker.js'
import { createPlatformRpcDescriptors } from '../src/main/plugins/contributions/rpcDescriptors.js'
import { createPlatformServiceDescriptors } from '../src/main/plugins/contributions/serviceDescriptors.js'
import { ApnsPushService } from '../src/main/services/apnsPushService.js'
import { NotificationBadgeService } from '../src/main/services/notificationBadgeService.js'
import {
  createHostCapabilityFacade,
  RENDERER_CAPABILITY_DESCRIPTORS,
  type HostTransportApi,
} from '../src/shared/capabilityDescriptors.js'
import type {
  NotificationClientRegistration,
  NotificationClientUnregistration,
} from '../src/shared/types.js'

describe('Notification IPC & RPC Wiring', () => {
  beforeEach(() => {
    ipcHandlers.clear()
    vi.clearAllMocks()
  })

  describe('direct IPC handlers in registerIpcHandlers', () => {
    it('does not register raw direct notification IPC handlers to prevent capability broker bypass', () => {
      const mockBadgeService = {
        notifyTaskCompleted: vi.fn(),
        clearBadge: vi.fn(),
      }

      const mockServices = {
        notificationBadgeService: mockBadgeService,
      } as unknown as AppServices

      registerIpcHandlers(mockServices, () => null)

      expect(ipcHandlers.has('notification:taskCompleted')).toBe(false)
      expect(ipcHandlers.has('notification:clearBadge')).toBe(false)
    })
  })

  describe('Capability transport & broker invocation with permission verification', () => {
    it('allows notification:taskCompleted when granted notification.show and rejects when lacking permission', async () => {
      const broker = new MainCapabilityBroker()
      const mockBadgeService = {
        notifyTaskCompleted: vi.fn(),
        clearBadge: vi.fn(),
      }

      const mockServices = {
        handleMethod: vi.fn(async (method: string, args: unknown[]) => {
          if (method === 'notification:taskCompleted') {
            mockBadgeService.notifyTaskCompleted(args[0])
            return undefined
          }
          throw new Error(`Unexpected method: ${method}`)
        }),
      } as unknown as AppServices

      const unregister = registerCapabilityTransport({
        broker,
        services: mockServices,
      })

      try {
        const sender = {
          pluginId: 'test-plugin',
          senderId: 1,
          frameUrl: '',
          transport: 'electron' as const,
          runtime: 'renderer' as const,
        }

        // Handle with notification.show permission
        const authorizedHandle = broker.grant(sender, ['notification.show'], 1)
        const payload = { sessionId: 's-123', sessionTitle: 'Fix issue' }

        await broker.invoke(authorizedHandle, 'notification:taskCompleted', [payload], sender)
        expect(mockBadgeService.notifyTaskCompleted).toHaveBeenCalledWith(payload)

        // Handle lacking notification.show permission
        const unauthorizedHandle = broker.grant(sender, ['filesystem.read'], 1)
        await expect(
          broker.invoke(unauthorizedHandle, 'notification:taskCompleted', [payload], sender),
        ).rejects.toThrow(/lacks capability notification\.show/)
      } finally {
        unregister()
      }
    })

    it('allows notification:clearBadge when granted notification.manage and rejects when lacking permission', async () => {
      const broker = new MainCapabilityBroker()
      const mockBadgeService = {
        notifyTaskCompleted: vi.fn(),
        clearBadge: vi.fn(),
      }

      const mockServices = {
        handleMethod: vi.fn(async (method: string) => {
          if (method === 'notification:clearBadge') {
            mockBadgeService.clearBadge()
            return undefined
          }
          throw new Error(`Unexpected method: ${method}`)
        }),
      } as unknown as AppServices

      const unregister = registerCapabilityTransport({
        broker,
        services: mockServices,
      })

      try {
        const sender = {
          pluginId: 'test-plugin',
          senderId: 1,
          frameUrl: '',
          transport: 'electron' as const,
          runtime: 'renderer' as const,
        }

        // Handle with notification.manage permission
        const authorizedHandle = broker.grant(sender, ['notification.manage'], 1)

        await broker.invoke(authorizedHandle, 'notification:clearBadge', [], sender)
        expect(mockBadgeService.clearBadge).toHaveBeenCalled()

        // Handle with only notification.show permission (lacks notification.manage)
        const unauthorizedHandle = broker.grant(sender, ['notification.show'], 1)
        await expect(
          broker.invoke(unauthorizedHandle, 'notification:clearBadge', [], sender),
        ).rejects.toThrow(/lacks capability notification\.manage/)
      } finally {
        unregister()
      }
    })
    it('allows notification:registerClient and notification:unregisterClient when granted notification.manage and rejects when lacking permission', async () => {
      const broker = new MainCapabilityBroker()
      const mockApnsService = {
        registerClient: vi.fn().mockResolvedValue(undefined),
        unregisterClient: vi.fn().mockResolvedValue(undefined),
      }

      const mockServices = {
        handleMethod: vi.fn(async (method: string, args: unknown[]) => {
          if (method === 'notification:registerClient') {
            await mockApnsService.registerClient(args[0])
            return undefined
          }
          if (method === 'notification:unregisterClient') {
            await mockApnsService.unregisterClient(args[0])
            return undefined
          }
          throw new Error(`Unexpected method: ${method}`)
        }),
      } as unknown as AppServices

      const unregister = registerCapabilityTransport({
        broker,
        services: mockServices,
      })

      try {
        const sender = {
          pluginId: 'test-plugin',
          senderId: 1,
          frameUrl: '',
          transport: 'electron' as const,
          runtime: 'renderer' as const,
        }

        const regPayload: NotificationClientRegistration = {
          clientId: 'client-1',
          connectionId: 'conn-1',
          deviceToken: 'e'.repeat(64),
          environment: 'production',
        }
        const unregPayload: NotificationClientUnregistration = {
          clientId: 'client-1',
          connectionId: 'conn-1',
        }

        const authorizedHandle = broker.grant(sender, ['notification.manage'], 1)
        await broker.invoke(authorizedHandle, 'notification:registerClient', [regPayload], sender)
        expect(mockApnsService.registerClient).toHaveBeenCalledWith(regPayload)

        await broker.invoke(authorizedHandle, 'notification:unregisterClient', [unregPayload], sender)
        expect(mockApnsService.unregisterClient).toHaveBeenCalledWith(unregPayload)

        const unauthorizedHandle = broker.grant(sender, ['notification.show'], 1)
        await expect(
          broker.invoke(unauthorizedHandle, 'notification:registerClient', [regPayload], sender),
        ).rejects.toThrow(/lacks capability notification\.manage/)
        await expect(
          broker.invoke(unauthorizedHandle, 'notification:unregisterClient', [unregPayload], sender),
        ).rejects.toThrow(/lacks capability notification\.manage/)
      } finally {
        unregister()
      }
    })
  })

  describe('RPC descriptors in createPlatformRpcDescriptors', () => {
    it('declares notification:taskCompleted and notification:clearBadge descriptors', async () => {
      const mockBadgeService = {
        notifyTaskCompleted: vi.fn(),
        clearBadge: vi.fn(),
      }

      const descriptors = createPlatformRpcDescriptors({
        getService: <T>(id: string) => {
          if (id === 'notificationBadgeService') return mockBadgeService as unknown as T
          throw new Error(`Unknown service: ${id}`)
        },
        getMainWindow: () => null,
      })

      const taskCompletedRpc = descriptors.find((d) => d.method === 'notification:taskCompleted')
      expect(taskCompletedRpc).toBeDefined()
      expect(taskCompletedRpc?.aliases).toContain('NotificationTaskCompleted')
      expect(taskCompletedRpc?.ipcChannel).toBe('notification:taskCompleted')
      expect(taskCompletedRpc?.capability).toBe('notification.show')

      const clearBadgeRpc = descriptors.find((d) => d.method === 'notification:clearBadge')
      expect(clearBadgeRpc).toBeDefined()
      expect(clearBadgeRpc?.aliases).toContain('NotificationClearBadge')
      expect(clearBadgeRpc?.ipcChannel).toBe('notification:clearBadge')
      expect(clearBadgeRpc?.capability).toBe('notification.manage')

      // Invoke taskCompleted
      const payload = { sessionId: 'test-session', sessionTitle: 'Test Task' }
      await taskCompletedRpc!.invoke({} as any, [payload])
      expect(mockBadgeService.notifyTaskCompleted).toHaveBeenCalledWith(payload)

      // Invoke clearBadge
      await clearBadgeRpc!.invoke({} as any, [])
      expect(mockBadgeService.clearBadge).toHaveBeenCalled()
    })

    it('declares notification:registerClient and notification:unregisterClient and dispatches taskCompleted to both badge and APNs services even when focused', async () => {
      const mockBadgeService = {
        notifyTaskCompleted: vi.fn(),
        clearBadge: vi.fn(),
      }
      const mockApnsService = {
        registerClient: vi.fn().mockResolvedValue(undefined),
        unregisterClient: vi.fn().mockResolvedValue(undefined),
        notifyTaskCompleted: vi.fn().mockResolvedValue(undefined),
      }

      const descriptors = createPlatformRpcDescriptors({
        getService: <T>(id: string) => {
          if (id === 'notificationBadgeService') return mockBadgeService as unknown as T
          if (id === 'apnsPushService') return mockApnsService as unknown as T
          throw new Error(`Unknown service: ${id}`)
        },
        getMainWindow: () => ({ isFocused: () => true, isDestroyed: () => false }) as any,
      })

      const registerClientRpc = descriptors.find((d) => d.method === 'notification:registerClient')
      expect(registerClientRpc).toBeDefined()
      expect(registerClientRpc?.aliases).toContain('NotificationRegisterClient')
      expect(registerClientRpc?.ipcChannel).toBe('notification:registerClient')
      expect(registerClientRpc?.capability).toBe('notification.manage')

      const unregisterClientRpc = descriptors.find((d) => d.method === 'notification:unregisterClient')
      expect(unregisterClientRpc).toBeDefined()
      expect(unregisterClientRpc?.aliases).toContain('NotificationUnregisterClient')
      expect(unregisterClientRpc?.ipcChannel).toBe('notification:unregisterClient')
      expect(unregisterClientRpc?.capability).toBe('notification.manage')

      const regPayload: NotificationClientRegistration = {
        clientId: 'ios-client-1',
        connectionId: 'conn-1',
        deviceToken: 'a'.repeat(64),
        environment: 'sandbox',
        platform: 'ios',
        deviceName: 'iPhone',
        appVersion: '1.0.0',
        enabled: true,
      }
      await expect(registerClientRpc!.invoke({} as any, [regPayload])).resolves.toEqual({ ok: true })
      expect(mockApnsService.registerClient).toHaveBeenCalledWith(regPayload)

      const unregPayload: NotificationClientUnregistration = {
        clientId: 'ios-client-1',
        connectionId: 'conn-1',
      }
      await expect(unregisterClientRpc!.invoke({} as any, [unregPayload])).resolves.toEqual({ ok: true })
      expect(mockApnsService.unregisterClient).toHaveBeenCalledWith(unregPayload)

      const taskCompletedPayload = { sessionId: 'focused-session', sessionTitle: 'Focused Task' }
      const taskCompletedRpc = descriptors.find((d) => d.method === 'notification:taskCompleted')
      await taskCompletedRpc!.invoke({} as any, [taskCompletedPayload])
      expect(mockBadgeService.notifyTaskCompleted).toHaveBeenCalledWith(taskCompletedPayload)
      expect(mockApnsService.notifyTaskCompleted).toHaveBeenCalledWith(taskCompletedPayload)
    })

    it('declares notification:askRequested, resolves missing sessionTitle from sessionService, and dispatches to badge and APNs services', async () => {
      const mockBadgeService = {
        notifyTaskCompleted: vi.fn(),
        notifyAskRequested: vi.fn(),
        clearBadge: vi.fn(),
      }
      const mockApnsService = {
        notifyAskRequested: vi.fn().mockResolvedValue(undefined),
      }
      const mockSessionService = {
        getMeta: vi.fn().mockResolvedValue({ id: 'ask-session-1', title: 'SQLite Resolved Title' }),
      }

      const descriptors = createPlatformRpcDescriptors({
        getService: <T>(id: string) => {
          if (id === 'notificationBadgeService') return mockBadgeService as unknown as T
          if (id === 'apnsPushService') return mockApnsService as unknown as T
          if (id === 'sessionService') return mockSessionService as unknown as T
          throw new Error(`Unknown service: ${id}`)
        },
        getMainWindow: () => ({ isFocused: () => true, isDestroyed: () => false }) as any,
      })

      const askRequestedRpc = descriptors.find((d) => d.method === 'notification:askRequested')
      expect(askRequestedRpc).toBeDefined()
      expect(askRequestedRpc?.aliases).toContain('NotificationAskRequested')
      expect(askRequestedRpc?.ipcChannel).toBe('notification:askRequested')
      expect(askRequestedRpc?.capability).toBe('notification.show')

      await askRequestedRpc!.invoke({} as any, [{
        sessionId: 'ask-session-1',
        question: 'Proceed with migration?',
        requestId: 'req-1',
        toolCallId: 'call-1',
      }])

      expect(mockSessionService.getMeta).toHaveBeenCalledWith('ask-session-1')
      const expectedPayload = {
        sessionId: 'ask-session-1',
        sessionTitle: 'SQLite Resolved Title',
        question: 'Proceed with migration?',
        requestId: 'req-1',
        toolCallId: 'call-1',
      }
      expect(mockBadgeService.notifyAskRequested).toHaveBeenCalledWith(expectedPayload)
      expect(mockApnsService.notifyAskRequested).toHaveBeenCalledWith(expectedPayload)

      // Empty sessionId is a clean no-op
      mockBadgeService.notifyAskRequested.mockClear()
      mockApnsService.notifyAskRequested.mockClear()
      await askRequestedRpc!.invoke({} as any, [{ sessionId: '   ', question: 'Ignored' }])
      expect(mockBadgeService.notifyAskRequested).not.toHaveBeenCalled()
      expect(mockApnsService.notifyAskRequested).not.toHaveBeenCalled()
    })

    it('swallows apnsPushService rejection on notification:taskCompleted without failing the RPC', async () => {
      const mockBadgeService = {
        notifyTaskCompleted: vi.fn(),
        clearBadge: vi.fn(),
      }
      const mockApnsService = {
        notifyTaskCompleted: vi.fn().mockRejectedValue(new Error('APNs network error')),
      }

      const descriptors = createPlatformRpcDescriptors({
        getService: <T>(id: string) => {
          if (id === 'notificationBadgeService') return mockBadgeService as unknown as T
          if (id === 'apnsPushService') return mockApnsService as unknown as T
          throw new Error(`Unknown service: ${id}`)
        },
        getMainWindow: () => null,
      })

      const taskCompletedRpc = descriptors.find((d) => d.method === 'notification:taskCompleted')
      const payload = { sessionId: 's-err', sessionTitle: 'Error Test' }
      await expect(taskCompletedRpc!.invoke({} as any, [payload])).resolves.toBeUndefined()
      expect(mockBadgeService.notifyTaskCompleted).toHaveBeenCalledWith(payload)
      expect(mockApnsService.notifyTaskCompleted).toHaveBeenCalledWith(payload)
    })
  })

  describe('Service descriptors in createPlatformServiceDescriptors', () => {
    it('registers notificationBadgeService descriptor and supports dispose', () => {
      const descriptors = createPlatformServiceDescriptors({
        getMainWindow: () => null,
      })

      const badgeServiceDesc = descriptors.find((d) => d.id === 'notificationBadgeService')
      expect(badgeServiceDesc).toBeDefined()
      expect(badgeServiceDesc?.dependencies).toEqual([])

      const createdService = badgeServiceDesc!.create({} as any)
      expect(createdService).toBeInstanceOf(NotificationBadgeService)

      const clearBadgeSpy = vi.spyOn(createdService, 'clearBadge')
      badgeServiceDesc!.dispose?.(createdService)
      expect(clearBadgeSpy).toHaveBeenCalled()
    })

    it('uses provided notificationBadgeService option if specified', () => {
      const customService = new NotificationBadgeService(() => null)
      const descriptors = createPlatformServiceDescriptors({
        notificationBadgeService: customService,
      })

      const badgeServiceDesc = descriptors.find((d) => d.id === 'notificationBadgeService')
      expect(badgeServiceDesc?.create({} as any)).toBe(customService)
    })

    it('registers apnsPushService with empty dependencies and lazy kvStoreService lookup', async () => {
      const descriptors = createPlatformServiceDescriptors({
        getMainWindow: () => null,
      })

      const badgeServiceDesc = descriptors.find((d) => d.id === 'notificationBadgeService')
      expect(badgeServiceDesc?.dependencies).toEqual([])

      const apnsServiceDesc = descriptors.find((d) => d.id === 'apnsPushService')
      expect(apnsServiceDesc).toBeDefined()
      expect(apnsServiceDesc?.dependencies).toEqual([])

      let kvAvailable = false
      const store = new Map<string, unknown>()
      const mockKv = {
        get: vi.fn(async (key: string) => store.get(key)),
        set: vi.fn(async (key: string, val: unknown) => {
          store.set(key, val)
        }),
        save: vi.fn(async () => {}),
      }

      const createdService = apnsServiceDesc!.create({
        get: (id: string) => {
          if (id === 'kvStoreService' && kvAvailable) return mockKv
          throw new Error(`Service "${id}" not found`)
        },
      } as any) as ApnsPushService
      expect(createdService).toBeInstanceOf(ApnsPushService)

      // Before kvStoreService is committed, listClients resolves cleanly to []
      expect(await createdService.listClients()).toEqual([])

      // Once kvStoreService becomes available, lazy lookup resolves it
      kvAvailable = true
      await createdService.registerClient({
        clientId: 'client-lazy',
        connectionId: 'conn-lazy',
        deviceToken: 'b'.repeat(64),
        environment: 'production',
      })
      expect(mockKv.save).toHaveBeenCalledTimes(1)
      expect(await createdService.listClients()).toHaveLength(1)
    })

    it('uses provided apnsPushService option if specified', () => {
      const customApns = new ApnsPushService(() => null)
      const descriptors = createPlatformServiceDescriptors({
        apnsPushService: customApns,
      })

      const apnsServiceDesc = descriptors.find((d) => d.id === 'apnsPushService')
      expect(apnsServiceDesc?.create({} as any)).toBe(customApns)
    })
  })

  describe('createServices wiring', () => {
    it('creates notificationBadgeService and apnsPushService in AppServices and dispatches notification RPCs including WebSocket RPC transport', async () => {
      const focusedWindow = {
        isDestroyed: () => false,
        isFocused: () => true,
        isMinimized: () => false,
      } as any
      const customApns = new ApnsPushService(() => null)
      const apnsNotifySpy = vi.spyOn(customApns, 'notifyTaskCompleted').mockResolvedValue(undefined)
      const apnsRegisterSpy = vi.spyOn(customApns, 'registerClient').mockResolvedValue(undefined)
      const apnsUnregisterSpy = vi.spyOn(customApns, 'unregisterClient').mockResolvedValue(undefined)

      const services = createServices(() => focusedWindow, {
        apnsPushService: customApns,
      })
      expect(services.notificationBadgeService).toBeDefined()
      expect(services.notificationBadgeService).toBeInstanceOf(NotificationBadgeService)
      expect(services.apnsPushService).toBe(customApns)

      const notifySpy = vi.spyOn(services.notificationBadgeService, 'notifyTaskCompleted')
      const clearSpy = vi.spyOn(services.notificationBadgeService, 'clearBadge')

      const payload = { sessionId: 's-live', sessionTitle: 'Live Task' }
      await services.handleMethod('notification:taskCompleted', [payload])
      expect(notifySpy).toHaveBeenCalledWith(payload)
      expect(apnsNotifySpy).toHaveBeenCalledWith(payload)

      await services.handleMethod('notification:clearBadge', [])
      expect(clearSpy).toHaveBeenCalled()

      // Verify WebSocket RPC transport dispatches notification:registerClient and notification:unregisterClient
      const regPayload: NotificationClientRegistration = {
        clientId: 'ws-client-1',
        connectionId: 'conn-ws-1',
        deviceToken: 'c'.repeat(64),
        environment: 'production',
      }
      const wsRegResult = await services.webServerService.getRpcTransport().handleWsMessage(
        JSON.stringify({
          type: 'rpc',
          id: 'req-1',
          method: 'notification:registerClient',
          args: [regPayload],
        }),
        { clientId: 'ws-client-1' },
      )
      expect(wsRegResult.response).toEqual({
        type: 'rpc_result',
        id: 'req-1',
        result: { ok: true },
      })
      expect(apnsRegisterSpy).toHaveBeenCalledWith(regPayload)

      const unregPayload: NotificationClientUnregistration = {
        clientId: 'ws-client-1',
        connectionId: 'conn-ws-1',
      }
      const wsUnregResult = await services.webServerService.getRpcTransport().handleWsMessage(
        JSON.stringify({
          type: 'rpc',
          id: 'req-2',
          method: 'notification:unregisterClient',
          args: [unregPayload],
        }),
        { clientId: 'ws-client-1' },
      )
      expect(wsUnregResult.response).toEqual({
        type: 'rpc_result',
        id: 'req-2',
        result: { ok: true },
      })
      expect(apnsUnregisterSpy).toHaveBeenCalledWith(unregPayload)

      await services.disposeAll()
    })
  })

  describe('HostCapabilityFacade bridge parity', () => {
    it('includes NotificationTaskCompleted, NotificationAskRequested, NotificationClearBadge, NotificationRegisterClient, and NotificationUnregisterClient in RENDERER_CAPABILITY_DESCRIPTORS', () => {
      const taskCompletedDesc = RENDERER_CAPABILITY_DESCRIPTORS.find((d) => d.name === 'NotificationTaskCompleted')
      expect(taskCompletedDesc).toBeDefined()
      expect(taskCompletedDesc?.method).toBe('notification:taskCompleted')
      expect(taskCompletedDesc?.capability).toBe('notification.show')

      const askRequestedDesc = RENDERER_CAPABILITY_DESCRIPTORS.find((d) => d.name === 'NotificationAskRequested')
      expect(askRequestedDesc).toBeDefined()
      expect(askRequestedDesc?.method).toBe('notification:askRequested')
      expect(askRequestedDesc?.capability).toBe('notification.show')

      const clearBadgeDesc = RENDERER_CAPABILITY_DESCRIPTORS.find((d) => d.name === 'NotificationClearBadge')
      expect(clearBadgeDesc).toBeDefined()
      expect(clearBadgeDesc?.method).toBe('notification:clearBadge')
      expect(clearBadgeDesc?.capability).toBe('notification.manage')

      const registerClientDesc = RENDERER_CAPABILITY_DESCRIPTORS.find((d) => d.name === 'NotificationRegisterClient')
      expect(registerClientDesc).toBeDefined()
      expect(registerClientDesc?.method).toBe('notification:registerClient')
      expect(registerClientDesc?.capability).toBe('notification.manage')

      const unregisterClientDesc = RENDERER_CAPABILITY_DESCRIPTORS.find((d) => d.name === 'NotificationUnregisterClient')
      expect(unregisterClientDesc).toBeDefined()
      expect(unregisterClientDesc?.method).toBe('notification:unregisterClient')
      expect(unregisterClientDesc?.capability).toBe('notification.manage')
    })

    it('routes facade methods through transport invoke', async () => {
      const invokeSpy = vi.fn().mockResolvedValue(undefined)
      const mockTransport: HostTransportApi = {
        invoke: invokeSpy,
        subscribeNativeEvents: vi.fn().mockReturnValue(() => {}),
      }

      const facade = createHostCapabilityFacade(mockTransport, 'desktop-main')

      const payload = { sessionId: 'session-facade', sessionTitle: 'Facade Title' }
      await facade.NotificationTaskCompleted(payload)
      expect(invokeSpy).toHaveBeenCalledWith('desktop-main', 'notification:taskCompleted', [payload])

      const askPayload = { sessionId: 'session-facade', sessionTitle: 'Facade Title', question: 'Confirm?' }
      await facade.NotificationAskRequested(askPayload)
      expect(invokeSpy).toHaveBeenCalledWith('desktop-main', 'notification:askRequested', [askPayload])

      await facade.NotificationClearBadge()
      expect(invokeSpy).toHaveBeenCalledWith('desktop-main', 'notification:clearBadge', [])

      const regPayload: NotificationClientRegistration = {
        clientId: 'facade-client',
        connectionId: 'conn-facade',
        deviceToken: 'd'.repeat(64),
        environment: 'sandbox',
      }
      await facade.NotificationRegisterClient(regPayload)
      expect(invokeSpy).toHaveBeenCalledWith('desktop-main', 'notification:registerClient', [regPayload])

      const unregPayload: NotificationClientUnregistration = {
        clientId: 'facade-client',
        connectionId: 'conn-facade',
      }
      await facade.NotificationUnregisterClient(unregPayload)
      expect(invokeSpy).toHaveBeenCalledWith('desktop-main', 'notification:unregisterClient', [unregPayload])
    })
  })
})
