import type {
    AskRequestedNotificationPayload,
    NotificationClientRegistration,
    NotificationClientUnregistration,
    NotificationDestination,
    NotificationEnvironment,
    RegisteredNotificationClient,
} from '../../shared/types.js'
import {
    MAX_APNS_COLLAPSE_ID_BYTES,
    formatAskRequestedNotificationBody,
    formatTaskCompletedNotificationBody,
    sliceUtf8Bytes,
    truncateSessionTitleForData,
} from './notificationFormatting.js'

export type {
    AskRequestedNotificationPayload,
    NotificationClientRegistration,
    NotificationClientUnregistration,
    NotificationEnvironment,
    RegisteredNotificationClient,
} from '../../shared/types.js'

export const DEFAULT_APNS_PUSH_URL = 'https://cdpa-notification.router-for.me/v1/push'
export const NOTIFICATION_CLIENTS_STORAGE_KEY = 'notification-clients'
export const DEFAULT_APNS_PUSH_TIMEOUT_MS = 10_000

const DEVICE_TOKEN_HEX_RE = /^[0-9a-f]{64,200}$/
const MAX_APNS_THREAD_ID_LENGTH = 128
const MAX_FCM_DEVICE_TOKEN_BYTES = 4096
const FCM_RETRY_MIN_MS = 60_000
const FCM_RETRY_WINDOW_MS = 5 * 60_000
const MAX_FCM_RETRIES_PENDING = 128

export interface TaskCompletedPushPayload {
    sessionId: string
    sessionTitle?: string
}

export type AskRequestedPushPayload = AskRequestedNotificationPayload

export interface KVStoreLike {
    get(key: string): Promise<unknown> | unknown
    set(key: string, value: unknown): Promise<void> | void
    save(): Promise<void> | void
}

export type FetchLike = (
    input: string | URL | Request,
    init?: RequestInit,
) => Promise<Response>

export interface ApnsPushLogger {
    warn?: (...args: unknown[]) => void
    error?: (...args: unknown[]) => void
}

export interface ApnsPushServiceOptions {
    kvStoreGetter: () => KVStoreLike | null | undefined
    pushUrl?: string
    fetchFn?: FetchLike
    timeoutMs?: number
    now?: () => number
    logger?: ApnsPushLogger
}

interface StaleClientRecord {
    clientId: string
    connectionId: string
    deviceToken: string
    platform: RegisteredNotificationClient['platform']
    environment?: NotificationEnvironment
}

function sameDestination(left: StaleClientRecord, right: StaleClientRecord): boolean {
    return left.clientId === right.clientId && left.connectionId === right.connectionId &&
        left.platform === right.platform && left.environment === right.environment && left.deviceToken === right.deviceToken
}

function retryAt(retryAfter: string | null, now: number): number {
    if (!retryAfter) return now + FCM_RETRY_MIN_MS
    const requested = /^\d+$/.test(retryAfter) ? now + Number(retryAfter) * 1000 : Date.parse(retryAfter)
    return Math.max(now + FCM_RETRY_MIN_MS, Number.isNaN(requested) ? 0 : requested)
}

function normalizeNonEmptyString(value: unknown, fieldName: string): string {
    if (typeof value !== 'string') {
        throw new Error(`Invalid ${fieldName}: expected a non-empty string`)
    }
    const trimmed = value.trim()
    if (!trimmed) {
        throw new Error(`Invalid ${fieldName}: must not be empty`)
    }
    return trimmed
}

function normalizeDeviceToken(value: unknown): string {
    if (typeof value !== 'string') {
        throw new Error('Invalid deviceToken: expected a hex string')
    }
    const normalized = value.trim().toLowerCase()
    if (!DEVICE_TOKEN_HEX_RE.test(normalized)) {
        throw new Error('Invalid deviceToken: must be 64 to 200 hexadecimal characters')
    }
    return normalized
}

function normalizeEnvironment(value: unknown): NotificationEnvironment {
    if (value === 'production' || value === 'sandbox') {
        return value
    }
    throw new Error('Invalid environment: must be "production" or "sandbox"')
}

function normalizeOptionalString(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined
    }
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
}

// Registration RPC arguments and legacy settings both cross an untyped boundary.
function normalizeDestination(input: {
    provider?: unknown
    platform?: unknown
    deviceToken?: unknown
    environment?: unknown
}): NotificationDestination & { platform: 'ios' | 'android' } {
    if (input.provider === 'fcm') {
        if (input.platform !== 'android' || input.environment !== undefined) {
            throw new Error('FCM requires Android without an APNs environment')
        }
        const token = input.deviceToken
        if (typeof token !== 'string' || !token ||
            Buffer.byteLength(token) > MAX_FCM_DEVICE_TOKEN_BYTES || /[\s\p{Cc}]/u.test(token)) {
            throw new Error('Invalid FCM deviceToken')
        }
        return { provider: 'fcm', platform: 'android', deviceToken: token }
    }
    if ((input.provider !== undefined && input.provider !== 'apns') ||
        (input.platform !== undefined && input.platform !== 'ios')) {
        throw new Error('Unsupported push provider or platform')
    }
    return {
        platform: 'ios',
        deviceToken: normalizeDeviceToken(input.deviceToken),
        environment: normalizeEnvironment(input.environment),
    }
}

