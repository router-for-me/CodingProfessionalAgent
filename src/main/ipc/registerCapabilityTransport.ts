import { ipcMain, type BrowserWindow, type WebContents } from 'electron'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
    type CapabilityHandle,
    type CapabilityInvocationContext,
    type CapabilityInvokeResponse,
    PluginCapabilityError,
    isValidCapabilityPattern,
    serializeCapabilityError,
} from '@cpa/plugin-api'
import type { MainCapabilityBroker } from '../plugins/capabilities/MainCapabilityBroker.js'
import { RENDERER_CAPABILITY_DESCRIPTORS } from '../../shared/capabilityDescriptors.js'
import type { AppServices } from './registerIpcHandlers.js'
import { extractTrustedInvocationContext } from './extractTrustedContext.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
function resolveDefaultOfficialIndexHtml(): string {
    const candidates = [
        path.resolve(__dirname, '../../../../frontend/dist/index.html'),
        path.resolve(__dirname, '../../../frontend/dist/index.html'),
        path.resolve(process.cwd(), 'frontend/dist/index.html'),
    ]
    for (const p of candidates) {
        try {
            if (fs.existsSync(p)) return p
        } catch {}
    }
    return candidates[0]
}
const DEFAULT_OFFICIAL_INDEX_HTML = resolveDefaultOfficialIndexHtml()

export interface RegisterCapabilityTransportOptions {
    broker: MainCapabilityBroker
    services?: AppServices
    getMainWindow?: () => BrowserWindow | null
    /**
     * Explicitly allowed local filesystem paths for renderer html (e.g. ['/path/to/frontend/dist/index.html'])
     */
    trustedFilePaths?: string[]
    /**
     * Explicitly allowed exact canonical URLs (e.g. ['http://localhost:5173/', 'cpa://app/index.html'])
     * Scheme, host, and normalized decoded pathname must match. Query and hash may vary.
     */
    trustedUrls?: string[]
    /**
     * Optional custom predicate for dependency injection in tests
     */
    isTrustedUrl?: (url: string) => boolean
}

const activeIpcSubscriptions = new Map<string, () => void>()
const webContentsSubscriptions = new Map<WebContents, Set<string>>()
const claimedDocuments = new Set<string>()
const senderHostHandles = new Map<string, CapabilityHandle>()

interface WebContentsNavigationBinding {
    navListener: (navEvt: any) => void
    destroyedListener?: () => void
}
const webContentsNavBindings = new Map<WebContents, WebContentsNavigationBinding>()

function cleanupWebContentsState(webContents: WebContents, broker: MainCapabilityBroker): void {
    // 1. Revoke and clean handles belonging to this webContents
    for (const [k, h] of Array.from(senderHostHandles.entries())) {
        if (k.startsWith(`${webContents.id}:`)) {
            try {
                broker.revokeHandle(h)
            } catch {
                // Ignore cleanup error on already-revoked handles
            }
            senderHostHandles.delete(k)
            claimedDocuments.delete(k)
        }
    }

    // 2. Unsubscribe and clean IPC subscriptions belonging to this webContents
    const subs = webContentsSubscriptions.get(webContents)
    if (subs) {
        for (const key of subs) {
            const storedUnsub = activeIpcSubscriptions.get(key)
            if (storedUnsub) {
                try {
                    storedUnsub()
                } catch {
                    // Ignore disposal error
                }
                activeIpcSubscriptions.delete(key)
            }
        }
        webContentsSubscriptions.delete(webContents)
    }
}

/**
 * Normalizes and decodes a URL pathname for strict exact matching.
 * Rejects path traversals ('..', '.'), double leading slashes, backslashes, NUL bytes, or decoding failures.
 */
function getCanonicalUrlPathname(rawPathname: string): string | null {
    // 1. Reject double leading slash (protocol-relative / path confusion)
    if (rawPathname.startsWith('//')) {
        return null
    }

    // 2. Decode percent-encoding
    let decoded: string
    try {
        decoded = decodeURIComponent(rawPathname || '/')
    } catch {
        return null
    }

    // 3. Reject NUL byte or backslash in decoded path
    if (decoded.includes('\0') || decoded.includes('\\')) {
        return null
    }

    // 4. Reject path traversal segments ('..' or '.')
    const segments = decoded.split('/')
    for (const seg of segments) {
        if (seg === '..' || seg === '.') {
            return null
        }
    }

    // 5. Posix normalize
    const normalized = path.posix.normalize(decoded)
    if (normalized.startsWith('//') || normalized.startsWith('../') || normalized === '..') {
        return null
    }

    return normalized
}

