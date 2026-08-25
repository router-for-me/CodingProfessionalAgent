import type { ElectronBridgeApi, HostTransportApi, NativeEvent } from '../../../../src/shared/types.js'
import { createHostCapabilityFacade } from '../../../../src/shared/capabilityDescriptors.js'
import { BrowserBridgeClient, createBrowserBridge, saveFileInBrowser } from '@/features/agent-runtime/native/browserBridge'
import { isBrowserEnvironment } from '@/lib/platform'

let customHostTransport: HostTransportApi | null = null
let customHostBridge: ElectronBridgeApi | null = null
let customDevMode: boolean | null = null
let cachedHostBridge: ElectronBridgeApi | null = null
let cachedBrowserClient: BrowserBridgeClient | null = null
let hostHandlePromise: Promise<string> | null = null
let customHostHandle: string | null = null

const hostNativeListeners = new Set<(event: NativeEvent) => void>()
let hostNativeUnsub: (() => void) | null = null

const noopTransport: HostTransportApi = {
    invoke: async () => undefined,
    claimPlatformHandle: async () => ({ ok: true, value: 'noop-handle' }),
    subscribeNativeEvents: () => () => {},
    subscribe: () => () => {},
}

/**
 * Returns true if running in native Electron with cpaHostTransport available on window,
 * or if a custom test bridge/transport has been configured.
 */
export function isNativeRuntime(): boolean {
    return (typeof window !== 'undefined' && Boolean(window.cpaHostTransport)) || customHostBridge !== null || customHostTransport !== null
}

/**
 * Returns true when the renderer can read/write the desktop host KV store.
 * Covers Electron preload, test overrides, and authenticated browser clients that
 * reuse the desktop process settings over RPC (same behavior as main branch).
 */
export function canUseHostKvStore(): boolean {
    if (isNativeRuntime()) {
        return true
    }
    if (typeof window === 'undefined' || !isBrowserEnvironment()) {
        return false
    }
    if (cachedBrowserClient) {
        return true
    }
    return getHostTransport() instanceof BrowserBridgeClient
}

/**
 * Eagerly create the browser host transport/bridge used by web clients.
 * Safe no-op outside browser environments and in Vitest (noop transport).
 */
export function ensureBrowserHostTransport(): BrowserBridgeClient | null {
    if (typeof window === 'undefined' || !isBrowserEnvironment()) {
        return null
    }
    const transport = getHostTransport()
    if (!(transport instanceof BrowserBridgeClient)) {
        return null
    }
    // Warm the facade cache so subsequent getHostBridge() calls reuse this client.
    if (!cachedHostBridge) {
        cachedHostBridge = createBrowserBridge(transport)
    }
    return transport
}

/** @internal test helper — inject a browser RPC client without marking Electron native runtime. */
export function __setCachedBrowserClientForTests(client: BrowserBridgeClient | null): void {
    if (cachedBrowserClient && cachedBrowserClient !== client) {
        try {
            cachedBrowserClient.dispose()
        } catch {
            // Ignore dispose errors in tests.
        }
    }
    cachedBrowserClient = client
    cachedHostBridge = client ? createBrowserBridge(client) : null
    hostHandlePromise = null
}

/**
 * Returns true if running in development mode.
 */
export function isDevMode(): boolean {
    if (customDevMode !== null) {
        return customDevMode
    }
    return Boolean(import.meta.env.DEV)
}

/**
 * Sets dev mode override (primarily used in unit/integration tests).
 */
export function setDevMode(isDev: boolean | null): void {
    customDevMode = isDev
}

/**
 * Gets or creates the underlying HostTransportApi.
 */
export function getHostTransport(): HostTransportApi {
    if (customHostTransport) {
        return customHostTransport
    }
    if (typeof window !== 'undefined' && window.cpaHostTransport) {
        return window.cpaHostTransport
    }
    if (typeof window !== 'undefined' && isBrowserEnvironment()) {
        // Prefer an already-created browser client (production warmup or tests).
        if (cachedBrowserClient) {
            return cachedBrowserClient
        }
        if (typeof process !== 'undefined' && (process.env?.NODE_ENV === 'test' || (process.env as any)?.VITEST)) {
            return noopTransport
        }
        cachedBrowserClient = new BrowserBridgeClient()
        return cachedBrowserClient
    }
    return noopTransport
}

/**
 * Sets a custom host handle override (primarily used in unit/integration tests).
 */
export function setCustomHostHandle(handle: string | null): void {
    customHostHandle = handle
    hostHandlePromise = null
    cachedHostBridge = null
}

