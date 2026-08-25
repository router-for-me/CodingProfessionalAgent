import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserBridgeClient } from '@/features/agent-runtime/native/browserBridge'
import {
  __setCachedBrowserClientForTests,
  canUseHostKvStore,
  ensureBrowserHostTransport,
  isNativeRuntime,
  setHostBridge,
  setHostTransport,
} from './hostTransport'

class MockWebSocket {
  static OPEN = 1
  static CONNECTING = 0
  static CLOSED = 3
  readyState = 1
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event?: { code?: number }) => void) | null = null
  onerror: ((error: unknown) => void) | null = null
  send = vi.fn()
  close = vi.fn()
  addEventListener = vi.fn()
  removeEventListener = vi.fn()
}

describe('hostTransport browser KV reuse', () => {
  let originalWebSocket: typeof WebSocket | undefined

  beforeEach(() => {
    originalWebSocket = globalThis.WebSocket
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket
    setHostBridge(null)
    setHostTransport(null)
    __setCachedBrowserClientForTests(null)
  })

  afterEach(() => {
    __setCachedBrowserClientForTests(null)
    setHostBridge(null)
    setHostTransport(null)
    globalThis.WebSocket = originalWebSocket as typeof WebSocket
  })

  it('canUseHostKvStore is false by default in vitest without host overrides', () => {
    expect(isNativeRuntime()).toBe(false)
    expect(canUseHostKvStore()).toBe(false)
    expect(ensureBrowserHostTransport()).toBeNull()
  })

  it('canUseHostKvStore is true for Electron/test host bridge overrides', () => {
    setHostBridge({
      KVStoreGet: vi.fn(),
      KVStoreSet: vi.fn(),
    } as any)
    expect(isNativeRuntime()).toBe(true)
    expect(canUseHostKvStore()).toBe(true)
  })

  it('canUseHostKvStore is true for browser RPC clients without Electron native runtime', () => {
    const client = new BrowserBridgeClient()
    __setCachedBrowserClientForTests(client)

    expect(isNativeRuntime()).toBe(false)
    expect(canUseHostKvStore()).toBe(true)
    expect(ensureBrowserHostTransport()).toBe(client)
  })
})
