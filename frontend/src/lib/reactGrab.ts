/**
 * React Grab loader and runtime activation helpers.
 * In browser mode, react-grab is enabled only when the main program is running in debug mode.
 */

export interface InitReactGrabOptions {
  isBrowser?: boolean
  isDebug?: boolean | null
  isDev?: boolean
  autoEnable?: boolean
  loader?: () => Promise<unknown>
}

let reactGrabLoaded = false
let reactGrabLoading = false

/**
 * Returns whether react-grab has been loaded and activated.
 */
export function isReactGrabActive(): boolean {
  return reactGrabLoaded
}

/**
 * Returns whether react-grab is currently being loaded.
 */
export function isReactGrabLoading(): boolean {
  return reactGrabLoading
}

/**
 * Resets internal state for test isolation.
 */
export function resetReactGrabStateForTests(): void {
  reactGrabLoaded = false
  reactGrabLoading = false
}

import { isBrowserEnvironment } from './platform'
import { getHostBridge, isNativeRuntime } from '@/application/services/hostTransport'

export { isBrowserEnvironment }

/**
 * Queries the main process via host transport or HTTP status to check if the main program is in debug mode.
 */
export async function isMainProgramInDebugMode(): Promise<boolean> {
  if (isNativeRuntime()) {
    // 1. Try hostBridge.RuntimeInfo
    try {
      const bridge = getHostBridge()
      if (bridge?.RuntimeInfo) {
        const info = await bridge.RuntimeInfo()
        if (typeof info?.isDebug === 'boolean') {
          return info.isDebug
        }
      }
    } catch {
      // Continue to next probe
    }

    // 2. Try hostBridge.WebServerGetStatus
    try {
      const bridge = getHostBridge()
      if (bridge?.WebServerGetStatus) {
        const status = await bridge.WebServerGetStatus()
        if (typeof status?.isDebug === 'boolean') {
          return status.isDebug
        }
      }
    } catch {
      // Continue to next probe
    }
  }

  // 3. Fallback direct HTTP /api/status probe for browser mode
  try {
    if (typeof fetch !== 'undefined' && typeof window !== 'undefined') {
      const origin = window.location?.origin
      const candidates = [
        origin ? `${origin}/api/status` : '',
        'http://127.0.0.1:18080/api/status',
        'http://localhost:18080/api/status',
      ].filter(Boolean)

      for (const url of candidates) {
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(1500) })
          if (res.ok) {
            const data = await res.json()
            if (typeof data?.isDebug === 'boolean') {
              return data.isDebug
            }
          }
        } catch {
          // Continue to next candidate
        }
      }
    }
  } catch {
    // Ignore probe errors
  }

  return false
}

/**
 * Determines whether react-grab should be enabled.
 * In browser mode, it requires the main program to be in debug mode.
 * In Electron mode, it is enabled during development / debug sessions.
 */
export async function shouldEnableReactGrab(
  options?: Pick<InitReactGrabOptions, 'isBrowser' | 'isDebug' | 'isDev'>,
): Promise<boolean> {
  const isBrowser = options?.isBrowser ?? isBrowserEnvironment()

  if (isBrowser) {
    // In browser mode, only enable if the main program is in debug mode
    if (typeof options?.isDebug === 'boolean') {
      return options.isDebug
    }
    return await isMainProgramInDebugMode()
  }

  // In Electron desktop window, enable in dev or debug mode
  if (typeof options?.isDebug === 'boolean') {
    return options.isDebug
  }
  const isDev = options?.isDev ?? import.meta.env.DEV
  if (isDev) {
    return true
  }
  return await isMainProgramInDebugMode()
}

/**
 * Manually activate and load react-grab on demand.
 */
export async function activateReactGrab(
  options?: InitReactGrabOptions,
): Promise<boolean> {
  if (reactGrabLoaded) {
    return true
  }
  if (reactGrabLoading) {
    return false
  }

  const shouldEnable = await shouldEnableReactGrab(options)
  if (!shouldEnable) {
    return false
  }

  reactGrabLoading = true
  try {
    const loader = options?.loader ?? (() => import('react-grab'))
    const mod = (await loader()) as { init?: () => void } | undefined
    if (mod && typeof mod.init === 'function') {
      try {
        mod.init()
      } catch {
        // react-grab auto-initializes on import; ignore redundant init error
      }
    }
    reactGrabLoaded = true
    return true
  } catch (err) {
    console.debug('Failed to activate react-grab:', err)
    return false
  } finally {
    reactGrabLoading = false
  }
}

/**
 * Conditionally loads react-grab based on current runtime environment and options.
 * By default during app startup, react-grab is NOT auto-loaded to avoid memory and CPU overhead.
 * It is loaded only when options.autoEnable is true or options.loader is provided (e.g. in tests).
 */
export async function initReactGrab(options?: InitReactGrabOptions): Promise<boolean> {
  if (options?.autoEnable || options?.loader !== undefined) {
    return activateReactGrab(options)
  }
  return false
}
