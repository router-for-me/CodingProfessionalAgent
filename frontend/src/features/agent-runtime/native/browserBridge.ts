import {
    readWebApiJson,
    reloadForWebAuthentication,
    requireAuthenticatedResponse,
    WebAuthenticationRequiredError,
} from '@/features/web-auth/webAuthClient'
import { deserializeCapabilityError } from '@cpa/plugin-api'
import {
    createHostCapabilityFacade,
    type HostTransportApi,
} from '../../../../../src/shared/capabilityDescriptors.js'
import type { ElectronBridgeApi, NativeEvent } from '../../../../../src/shared/types.js'

/**
 * Browser adapter for host transport when running in a standard web browser.
 * Communicates with the Electron backend via WebSocket and HTTP RPC endpoints.
 */

type NativeEventCallback = (event: any) => void

interface PendingCall {
    resolve: (value: any) => void
    reject: (error: any) => void
    timer: ReturnType<typeof setTimeout>
}

export class BrowserBridgeClient implements HostTransportApi {
    private ws: WebSocket | null = null
    private pendingCalls = new Map<string, PendingCall>()
    private eventCallbacks = new Set<NativeEventCallback>()
    private onReconnectCallbacks = new Set<() => void>()
    private hasConnectedBefore = false
    private helloReceived = false
    private helloWaiters = new Set<() => void>()
    private callIdSeq = 0
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null
    private isDisposed = false
    private isAuthFailed = false
    private clientId = `client_browser_${Math.random().toString(36).slice(2)}_${Date.now()}`

    constructor(
        private onAuthenticationRequired: () => void = reloadForWebAuthentication,
    ) {
        this.connect()
    }

    getClientId(): string {
        return this.clientId
    }