async function resolveHostCapabilityHandle(): Promise<string> {
    if (customHostHandle) {
        return customHostHandle
    }
    if (hostHandlePromise) {
        return hostHandlePromise
    }

    const transport = getHostTransport()
    if (transport.claimPlatformHandle) {
        hostHandlePromise = (async () => {
            const res = await transport.claimPlatformHandle!()
            if (!res || !res.ok || !res.value) {
                console.error('[HostTransport] claimPlatformHandle failed:', res)
                throw new Error(
                    `Failed to bootstrap host platform capabilities: ${
                        (res?.error as any)?.message ?? 'Unknown error'
                    }`,
                )
            }
            return res.value
        })()
        return hostHandlePromise
    }

    // In custom/mock transports without claimPlatformHandle
    return 'host-platform-handle'
}

/**
 * Sets a custom host transport (primarily used in unit/integration tests).
 */
export function setHostTransport(transport: HostTransportApi | null): void {
    customHostTransport = transport
    customHostBridge = null
    cachedHostBridge = null
    hostHandlePromise = null
    if (hostNativeUnsub) {
        try {
            hostNativeUnsub()
        } catch {
            // Ignore error
        }
        hostNativeUnsub = null
    }
    hostNativeListeners.clear()
}

/**
 * Sets a custom host capability bridge (primarily used in unit/integration tests).
 */
export function setHostBridge(bridge: Partial<ElectronBridgeApi> | null): void {
    customHostBridge = bridge as ElectronBridgeApi | null
    cachedHostBridge = null
    hostHandlePromise = null
}

/**
 * Gets the singleton HostCapabilityClient / ElectronBridgeApi facade.
 */
export function getHostBridge(): ElectronBridgeApi {
    if (customHostBridge) {
        return customHostBridge
    }
    if (cachedHostBridge && !customHostTransport) {
        return cachedHostBridge
    }
    const transport = getHostTransport()
    if (transport instanceof BrowserBridgeClient) {
        cachedHostBridge = createBrowserBridge(transport)
        return cachedHostBridge
    }
    cachedHostBridge = createHostCapabilityFacade(transport, resolveHostCapabilityHandle, {
        onExpiredHandle: () => {
            // Drop the cached claim so the next resolve re-bootstraps from main.
            hostHandlePromise = null
        },
    })
    return cachedHostBridge
}

export const getHostCapabilityClient = getHostBridge

function ensureHostNativeSubscription(transport: HostTransportApi): void {
    if (!hostNativeUnsub && transport.subscribeNativeEvents) {
        try {
            hostNativeUnsub = transport.subscribeNativeEvents((evt) => {
                for (const listener of hostNativeListeners) {
                    try {
                        listener(evt)
                    } catch (err) {
                        console.error('Error in host native event listener:', err)
                    }
                }
            })
        } catch (err) {
            console.error('Failed to subscribe to host native events:', err)
        }
    }
}

/**
 * Subscribes to native events from the host transport with local Host fan-out.
 */
export function subscribeHostNativeEvents(listener: (event: NativeEvent) => void): () => void {
    if (customHostBridge?.onNativeEvent) {
        return customHostBridge.onNativeEvent(listener)
    }
    const transport = getHostTransport()
    if (transport instanceof BrowserBridgeClient) {
        return transport.subscribeNativeEvents(listener)
    }
    ensureHostNativeSubscription(transport)
    hostNativeListeners.add(listener)
    return () => {
        hostNativeListeners.delete(listener)
    }
}

/**
 * Subscribes to host reconnection events (for web browser clients).
 */
export function onHostReconnect(callback: () => void): () => void {
    if ((customHostBridge as any)?.onReconnect) {
        return (customHostBridge as any).onReconnect(callback)
    }
    const transport = getHostTransport()
    if (transport instanceof BrowserBridgeClient) {
        return transport.onReconnect(callback)
    }
    return () => {}
}

/**
 * File save dialog wrapper supporting native Electron and browser download fallback.
 */
export async function saveFileDialog(options: {
    defaultPath?: string
    title?: string
    content: string
    filters?: Array<{ name: string; extensions: string[] }>
}): Promise<{ saved: boolean; filePath?: string }> {
    const bridge = getHostBridge()
    if (bridge?.SaveFile) {
        return bridge.SaveFile(options)
    }
    if (bridge?.saveFile) {
        return bridge.saveFile(options)
    }
    return saveFileInBrowser(options)
}

/**
 * Dev profiling helpers.
 */
export async function startProfiling(options?: { durationMs?: number; target?: string }) {
    const bridge = getHostBridge()
    if (bridge?.startProfiling) {
        return bridge.startProfiling(options)
    }
    return { ok: false, error: 'Profiling not supported' }
}

export async function stopProfiling() {
    const bridge = getHostBridge()
    if (bridge?.stopProfiling) {
        return bridge.stopProfiling()
    }
    return { ok: false, error: 'Profiling not supported' }
}

export async function getProfilingReport() {
    const bridge = getHostBridge()
    if (bridge?.getProfilingReport) {
        return bridge.getProfilingReport()
    }
    return { ok: false, error: 'Profiling not supported' }
}