function sanitizeStoredClients(raw: unknown): RegisteredNotificationClient[] {
    if (!Array.isArray(raw)) {
        return []
    }
    const result: RegisteredNotificationClient[] = []
    for (const item of raw) {
        if (!item || typeof item !== 'object') continue
        const clientId = normalizeOptionalString(item.clientId)
        const connectionId = normalizeOptionalString(item.connectionId)
        if (!clientId || !connectionId) continue
        let destination: ReturnType<typeof normalizeDestination>
        try {
            destination = normalizeDestination(item)
        } catch {
            // Ignore corrupt or unsupported entries without blocking other clients.
            continue
        }
        const deviceName = normalizeOptionalString(item.deviceName)
        const appVersion = normalizeOptionalString(item.appVersion)
        result.push({
            clientId,
            connectionId,
            ...destination,
            ...(deviceName ? { deviceName } : {}),
            ...(appVersion ? { appVersion } : {}),
            enabled: typeof item.enabled === 'boolean' ? item.enabled : true,
            registeredAt: Number.isFinite(item.registeredAt) ? item.registeredAt : 0,
            updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : 0,
        })
    }
    return result
}

interface TurnNotification {
    notificationType: 'taskCompleted' | 'ask'
    sessionId: string
    bodyText: string
    collapseId?: string
    dataSessionTitle?: string
}

function buildGatewayRequest(client: RegisteredNotificationClient, event: TurnNotification) {
    const route = { connectionId: client.connectionId, sessionId: event.sessionId }
    if (client.provider === 'fcm') {
        return {
            provider: 'fcm',
            deviceToken: client.deviceToken,
            data: { ...route, notificationType: event.notificationType },
        }
    }
    return {
        deviceToken: client.deviceToken,
        environment: client.environment,
        title: 'Coding Professional Agent',
        body: event.bodyText,
        sound: 'default',
        threadId: event.sessionId.slice(0, MAX_APNS_THREAD_ID_LENGTH),
        collapseId: event.collapseId,
        data: {
            ...route,
            ...(event.dataSessionTitle ? { sessionTitle: event.dataSessionTitle } : {}),
            ...(event.notificationType === 'ask' ? { notificationType: 'ask' } : {}),
        },
    }
}

/**
 * Manages mobile client registrations in settings.json and dispatches push
 * notifications asynchronously when top-level tasks complete.
 */
export class ApnsPushService {
    private readonly kvStoreGetter: () => KVStoreLike | null | undefined
    private readonly configuredPushUrl?: string
    private readonly fetchFn: FetchLike
    private readonly timeoutMs: number
    private readonly now: () => number
    private readonly logger: ApnsPushLogger
    private readonly pendingRetries = new Map<string, { timer: NodeJS.Timeout; dueAt: number }>()
    private disposed = false
    private writeQueue: Promise<void> = Promise.resolve()