    /**
     * Resolves after the WebSocket hello assigns the authoritative server clientId.
     * Only waits while the socket is still connecting; an already-open socket proceeds
     * immediately so HTTP fallback / tests are not blocked if hello is delayed.
     */
    async waitUntilReady(timeoutMs = 3000): Promise<void> {
        if (this.helloReceived || this.isDisposed || this.isAuthFailed) {
            return
        }
        if (!this.ws) {
            return
        }
        const readyState = this.ws.readyState
        const connecting = typeof WebSocket !== 'undefined' ? WebSocket.CONNECTING : 0
        if (readyState !== connecting) {
            return
        }

        await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
                this.helloWaiters.delete(onReady)
                resolve()
            }, timeoutMs)
            const onReady = () => {
                clearTimeout(timer)
                this.helloWaiters.delete(onReady)
                resolve()
            }
            this.helloWaiters.add(onReady)
            if (this.helloReceived) {
                onReady()
            }
        })
    }

    private getWsUrl(): string {
        if (typeof window === 'undefined' || !window.location) {
            return 'ws://localhost:18080/api/ws'
        }
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
        return `${protocol}//${window.location.host}/api/ws`
    }

    private connect(): void {
        if (this.isDisposed || typeof window === 'undefined' || typeof WebSocket === 'undefined') {
            return
        }

        try {
            const ws = new WebSocket(this.getWsUrl())
            this.ws = ws

            ws.onopen = () => {
                // Connection established
            }

            ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data)
                    if (data.type === 'hello' && typeof data.clientId === 'string') {
                        this.clientId = data.clientId
                        this.helloReceived = true
                        this.resolveHelloWaiters()
                        if (this.hasConnectedBefore) {
                            for (const callback of this.onReconnectCallbacks) {
                                try {
                                    callback()
                                } catch (err) {
                                    console.error('Error in onReconnect callback:', err)
                                }
                            }
                        }
                        this.hasConnectedBefore = true
                    } else if (data.type === 'rpc_result' && data.id) {
                        const pending = this.pendingCalls.get(data.id)
                        if (pending) {
                            clearTimeout(pending.timer)
                            this.pendingCalls.delete(data.id)
                            pending.resolve(data.result)
                        }
                    } else if (data.type === 'rpc_error' && data.id) {
                        const pending = this.pendingCalls.get(data.id)
                        if (pending) {
                            clearTimeout(pending.timer)
                            this.pendingCalls.delete(data.id)
                            if (data.errorDto) {
                                pending.reject(deserializeCapabilityError(data.errorDto))
                            } else if (typeof data.error === 'object' && data.error !== null) {
                                pending.reject(deserializeCapabilityError(data.error))
                            } else {
                                pending.reject(new Error(data.error || 'RPC error'))
                            }
                        }
                    } else if (data.type === 'event' && data.event) {
                        for (const callback of this.eventCallbacks) {
                            try {
                                callback(data.event)
                            } catch (err) {
                                console.error('Error in native event callback:', err)
                            }
                        }
                    }
                } catch (err) {
                    console.error('Failed to parse WebSocket message from server:', err)
                }
            }

            ws.onclose = (event) => {
                this.ws = null
                if (this.isDisposed || this.isAuthFailed) {
                    return
                }
                if (event && event.code === 4401) {
                    this.handleAuthRequired()
                    return
                }
                this.scheduleReconnect()
            }

            ws.onerror = () => {
                this.ws = null
            }
        } catch {
            this.scheduleReconnect()
        }
    }

    private resolveHelloWaiters(): void {
        for (const waiter of Array.from(this.helloWaiters)) {
            try {
                waiter()
            } catch {
                // Ignore waiter errors
            }
        }
        this.helloWaiters.clear()
    }

    private handleAuthRequired(): void {
        if (this.isAuthFailed || this.isDisposed) {
            return
        }
        this.isAuthFailed = true
        this.isDisposed = true
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer)
            this.reconnectTimer = null
        }
        this.resolveHelloWaiters()
        for (const pending of this.pendingCalls.values()) {
            clearTimeout(pending.timer)
            pending.reject(new WebAuthenticationRequiredError())
        }
        this.pendingCalls.clear()
        this.eventCallbacks.clear()
        this.onReconnectCallbacks.clear()
        if (this.ws) {
            const socket = this.ws
            this.ws = null
            try {
                socket.close()
            } catch {
                // Ignore close error
            }
        }
        this.onAuthenticationRequired()
    }

    private scheduleReconnect(): void {
        if (this.isDisposed || this.isAuthFailed || this.reconnectTimer) {
            return
        }
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null
            this.connect()
        }, 1500)
    }

    private isCapabilityHandle(value: string): boolean {
        return typeof value === 'string' && value.startsWith('cap_')
    }

    private buildRpcPayload(id: string, method: string, args: unknown[]) {
        return {
            type: 'rpc',
            id,
            method,
            args,
            clientId: this.clientId,
        }
    }

    private requestRpc<T = any>(method: string, args: unknown[] = []): Promise<T> {
        if (this.isAuthFailed) {
            return Promise.reject(new WebAuthenticationRequiredError())
        }
        if (this.isDisposed) {
            return Promise.reject(new Error('BrowserBridgeClient disposed'))
        }

        const connecting = typeof WebSocket !== 'undefined' ? WebSocket.CONNECTING : 0
        const needsHelloWait =
            !this.helloReceived && Boolean(this.ws) && this.ws!.readyState === connecting

        if (needsHelloWait) {
            return this.waitUntilReady().then(() => this.sendRpc<T>(method, args))
        }
        return this.sendRpc<T>(method, args)
    }

    private async sendRpc<T = any>(method: string, args: unknown[] = []): Promise<T> {
        if (this.isAuthFailed) {
            return Promise.reject(new WebAuthenticationRequiredError())
        }
        if (this.isDisposed) {
            return Promise.reject(new Error('BrowserBridgeClient disposed'))
        }

        const id = `rpc_${++this.callIdSeq}_${Date.now()}`
        const payload = this.buildRpcPayload(id, method, args)

        // If WebSocket is open, send via WebSocket
        const isOpen = this.ws && this.ws.readyState === (typeof WebSocket !== 'undefined' ? WebSocket.OPEN : 1)
        if (isOpen && this.ws) {
            return new Promise<T>((resolve, reject) => {
                const timer = setTimeout(() => {
                    this.pendingCalls.delete(id)
                    reject(new Error(`RPC timeout for method "${method}"`))
                }, 30000)

                this.pendingCalls.set(id, { resolve, reject, timer })
                this.ws!.send(JSON.stringify(payload))
            })
        }

        // Fallback to HTTP POST /api/rpc for immediate response if WS is connecting/down
        try {
            const rpcUrl = typeof window !== 'undefined' && window.location?.origin && window.location.origin !== 'null'
                ? `${window.location.origin}/api/rpc`
                : '/api/rpc'
            let res: Response | null = null
            try {
                res = await fetch(rpcUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                })
                requireAuthenticatedResponse(res, () => this.handleAuthRequired())
            } catch (originErr) {
                if (originErr instanceof WebAuthenticationRequiredError) {
                    throw originErr
                }
                // If local origin fetch fails and port is not 18080, try default backend port 18080
                if (typeof window !== 'undefined' && window.location?.port !== '18080') {
                    res = await fetch('http://127.0.0.1:18080/api/rpc', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload),
                    })
                    requireAuthenticatedResponse(res, () => this.handleAuthRequired())
                } else {
                    throw originErr
                }
            }

            if (!res.ok) {
                // If not ok (e.g. 404 from dev server without proxy), try default backend port 18080
                if (typeof window !== 'undefined' && window.location?.port !== '18080') {
                    const fallbackRes = await fetch('http://127.0.0.1:18080/api/rpc', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload),
                    }).catch((err) => {
                        if (err instanceof WebAuthenticationRequiredError) {
                            throw err
                        }
                        return null
                    })
                    if (fallbackRes) {
                        requireAuthenticatedResponse(fallbackRes, () => this.handleAuthRequired())
                        if (fallbackRes.ok) {
                            const data = await fallbackRes.json()
                            if (data.errorDto) throw deserializeCapabilityError(data.errorDto)
                            if (typeof data.error === 'object' && data.error !== null) throw deserializeCapabilityError(data.error)
                            if (data.error) throw new Error(data.error)
                            return data.result as T
                        }
                    }
                }
                throw new Error(`HTTP error ${res.status}: ${res.statusText}`)
            }
            const data = await res.json()
            if (data.errorDto) {
                throw deserializeCapabilityError(data.errorDto)
            }
            if (typeof data.error === 'object' && data.error !== null) {
                throw deserializeCapabilityError(data.error)
            }
            if (data.error) {
                throw new Error(data.error)
            }
            return data.result as T
        } catch (httpErr) {
            if (httpErr instanceof WebAuthenticationRequiredError) {
                throw httpErr
            }
            if (this.isAuthFailed || this.isDisposed) {
                throw httpErr
            }
            // If HTTP also fails and WS might connect soon, wait on WS if connecting
            if (this.ws && this.ws.readyState === (typeof WebSocket !== 'undefined' ? WebSocket.CONNECTING : 0)) {
                return new Promise<T>((resolve, reject) => {
                    const timer = setTimeout(() => {
                        this.pendingCalls.delete(id)
                        reject(httpErr)
                    }, 10000)

                    this.pendingCalls.set(id, { resolve, reject, timer })
                    const onOpen = () => {
                        this.ws?.send(JSON.stringify(payload))
                    }
                    this.ws?.addEventListener('open', onOpen, { once: true })
                })
            }
            throw httpErr
        }
    }

    async invoke<T = any>(
        handleOrMethod: string,
        methodOrFirstArg?: unknown,
        ...restArgs: unknown[]
    ): Promise<T> {
        let handle: string | null = null
        let method: string
        let args: unknown[]

        if (typeof methodOrFirstArg === 'string' && Array.isArray(restArgs[0])) {
            handle = handleOrMethod
            method = methodOrFirstArg
            args = restArgs[0]
        } else {
            method = handleOrMethod
            if (methodOrFirstArg !== undefined) {
                args = [methodOrFirstArg, ...restArgs]
            } else {
                args = []
            }
        }

        if (handle && this.isCapabilityHandle(handle)) {
            return this.requestRpc<T>('capability:invoke', [{ handle, method, args }])
        }

        return this.requestRpc<T>(method, args)
    }

    async grantTicket(ticket: string): Promise<unknown> {
        if (!ticket || typeof ticket !== 'string' || !ticket.trim()) {
            throw new Error('Invalid capability grant ticket')
        }
        return this.requestRpc('capability:grant', [{ ticket }])
    }

    onNativeEvent(callback: NativeEventCallback): () => void {
        this.eventCallbacks.add(callback)
        return () => {
            this.eventCallbacks.delete(callback)
        }
    }

    subscribeNativeEvents(listener: (event: NativeEvent) => void): () => void {
        return this.onNativeEvent(listener)
    }

    subscribe(
        _handle: string,
        eventName: string,
        listener: (payload: unknown) => void,
    ): () => void {
        // Web clients already receive native events via the shared WS broadcast.
        // Filter locally by event name; authorization was enforced when the handle was granted.
        if (eventName === 'native-event') {
            return this.subscribeNativeEvents((event) => listener(event))
        }
        return () => {}
    }

    onReconnect(callback: () => void): () => void {
        this.onReconnectCallbacks.add(callback)
        return () => {
            this.onReconnectCallbacks.delete(callback)
        }
    }

    dispose(): void {
        this.isDisposed = true
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer)
            this.reconnectTimer = null
        }
        this.resolveHelloWaiters()
        for (const pending of this.pendingCalls.values()) {
            clearTimeout(pending.timer)
            pending.reject(new Error('BrowserBridgeClient disposed'))
        }
        this.pendingCalls.clear()
        this.eventCallbacks.clear()
        this.onReconnectCallbacks.clear()
        if (this.ws) {
            const socket = this.ws
            this.ws = null
            try {
                socket.close()
            } catch {
                // Ignore close error
            }
        }
    }
}