/**
 * Validates whether a given renderer frame URL is a controlled official application URL.
 * Strictly verifies against immutable startup configuration and canonical realpaths.
 * Never dynamically trusts navigated webContents.getURL().
 */
export function isControlledAppUrl(
    url: string | undefined | null,
    options: Pick<RegisterCapabilityTransportOptions, 'trustedFilePaths' | 'trustedUrls' | 'isTrustedUrl'> = {},
): boolean {
    if (!url || typeof url !== 'string') {
        return false
    }
    const trimmedUrl = url.trim()
    if (!trimmedUrl) {
        return false
    }

    if (typeof options.isTrustedUrl === 'function') {
        return options.isTrustedUrl(trimmedUrl)
    }

    // 1. Security filters on raw URL string:
    // Reject NUL bytes (raw or percent-encoded)
    if (trimmedUrl.includes('\0') || /%00/i.test(trimmedUrl)) {
        return false
    }
    // Reject encoded slashes (%2f) and encoded backslashes (%5c)
    if (/%2f|%5c/i.test(trimmedUrl)) {
        return false
    }
    // Reject protocol-relative leading double slashes
    if (trimmedUrl.startsWith('//')) {
        return false
    }
    // Reject raw backslashes in URL string
    if (trimmedUrl.includes('\\')) {
        return false
    }

    let parsed: URL
    try {
        parsed = new URL(trimmedUrl)
    } catch {
        return false
    }

    // 2. Reject credentials (user:pass@host)
    if (parsed.username || parsed.password) {
        return false
    }

    // 3. Strictly reject isolated plugin protocol or dangerous pseudoprotocols
    if (
        parsed.protocol === 'cpa-plugin:' ||
        parsed.protocol === 'javascript:' ||
        parsed.protocol === 'data:' ||
        parsed.protocol === 'blob:'
    ) {
        return false
    }

    // 4. file: protocol - strictly validate canonical local file path
    if (parsed.protocol === 'file:') {
        let filePath: string
        try {
            filePath = fileURLToPath(parsed.href)
        } catch {
            return false
        }

        const normalizedInputPath = path.normalize(path.resolve(filePath))
        let realInputPath = normalizedInputPath
        try {
            if (fs.existsSync(normalizedInputPath)) {
                realInputPath = fs.realpathSync.native(normalizedInputPath)
            }
        } catch {
            // Ignore filesystem query errors (e.g. in non-existent mock paths)
        }

        const allowedPaths = options.trustedFilePaths ?? [DEFAULT_OFFICIAL_INDEX_HTML]

        for (const allowedPath of allowedPaths) {
            const normalizedAllowed = path.normalize(path.resolve(allowedPath))
            let realAllowed = normalizedAllowed
            try {
                if (fs.existsSync(normalizedAllowed)) {
                    realAllowed = fs.realpathSync.native(normalizedAllowed)
                }
            } catch {
                // Ignore
            }

            if (
                realInputPath === realAllowed ||
                normalizedInputPath === normalizedAllowed
            ) {
                return true
            }
        }

        return false
    }

    // 5. Canonical URL matching against configured trustedUrls (or VITE_DEV_SERVER_URL fallback).
    // - http:/https: trust by origin (scheme + host + port). SPA client routes like /chat/:id
    //   must remain trusted; top-level-frame + main-window gates still apply.
    // - other schemes (e.g. cpa:) require exact normalized pathname match.
    // Query parameters and hash fragments may vary in both cases.
    const candidateTrustedUrls: string[] = []
    if (options.trustedUrls && options.trustedUrls.length > 0) {
        candidateTrustedUrls.push(...options.trustedUrls)
    } else {
        // Dev server environment fallback
        const devUrl = process.env.VITE_DEV_SERVER_URL || process.env.ELECTRON_RENDERER_URL
        if (devUrl) {
            candidateTrustedUrls.push(devUrl)
        }
    }

    if (candidateTrustedUrls.length === 0) {
        return false
    }

    // Reject path traversal (%2e%2e, %2e, /../, /./) and double-slash confusion in raw URL path
    const rawUrlWithoutQueryHash = trimmedUrl.split(/[?#]/)[0]
    if (/%2e/i.test(rawUrlWithoutQueryHash)) {
        return false
    }
    const authorityMatch = rawUrlWithoutQueryHash.match(/^[a-zA-Z0-9+.-]+:\/\/[^/]+(\/.*)?$/)
    if (authorityMatch) {
        const rawPath = authorityMatch[1] ?? '/'
        if (rawPath.startsWith('//')) {
            return false
        }
        if (/\/\.\.(\/|$)/.test(rawPath) || /\/\.(\/|$)/.test(rawPath)) {
            return false
        }
    }

    const isHttpFamily = parsed.protocol === 'http:' || parsed.protocol === 'https:'
    const inputCanonicalPath = isHttpFamily ? null : getCanonicalUrlPathname(parsed.pathname)
    if (!isHttpFamily && !inputCanonicalPath) {
        return false
    }

    for (const trustedUrlStr of candidateTrustedUrls) {
        let parsedTrusted: URL
        try {
            parsedTrusted = new URL(trustedUrlStr)
        } catch {
            continue
        }

        // Must match protocol (case-insensitive)
        if (parsed.protocol.toLowerCase() !== parsedTrusted.protocol.toLowerCase()) {
            continue
        }

        // Must match host (hostname:port, case-insensitive)
        if (parsed.host.toLowerCase() !== parsedTrusted.host.toLowerCase()) {
            continue
        }

        if (isHttpFamily) {
            // Origin match is sufficient for the official SPA shell.
            return true
        }

        // Non-http(s) schemes keep exact normalized pathname matching.
        const trustedCanonicalPath = getCanonicalUrlPathname(parsedTrusted.pathname)
        if (!trustedCanonicalPath) {
            continue
        }

        if (inputCanonicalPath === trustedCanonicalPath) {
            return true
        }
    }

    return false
}

const STANDARD_CAPABILITY_EVENTS: ReadonlyArray<{ event: string; capability: string }> = Object.freeze([
    { event: 'session:created', capability: 'sessions.read' },
    { event: 'session:updated', capability: 'sessions.read' },
    { event: 'session:deleted', capability: 'sessions.read' },
    { event: 'session:meta-updated', capability: 'sessions.read' },
    { event: 'session:run-status', capability: 'sessions.read' },
    { event: 'session:stream-event', capability: 'sessions.read' },
    { event: 'session:subagent-state', capability: 'sessions.read' },
    { event: 'session:active-runs', capability: 'sessions.read' },
    { event: 'session:resume-prompt-sync', capability: 'sessions.read' },
    { event: 'projects:updated', capability: 'projects.read' },
    { event: 'schedule:updated', capability: 'schedule.read' },
    { event: 'schedule:triggered', capability: 'schedule.read' },
    // Operational native stream used by PTY/process/websocket capability clients.
    { event: 'native-event', capability: 'pty.spawn' },
])

/**
 * Registers standard capability descriptors, event mappings, and fixed IPC transport channels on Electron ipcMain.
 */
export function registerCapabilityTransport(options: RegisterCapabilityTransportOptions): () => void {
    const { broker, services } = options

    // 1. Register all RENDERER_CAPABILITY_DESCRIPTORS into broker if services is provided
    const unregisterDisposers: Array<() => void> = []
    if (services) {
        for (const desc of RENDERER_CAPABILITY_DESCRIPTORS) {
            const unreg = broker.register({
                method: desc.method,
                capability: desc.capability,
                validate(args: unknown[]): asserts args is unknown[] {
                    if (args !== undefined && !Array.isArray(args)) {
                        throw new Error('Arguments must be an array')
                    }
                },
                invoke: async (ctx, ...args) => {
                    return services.handleMethod(desc.method, args, {
                        pluginId: ctx.pluginId,
                        senderId: ctx.senderId,
                        frameUrl: ctx.frameUrl,
                        transport: ctx.transport,
                        clientId: ctx.clientId ?? ctx.pluginId,
                        processId: ctx.processId,
                        routingId: ctx.routingId,
                        documentId: ctx.documentId,
                        runtime: ctx.runtime,
                    })
                },
            })
            unregisterDisposers.push(unreg)
        }
    }

    // 2. Register standard events
    for (const evt of STANDARD_CAPABILITY_EVENTS) {
        const unreg = broker.registerEvent(evt.event, evt.capability)
        unregisterDisposers.push(unreg)
    }

    // 3. Register fixed IPC handler: cpa:capability:bootstrap (One-time Host platform capability bootstrap)
    const bootstrapHandler = async (
        event: Electron.IpcMainInvokeEvent,
    ): Promise<CapabilityInvokeResponse<string>> => {
        const mainWindow = options.getMainWindow ? options.getMainWindow() : null

        // 1. Validate sender window: must be from the main window if mainWindow is configured
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
            if (event.sender !== mainWindow.webContents) {
                return {
                    ok: false,
                    error: serializeCapabilityError(
                        new PluginCapabilityError('Host capability bootstrap only allowed from main window'),
                    ),
                }
            }
        }

        // 2. Validate senderFrame: must be top-level frame (no parent)
        const senderFrame = event.senderFrame as any
        if (senderFrame) {
            if (senderFrame.parent !== null && senderFrame.parent !== undefined) {
                return {
                    ok: false,
                    error: serializeCapabilityError(
                        new PluginCapabilityError('Host capability bootstrap only allowed from top-level frame'),
                    ),
                }
            }
            const mainFrame = (event.sender as any)?.mainFrame
            if (mainFrame && senderFrame !== mainFrame) {
                return {
                    ok: false,
                    error: serializeCapabilityError(
                        new PluginCapabilityError('Host capability bootstrap only allowed from top-level frame'),
                    ),
                }
            }
        }

        const trustedContext = extractTrustedInvocationContext(event)

        // 3. Validate controlled app URL
        if (!isControlledAppUrl(trustedContext.frameUrl, options)) {
            return {
                ok: false,
                error: serializeCapabilityError(
                    new PluginCapabilityError('Untrusted frame URL for host bootstrap'),
                ),
            }
        }

        // 4. Per-document claim: return existing valid handle, or re-grant if revoked
        const documentId = trustedContext.documentId ?? senderFrame?.routingId?.toString() ?? 'doc_main'
        const docKey = `${trustedContext.senderId}:${documentId}`

        const existingHandle = senderHostHandles.get(docKey)
        if (existingHandle && broker.getHandle(existingHandle)) {
            return { ok: true, value: existingHandle as string }
        }
        if (existingHandle) {
            // Stale mapping left behind after an external revoke — allow re-claim.
            senderHostHandles.delete(docKey)
            claimedDocuments.delete(docKey)
        }

        claimedDocuments.add(docKey)

        // 5. Derive platform capabilities dynamically from descriptors
        const platformCapabilities = Array.from(
            new Set([
                ...RENDERER_CAPABILITY_DESCRIPTORS.map((d) => d.capability),
                'sessions.*',
                'projects.*',
                'filesystem.*',
                'system.*',
                'process.*',
                'network.*',
                'storage.*',
                'tray.*',
                'power.*',
                'plugins.*',
                'window.*',
                'git.*',
                'dialog.*',
                'notification.*',
                'terminal.*',
                'models.*',
                'kv.*',
                'profiling.*',
                'webserver.*',
            ]),
        ).filter((c) => isValidCapabilityPattern(c))

        try {
            // Host platform handles use generation 0 so plugin generation commits
            // (revokeGenerationAll(n>=1)) never revoke the renderer host bridge.
            const handle = broker.grant(
                {
                    pluginId: 'desktop-main',
                    senderId: trustedContext.senderId,
                    frameUrl: trustedContext.frameUrl,
                    transport: 'electron',
                    runtime: 'renderer',
                    documentId: trustedContext.documentId,
                    processId: trustedContext.processId,
                    routingId: trustedContext.routingId,
                    generation: 0,
                },
                platformCapabilities,
                0,
            )

            senderHostHandles.set(docKey, handle)

            // Setup navigation / lifecycle cleanup to revoke handle on reload (at most one listener per WebContents)
            const webContents = event.sender
            if (webContents && typeof webContents.on === 'function') {
                if (!webContentsNavBindings.has(webContents)) {
                    const navListener = (navEvt: any) => {
                        if (navEvt?.isMainFrame ?? true) {
                            cleanupWebContentsState(webContents, broker)
                        }
                    }

                    const destroyedListener = () => {
                        cleanupWebContentsState(webContents, broker)
                        const binding = webContentsNavBindings.get(webContents)
                        if (binding) {
                            webContentsNavBindings.delete(webContents)
                            try {
                                if (typeof webContents.removeListener === 'function') {
                                    webContents.removeListener('did-start-navigation', binding.navListener)
                                }
                            } catch {
                                // Ignore removal error
                            }
                        }
                    }

                    webContents.on('did-start-navigation', navListener)
                    if (typeof webContents.once === 'function') {
                        webContents.once('destroyed', destroyedListener)
                    }

                    webContentsNavBindings.set(webContents, {
                        navListener,
                        destroyedListener,
                    })
                }
            }

            return { ok: true, value: handle as string }
        } catch (err) {
            claimedDocuments.delete(docKey)
            senderHostHandles.delete(docKey)
            return { ok: false, error: serializeCapabilityError(err) }
        }
    }

    // 4. Register fixed IPC handler: cpa:capability:grant (Redeem grant ticket)
    const grantHandler = async (
        event: Electron.IpcMainInvokeEvent,
        request: { ticket: string },
    ): Promise<CapabilityInvokeResponse<string>> => {
        if (!request || typeof request.ticket !== 'string' || !request.ticket.trim()) {
            return {
                ok: false,
                error: serializeCapabilityError(
                    new PluginCapabilityError('Invalid capability grant request: ticket is required'),
                ),
            }
        }

        const trustedContext = extractTrustedInvocationContext(event)

        try {
            const handle = broker.redeemGrantTicket(request.ticket, trustedContext)
            return { ok: true, value: handle as string }
        } catch (err) {
            return { ok: false, error: serializeCapabilityError(err) }
        }
    }

    // 4. Register fixed IPC handler: cpa:capability:invoke
    const invokeHandler = async (
        event: Electron.IpcMainInvokeEvent,
        requestOrHandle: { handle: string; method: string; args?: unknown[] } | string,
        methodArg?: string,
        argsArg?: unknown[],
    ): Promise<CapabilityInvokeResponse> => {
        let handle: string
        let method: string
        let args: unknown[] = []

        if (
            typeof requestOrHandle === 'object' &&
            requestOrHandle !== null &&
            'handle' in requestOrHandle &&
            'method' in requestOrHandle
        ) {
            handle = requestOrHandle.handle
            method = requestOrHandle.method
            args = requestOrHandle.args ?? []
        } else if (typeof requestOrHandle === 'string' && typeof methodArg === 'string') {
            handle = requestOrHandle
            method = methodArg
            args = argsArg ?? []
        } else {
            return {
                ok: false,
                error: serializeCapabilityError(
                    new PluginCapabilityError('Invalid capability invoke request payload'),
                ),
            }
        }

        // Construct trusted invocation context from event.sender / event.senderFrame
        const trustedContext = extractTrustedInvocationContext(event)

        try {
            const value = await broker.invoke(handle as CapabilityHandle, method, args, trustedContext)
            return { ok: true, value }
        } catch (err) {
            return { ok: false, error: serializeCapabilityError(err) }
        }
    }

    // 5. Register fixed IPC handler: cpa:capability:subscribe
    const subscribeHandler = async (
        event: Electron.IpcMainInvokeEvent,
        request: { handle: string; eventName: string; subscriptionId: string },
    ): Promise<CapabilityInvokeResponse<boolean>> => {
        if (!request || !request.handle || !request.eventName || !request.subscriptionId) {
            return {
                ok: false,
                error: serializeCapabilityError(new PluginCapabilityError('Invalid subscribe request')),
            }
        }

        const trustedContext = extractTrustedInvocationContext(event)
        const senderId = trustedContext.senderId
        const webContents = event.sender
        const subKey = `${senderId}:${request.subscriptionId}`

        try {
            const unsub = broker.subscribe(
                request.handle as CapabilityHandle,
                request.eventName,
                (payload) => {
                    if (webContents && !webContents.isDestroyed()) {
                        try {
                            webContents.send(
                                `cpa:capability:event:${request.subscriptionId}`,
                                payload,
                            )
                        } catch {
                            // Ignored if window closed
                        }
                    }
                },
                trustedContext,
            )

            activeIpcSubscriptions.set(subKey, unsub)

            // Attach at most ONE destroyed listener per WebContents
            if (webContents && typeof webContents.once === 'function') {
                let subSet = webContentsSubscriptions.get(webContents)
                if (!subSet) {
                    subSet = new Set<string>()
                    webContentsSubscriptions.set(webContents, subSet)
                    webContents.once('destroyed', () => {
                        const subs = webContentsSubscriptions.get(webContents)
                        if (subs) {
                            for (const key of subs) {
                                const storedUnsub = activeIpcSubscriptions.get(key)
                                if (storedUnsub) {
                                    try {
                                        storedUnsub()
                                    } catch {
                                        // Ignore disposal error
                                    }
                                    activeIpcSubscriptions.delete(key)
                                }
                            }
                            webContentsSubscriptions.delete(webContents)
                        }
                    })
                }
                subSet.add(subKey)
            }

            return { ok: true, value: true }
        } catch (err) {
            return { ok: false, error: serializeCapabilityError(err) }
        }
    }

    // 6. Register fixed IPC handler: cpa:capability:unsubscribe
    const unsubscribeHandler = async (
        event: Electron.IpcMainInvokeEvent,
        subscriptionId: string,
    ): Promise<CapabilityInvokeResponse<boolean>> => {
        const senderId = event.sender?.id ?? 0
        const subKey = `${senderId}:${subscriptionId}`

        const webContents = event.sender
        if (webContents) {
            const subSet = webContentsSubscriptions.get(webContents)
            if (subSet) {
                subSet.delete(subKey)
                if (subSet.size === 0) {
                    webContentsSubscriptions.delete(webContents)
                }
            }
        }

        const unsub = activeIpcSubscriptions.get(subKey)
        if (unsub) {
            unsub()
            activeIpcSubscriptions.delete(subKey)
            return { ok: true, value: true }
        }
        return { ok: true, value: false }
    }

    if (typeof ipcMain?.handle === 'function') {
        ipcMain.handle('cpa:capability:bootstrap', bootstrapHandler)
        ipcMain.handle('cpa:capability:grant', grantHandler)
        ipcMain.handle('cpa:capability:invoke', invokeHandler)
        ipcMain.handle('cpa:capability:subscribe', subscribeHandler)
        ipcMain.handle('cpa:capability:unsubscribe', unsubscribeHandler)
    }

    return () => {
        if (typeof ipcMain?.removeHandler === 'function') {
            ipcMain.removeHandler('cpa:capability:bootstrap')
            ipcMain.removeHandler('cpa:capability:grant')
            ipcMain.removeHandler('cpa:capability:invoke')
            ipcMain.removeHandler('cpa:capability:subscribe')
            ipcMain.removeHandler('cpa:capability:unsubscribe')
        }
        for (const unreg of unregisterDisposers) {
            unreg()
        }
        for (const unsub of activeIpcSubscriptions.values()) {
            try {
                unsub()
            } catch {
                // Ignore cleanup error
            }
        }
        activeIpcSubscriptions.clear()
        webContentsSubscriptions.clear()
        claimedDocuments.clear()
        for (const h of senderHostHandles.values()) {
            try {
                broker.revokeHandle(h)
            } catch {
                // Ignore cleanup error
            }
        }
        senderHostHandles.clear()
        for (const [wc, binding] of webContentsNavBindings.entries()) {
            try {
                if (typeof wc.removeListener === 'function') {
                    wc.removeListener('did-start-navigation', binding.navListener)
                    if (binding.destroyedListener) {
                        wc.removeListener('destroyed', binding.destroyedListener)
                    }
                }
            } catch {
                // Ignore cleanup error
            }
        }
        webContentsNavBindings.clear()
    }
}
