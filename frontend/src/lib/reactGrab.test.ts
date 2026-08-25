import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  isBrowserEnvironment,
  isMainProgramInDebugMode,
  shouldEnableReactGrab,
  initReactGrab,
  activateReactGrab,
  isReactGrabActive,
  isReactGrabLoading,
  resetReactGrabStateForTests,
} from './reactGrab'
import { setHostBridge } from '@/application/services/hostTransport'

describe('reactGrab', () => {
  const originalUserAgent = navigator.userAgent

  beforeEach(() => {
    vi.restoreAllMocks()
    setHostBridge(null)
    resetReactGrabStateForTests()
  })

  afterEach(() => {
    Object.defineProperty(navigator, 'userAgent', {
      value: originalUserAgent,
      configurable: true,
    })
    setHostBridge(null)
    resetReactGrabStateForTests()
  })

  describe('isBrowserEnvironment', () => {
    it('returns true when userAgent does not contain Electron', () => {
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        configurable: true,
      })
      expect(isBrowserEnvironment()).toBe(true)
    })

    it('returns false when userAgent contains Electron', () => {
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Electron/34.2.0 Safari/537.36',
        configurable: true,
      })
      expect(isBrowserEnvironment()).toBe(false)
    })
  })

  describe('isMainProgramInDebugMode', () => {
    it('returns true when RuntimeInfo reports isDebug true', async () => {
      const mockRuntimeInfo = vi.fn().mockResolvedValue({
        platform: 'darwin',
        userConfigDir: '/cfg',
        tempDir: '/tmp',
        homeDir: '/home/test',
        isDebug: true,
      })
      setHostBridge({
        RuntimeInfo: mockRuntimeInfo,
      } as any)

      const result = await isMainProgramInDebugMode()
      expect(result).toBe(true)
      expect(mockRuntimeInfo).toHaveBeenCalled()
    })

    it('returns false when RuntimeInfo reports isDebug false or undefined', async () => {
      setHostBridge({
        RuntimeInfo: vi.fn().mockResolvedValue({
          platform: 'darwin',
          userConfigDir: '/cfg',
          tempDir: '/tmp',
          homeDir: '/home/test',
          isDebug: false,
        }),
      } as any)

      const result = await isMainProgramInDebugMode()
      expect(result).toBe(false)
    })

    it('falls back to WebServerGetStatus when RuntimeInfo is not available', async () => {
      setHostBridge({
        WebServerGetStatus: vi.fn().mockResolvedValue({
          running: true,
          isDebug: true,
        }),
      } as any)

      const result = await isMainProgramInDebugMode()
      expect(result).toBe(true)
    })

    it('falls back to /api/status HTTP endpoint when host bridge is unavailable', async () => {
      setHostBridge(null)

      const originalFetch = globalThis.fetch
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ running: true, isDebug: true }),
      }) as unknown as typeof fetch

      try {
        const result = await isMainProgramInDebugMode()
        expect(result).toBe(true)
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it('returns false when RuntimeInfo throws or is unavailable', async () => {
      setHostBridge({
        RuntimeInfo: vi.fn().mockRejectedValue(new Error('RPC failed')),
      } as any)

      const originalFetch = globalThis.fetch
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Fetch failed')) as unknown as typeof fetch

      try {
        expect(await isMainProgramInDebugMode()).toBe(false)

        setHostBridge(null)
        expect(await isMainProgramInDebugMode()).toBe(false)
      } finally {
        globalThis.fetch = originalFetch
      }
    })
  })

  describe('shouldEnableReactGrab', () => {
    it('in browser mode: enables when main program is in debug mode', async () => {
      setHostBridge({
        RuntimeInfo: vi.fn().mockResolvedValue({ isDebug: true }),
      } as any)

      const enabled = await shouldEnableReactGrab({ isBrowser: true })
      expect(enabled).toBe(true)
    })

    it('in browser mode: disables when main program is not in debug mode', async () => {
      setHostBridge({
        RuntimeInfo: vi.fn().mockResolvedValue({ isDebug: false }),
      } as any)

      const enabled = await shouldEnableReactGrab({ isBrowser: true, isDev: true })
      expect(enabled).toBe(false)
    })

    it('in browser mode: respects explicit isDebug option', async () => {
      expect(await shouldEnableReactGrab({ isBrowser: true, isDebug: true })).toBe(true)
      expect(await shouldEnableReactGrab({ isBrowser: true, isDebug: false })).toBe(false)
    })

    it('in Electron mode: enables in dev or debug mode', async () => {
      expect(await shouldEnableReactGrab({ isBrowser: false, isDev: true })).toBe(true)
      expect(await shouldEnableReactGrab({ isBrowser: false, isDebug: true })).toBe(true)
    })

    it('in Electron mode: disables in packaged non-debug mode', async () => {
      setHostBridge({
        RuntimeInfo: vi.fn().mockResolvedValue({ isDebug: false }),
      } as any)

      const enabled = await shouldEnableReactGrab({ isBrowser: false, isDev: false })
      expect(enabled).toBe(false)
    })
  })

  describe('initReactGrab', () => {
    it('calls loader when shouldEnable is true and returns true', async () => {
      const loader = vi.fn().mockResolvedValue({})

      const result = await initReactGrab({
        isBrowser: true,
        isDebug: true,
        loader,
      })

      expect(result).toBe(true)
      expect(loader).toHaveBeenCalledTimes(1)
    })

    it('does not call loader when shouldEnable is false and returns false', async () => {
      const loader = vi.fn().mockResolvedValue({})

      const result = await initReactGrab({
        isBrowser: true,
        isDebug: false,
        loader,
      })

      expect(result).toBe(false)
      expect(loader).not.toHaveBeenCalled()
    })

    it('catches loader errors and returns false without throwing', async () => {
      const loader = vi.fn().mockRejectedValue(new Error('Dynamic import failed'))

      const result = await initReactGrab({
        isBrowser: true,
        isDebug: true,
        loader,
      })

      expect(result).toBe(false)
    })

    it('returns false by default on bare startup without autoEnable or loader', async () => {
      const result = await initReactGrab({
        isBrowser: true,
        isDebug: true,
      })

      expect(result).toBe(false)
      expect(isReactGrabActive()).toBe(false)
    })
  })

  describe('activateReactGrab', () => {
    it('loads and activates react-grab on demand', async () => {
      const mockInit = vi.fn()
      const loader = vi.fn().mockResolvedValue({ init: mockInit })

      expect(isReactGrabActive()).toBe(false)
      expect(isReactGrabLoading()).toBe(false)

      const result = await activateReactGrab({
        isBrowser: true,
        isDebug: true,
        loader,
      })

      expect(result).toBe(true)
      expect(loader).toHaveBeenCalledTimes(1)
      expect(mockInit).toHaveBeenCalledTimes(1)
      expect(isReactGrabActive()).toBe(true)
      expect(isReactGrabLoading()).toBe(false)

      // Subsequent activation returns true immediately without re-invoking loader
      const secondResult = await activateReactGrab({
        isBrowser: true,
        isDebug: true,
        loader,
      })
      expect(secondResult).toBe(true)
      expect(loader).toHaveBeenCalledTimes(1)
    })

    it('does not load when shouldEnable is false', async () => {
      const loader = vi.fn().mockResolvedValue({})

      const result = await activateReactGrab({
        isBrowser: true,
        isDebug: false,
        loader,
      })

      expect(result).toBe(false)
      expect(loader).not.toHaveBeenCalled()
      expect(isReactGrabActive()).toBe(false)
    })
  })
})
