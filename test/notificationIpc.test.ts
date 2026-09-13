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
import { NotificationBadgeService } from '../src/main/services/notificationBadgeService.js'
import {
  createHostCapabilityFacade,
  RENDERER_CAPABILITY_DESCRIPTORS,
  type HostTransportApi,
} from '../src/shared/capabilityDescriptors.js'

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
  })

  describe('createServices wiring', () => {
    it('creates notificationBadgeService automatically in AppServices and dispatches via handleMethod', async () => {
      const services = createServices(() => null)
      expect(services.notificationBadgeService).toBeDefined()
      expect(services.notificationBadgeService).toBeInstanceOf(NotificationBadgeService)

      const notifySpy = vi.spyOn(services.notificationBadgeService, 'notifyTaskCompleted')
      const clearSpy = vi.spyOn(services.notificationBadgeService, 'clearBadge')

      const payload = { sessionId: 's-live', sessionTitle: 'Live Task' }
      await services.handleMethod('notification:taskCompleted', [payload])
      expect(notifySpy).toHaveBeenCalledWith(payload)

      await services.handleMethod('notification:clearBadge', [])
      expect(clearSpy).toHaveBeenCalled()
    })
  })

  describe('HostCapabilityFacade bridge parity', () => {
    it('includes NotificationTaskCompleted and NotificationClearBadge in RENDERER_CAPABILITY_DESCRIPTORS', () => {
      const taskCompletedDesc = RENDERER_CAPABILITY_DESCRIPTORS.find((d) => d.name === 'NotificationTaskCompleted')
      expect(taskCompletedDesc).toBeDefined()
      expect(taskCompletedDesc?.method).toBe('notification:taskCompleted')
      expect(taskCompletedDesc?.capability).toBe('notification.show')

      const clearBadgeDesc = RENDERER_CAPABILITY_DESCRIPTORS.find((d) => d.name === 'NotificationClearBadge')
      expect(clearBadgeDesc).toBeDefined()
      expect(clearBadgeDesc?.method).toBe('notification:clearBadge')
      expect(clearBadgeDesc?.capability).toBe('notification.manage')
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

      await facade.NotificationClearBadge()
      expect(invokeSpy).toHaveBeenCalledWith('desktop-main', 'notification:clearBadge', [])
    })
  })
})