    constructor(
        optionsOrGetter: ApnsPushServiceOptions | (() => KVStoreLike | null | undefined),
        extraOptions?: Omit<ApnsPushServiceOptions, 'kvStoreGetter'>,
    ) {
        const options: ApnsPushServiceOptions =
            typeof optionsOrGetter === 'function'
                ? { ...extraOptions, kvStoreGetter: optionsOrGetter }
                : optionsOrGetter

        this.kvStoreGetter = options.kvStoreGetter
        this.configuredPushUrl = options.pushUrl
        this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init))
        this.timeoutMs = options.timeoutMs ?? DEFAULT_APNS_PUSH_TIMEOUT_MS
        this.now = options.now ?? (() => Date.now())
        this.logger = options.logger ?? console
    }

    /**
     * Registers or updates a mobile client keyed by (clientId, connectionId).
     */
    async registerClient(input: NotificationClientRegistration): Promise<void> {
        if (!input || typeof input !== 'object') {
            throw new Error('Invalid registration payload')
        }
        const clientId = normalizeNonEmptyString(input.clientId, 'clientId')
        const connectionId = normalizeNonEmptyString(input.connectionId, 'connectionId')
        const destination = normalizeDestination(input)
        if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
            throw new Error('Invalid enabled flag: expected a boolean')
        }

        const deviceName = normalizeOptionalString(input.deviceName)
        const appVersion = normalizeOptionalString(input.appVersion)
        const enabled = input.enabled ?? true

        await this.withWriteLock(async () => {
            const kv = this.requireKvStore()
            const clients = sanitizeStoredClients(await kv.get(NOTIFICATION_CLIENTS_STORAGE_KEY))
            const timestamp = this.now()
            const existingIndex = clients.findIndex(
                (c) => c.clientId === clientId && c.connectionId === connectionId,
            )

            const nextEntry: RegisteredNotificationClient = {
                clientId,
                connectionId,
                ...destination,
                ...(deviceName ? { deviceName } : {}),
                ...(appVersion ? { appVersion } : {}),
                enabled,
                registeredAt:
                    existingIndex >= 0 && clients[existingIndex].registeredAt > 0
                        ? clients[existingIndex].registeredAt
                        : timestamp,
                updatedAt: timestamp,
            }

            if (existingIndex >= 0) {
                clients[existingIndex] = nextEntry
            } else {
                clients.push(nextEntry)
            }

            await kv.set(NOTIFICATION_CLIENTS_STORAGE_KEY, clients)
            await kv.save()
        })
    }

    /**
     * Removes a registered client matching (clientId, connectionId).
     */
    async unregisterClient(input: NotificationClientUnregistration): Promise<void> {
        if (!input || typeof input !== 'object') {
            throw new Error('Invalid unregistration payload')
        }
        const clientId = normalizeNonEmptyString(input.clientId, 'clientId')
        const connectionId = normalizeNonEmptyString(input.connectionId, 'connectionId')

        await this.withWriteLock(async () => {
            const kv = this.requireKvStore()
            const clients = sanitizeStoredClients(await kv.get(NOTIFICATION_CLIENTS_STORAGE_KEY))
            const filtered = clients.filter(
                (c) => !(c.clientId === clientId && c.connectionId === connectionId),
            )
            if (filtered.length === clients.length) {
                return
            }
            await kv.set(NOTIFICATION_CLIENTS_STORAGE_KEY, filtered)
            await kv.save()
        })
    }

    /**
     * Returns a snapshot of all registered notification clients.
     */
    async listClients(): Promise<RegisteredNotificationClient[]> {
        return await this.withWriteLock(async () => {
            const kv = this.kvStoreGetter()
            if (!kv) {
                return []
            }
            return sanitizeStoredClients(await kv.get(NOTIFICATION_CLIENTS_STORAGE_KEY))
        })
    }

    /**
     * Dispatches push notifications concurrently to all enabled clients when a
     * top-level task completes, and cleans up tokens confirmed unregistered.
     */
    async notifyTaskCompleted(payload: TaskCompletedPushPayload): Promise<void> {
        const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : ''
        const bodyText = formatTaskCompletedNotificationBody(payload.sessionTitle)
        const dataSessionTitle = truncateSessionTitleForData(payload.sessionTitle)
        const collapseId = sessionId
            ? sliceUtf8Bytes(`turn-complete-${sessionId}`, MAX_APNS_COLLAPSE_ID_BYTES)
            : undefined
        await this.dispatchPushToEnabledClients({
            notificationType: 'taskCompleted',
            sessionId,
            bodyText,
            collapseId,
            dataSessionTitle,
        })
    }

    /**
     * Dispatches push notifications concurrently to all enabled clients when the
     * model calls `ask` and waits for user input, and cleans up tokens confirmed unregistered.
     */
    async notifyAskRequested(payload: AskRequestedPushPayload): Promise<void> {
        const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : ''
        const bodyText = formatAskRequestedNotificationBody(payload.sessionTitle, payload.question)
        const dataSessionTitle = truncateSessionTitleForData(payload.sessionTitle)
        const collapseId = sessionId
            ? sliceUtf8Bytes(`ask-${sessionId}`, MAX_APNS_COLLAPSE_ID_BYTES)
            : undefined
        await this.dispatchPushToEnabledClients({
            notificationType: 'ask',
            sessionId,
            bodyText,
            collapseId,
            dataSessionTitle,
        })
    }

    private async dispatchPushToEnabledClients(event: TurnNotification): Promise<void> {
        const clients = await this.listClients()
        const enabledClients = clients.filter((c) => c.enabled)
        if (enabledClients.length === 0) {
            return
        }

        const expiresAt = this.now() + FCM_RETRY_WINDOW_MS
        const results = await Promise.allSettled(enabledClients.map(client => this.sendPush(client, event, expiresAt)))
        const staleClients: StaleClientRecord[] = []
        for (const result of results) {
            if (result.status === 'fulfilled' && result.value) {
                staleClients.push(result.value)
            }
        }

        if (staleClients.length > 0) {
            await this.removeStaleClients(staleClients)
        }
    }

    private async sendPush(
        client: RegisteredNotificationClient,
        event: TurnNotification,
        retryDeadline?: number,
    ): Promise<StaleClientRecord | null> {
        try {
            const response = await this.fetchFn(this.resolvePushUrl(), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(buildGatewayRequest(client, event)),
                signal: AbortSignal.timeout(this.timeoutMs),
            })
            const raw = await response.json().catch(() => null)
            const result = raw && typeof raw === 'object' ? raw as Record<string, unknown> : undefined
            // Legacy APNs gateways may return only the status or only the flag.
            const unregistered = client.provider === 'fcm'
                ? response.status === 410 && result?.unregistered === true
                : response.status === 410 || result?.unregistered === true
            if (unregistered) return client

            if (!response.ok) {
                this.logger.warn?.(`[ApnsPushService] Push gateway returned status ${response.status} for client ${client.clientId}`)
                if (client.provider === 'fcm' && retryDeadline !== undefined &&
                    (response.status === 429 || (response.status === 503 && result?.reason !== 'fcm not configured'))) {
                    this.scheduleFcmRetry(client, event, retryDeadline, response.headers.get('retry-after'))
                }
            }
        } catch (err) {
            this.logger.warn?.(`[ApnsPushService] Failed to send push to client ${client.clientId}:`, err)
        }
        return null
    }

    private scheduleFcmRetry(
        client: RegisteredNotificationClient,
        event: TurnNotification,
        expiresAt: number,
        retryAfter: string | null,
    ): void {
        if (this.disposed) return
        // One pending reminder per installation, connection, token, session and kind.
        const key = JSON.stringify([client.clientId, client.connectionId, client.deviceToken, event.sessionId, event.notificationType])
        const existing = this.pendingRetries.get(key)
        const now = this.now()
        const dueAt = Math.max(existing?.dueAt ?? 0, retryAt(retryAfter, now))
        if (existing) {
            clearTimeout(existing.timer)
            this.pendingRetries.delete(key)
        }
        if (dueAt >= expiresAt || this.pendingRetries.size >= MAX_FCM_RETRIES_PENDING) return
        const timer = setTimeout(() => {
            this.pendingRetries.delete(key)
            void this.retryFcmPush(client, event, expiresAt).catch(err => {
                this.logger.warn?.('[ApnsPushService] Failed to process push retry:', err)
            })
        }, dueAt - now)
        timer.unref()
        this.pendingRetries.set(key, { timer, dueAt })
    }

    private async retryFcmPush(client: RegisteredNotificationClient, event: TurnNotification, expiresAt: number): Promise<void> {
        const current = (await this.listClients()).find(record => record.enabled && sameDestination(record, client))
        if (!current || this.disposed || this.now() >= expiresAt) return
        // Omitting the deadline makes this the final attempt.
        const stale = await this.sendPush(current, event)
        if (stale) await this.removeStaleClients([stale])
    }

    dispose(): void {
        this.disposed = true
        for (const pending of this.pendingRetries.values()) clearTimeout(pending.timer)
        this.pendingRetries.clear()
    }

    private resolvePushUrl(): string {
        if (this.configuredPushUrl && this.configuredPushUrl.trim()) {
            return this.configuredPushUrl.trim()
        }
        const envUrl = process.env.CPA_NOTIFICATION_SERVICE_URL?.trim()
        return envUrl || DEFAULT_APNS_PUSH_URL
    }

    private requireKvStore(): KVStoreLike {
        const kv = this.kvStoreGetter()
        if (!kv) {
            throw new Error('KVStoreService is not available')
        }
        return kv
    }

    private async removeStaleClients(staleRecords: readonly StaleClientRecord[]): Promise<void> {
        await this.withWriteLock(async () => {
            const kv = this.kvStoreGetter()
            if (!kv) {
                return
            }
            const clients = sanitizeStoredClients(await kv.get(NOTIFICATION_CLIENTS_STORAGE_KEY))
            if (clients.length === 0) {
                return
            }

            // Only remove an entry if its stored deviceToken still matches the failed push token,
            // preventing deletion of a newly rotated token while an earlier push was in flight.
            const filtered = clients.filter(current => !staleRecords.some(stale => sameDestination(stale, current)))

            if (filtered.length === clients.length) {
                return
            }

            await kv.set(NOTIFICATION_CLIENTS_STORAGE_KEY, filtered)
            await kv.save()
        })
    }

    private async withWriteLock<T>(task: () => Promise<T>): Promise<T> {
        const previous = this.writeQueue
        let release!: () => void
        this.writeQueue = new Promise<void>((resolve) => {
            release = resolve
        })
        await previous
        try {
            return await task()
        } finally {
            release()
        }
    }
}