export async function saveFileInBrowser(options: {
    defaultPath?: string
    title?: string
    content: string
    filters?: Array<{ name: string; extensions: string[] }>
}): Promise<{ saved: boolean; filePath?: string }> {
    try {
        if (typeof document === 'undefined' || typeof window === 'undefined') {
            return { saved: false }
        }
        const blob = new Blob([options.content ?? ''], { type: 'text/markdown;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        const filename = options.defaultPath
            ? options.defaultPath.split(/[/\\]/).pop() || options.defaultPath
            : 'download.md'
        a.href = url
        a.download = filename
        a.style.display = 'none'
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        setTimeout(() => {
            try {
                URL.revokeObjectURL(url)
            } catch {
                // Ignore revoke error
            }
        }, 1000)
        return { saved: true, filePath: filename }
    } catch {
        return { saved: false }
    }
}

/**
 * Creates a browser-compatible host bridge object.
 */
export function createBrowserBridge(client?: BrowserBridgeClient): ElectronBridgeApi {
    const c = client || new BrowserBridgeClient()
    const baseFacade = createHostCapabilityFacade(c, c.getClientId())

    const browserBridge: ElectronBridgeApi = {
        ...baseFacade,
        ClipboardSetText: async (text: string) => {
            try {
                if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
                    await navigator.clipboard.writeText(text)
                }
            } catch {
                // Ignore browser clipboard errors
            }
            return c.invoke(c.getClientId(), 'native:clipboardSetText', [text]) as Promise<void>
        },
        ClipboardGetText: async () => {
            try {
                if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
                    const text = await navigator.clipboard.readText()
                    if (text) return text
                }
            } catch {
                // Ignore browser clipboard errors
            }
            return c.invoke(c.getClientId(), 'native:clipboardGetText', []) as Promise<string>
        },
        SaveFile: (options: { defaultPath?: string; title?: string; content: string; filters?: Array<{ name: string; extensions: string[] }> }) =>
            saveFileInBrowser(options),
        saveFile: (options: { defaultPath?: string; title?: string; content: string; filters?: Array<{ name: string; extensions: string[] }> }) =>
            saveFileInBrowser(options),
        startProfiling: async (options?: { durationMs?: number; target?: string }) => {
            return fetch('/api/profile/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(options || {}),
            }).then((r) => readWebApiJson(r))
        },
        stopProfiling: async () => {
            return fetch('/api/profile/stop', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            }).then((r) => readWebApiJson(r))
        },
        getProfilingReport: async () => {
            return fetch('/api/profile/report').then((r) => readWebApiJson(r))
        },
        SessionBroadcastRunStatus: (sessionId: string, status: 'running' | 'thinking' | 'tool' | 'idle', runId: string, clientId: string) =>
            c.invoke(c.getClientId(), 'session:broadcastRunStatus', [sessionId, status, runId, clientId || c.getClientId()]) as Promise<void>,
    }

    return browserBridge
}

/**
 * Initializes browser transport client when running in browser without Electron preload.
 *
 * Kept for startup sequencing compatibility with main.tsx / WebAuthGate tests.
 * The shared BrowserBridgeClient is created lazily by hostTransport.getHostTransport()
 * when persistence bootstrap needs the desktop host KV store.
 */
export function initBrowserBridge(): void {
    // No-op by design: constructing the client here would create a circular import with
    // hostTransport.ts. getNativeStore()/getHostBridge() warm the transport on demand.
}
