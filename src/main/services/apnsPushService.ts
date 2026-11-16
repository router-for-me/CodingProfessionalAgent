import type {
    NotificationClientRegistration,
    NotificationClientUnregistration,
    NotificationEnvironment,
    RegisteredNotificationClient,
} from '../../shared/types.js'

export type {
    NotificationClientRegistration,
    NotificationClientUnregistration,
    NotificationEnvironment,
    RegisteredNotificationClient,
} from '../../shared/types.js'

export const DEFAULT_APNS_PUSH_URL = 'https://cdpa-notification.router-for.me/v1/push'
export const NOTIFICATION_CLIENTS_STORAGE_KEY = 'notification-clients'
export const DEFAULT_APNS_PUSH_TIMEOUT_MS = 10_000

const DEVICE_TOKEN_HEX_RE = /^[0-9a-f]{64,200}$/
const MAX_TITLE_PREVIEW_LENGTH = 40
const MAX_DATA_SESSION_TITLE_LENGTH = 256

export interface TaskCompletedPushPayload {
    sessionId: string
    sessionTitle?: string
}

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

function isStoredClientRecord(item: unknown): item is RegisteredNotificationClient {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return false
    }
    const record = item as Record<string, unknown>
    if (
        typeof record.clientId !== 'string' ||
        !record.clientId.trim() ||
        typeof record.connectionId !== 'string' ||
        !record.connectionId.trim() ||
        typeof record.deviceToken !== 'string' ||
        !DEVICE_TOKEN_HEX_RE.test(record.deviceToken.trim().toLowerCase()) ||
        (record.environment !== 'production' && record.environment !== 'sandbox')
    ) {
        return false
    }
    return true
}

function sanitizeStoredClients(raw: unknown): RegisteredNotificationClient[] {
    if (!Array.isArray(raw)) {
        return []
    }
    const result: RegisteredNotificationClient[] = []
    for (const item of raw) {
        if (!isStoredClientRecord(item)) {
            continue
        }
        const deviceName = normalizeOptionalString(item.deviceName)
        const appVersion = normalizeOptionalString(item.appVersion)
        result.push({
            clientId: item.clientId.trim(),
            connectionId: item.connectionId.trim(),
            deviceToken: item.deviceToken.trim().toLowerCase(),
            environment: item.environment,
            platform: 'ios',
            ...(deviceName ? { deviceName } : {}),
            ...(appVersion ? { appVersion } : {}),
            enabled: typeof item.enabled === 'boolean' ? item.enabled : true,
            registeredAt: typeof item.registeredAt === 'number' && Number.isFinite(item.registeredAt)
                ? item.registeredAt
                : 0,
            updatedAt: typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt)
                ? item.updatedAt
                : 0,
        })
    }
    return result
}

/**
 * Manages APNs client registrations in settings.json and dispatches push
 * notifications asynchronously when top-level tasks complete.
 */
export class ApnsPushService {
    private readonly kvStoreGetter: () => KVStoreLike | null | undefined
    private readonly configuredPushUrl?: string
    private readonly fetchFn: FetchLike
    private readonly timeoutMs: number
    private readonly now: () => number
    private readonly logger: ApnsPushLogger
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
     * Registers or updates an iOS client keyed by (clientId, connectionId).
     */
    async registerClient(input: NotificationClientRegistration): Promise<void> {
        if (!input || typeof input !== 'object') {
            throw new Error('Invalid registration payload')
        }
        const clientId = normalizeNonEmptyString(input.clientId, 'clientId')
        const connectionId = normalizeNonEmptyString(input.connectionId, 'connectionId')
        const deviceToken = normalizeDeviceToken(input.deviceToken)
        const environment = normalizeEnvironment(input.environment)

        if (input.platform !== undefined && input.platform !== 'ios') {
            throw new Error('Invalid platform: only "ios" is supported')
        }
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
                deviceToken,
                environment,
                platform: 'ios',
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
        const clients = await this.listClients()
        const enabledClients = clients.filter((c) => c.enabled)
        if (enabledClients.length === 0) {
            return
        }

        const pushUrl = this.resolvePushUrl()
        const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : ''
        const rawTitle = (typeof payload.sessionTitle === 'string' ? payload.sessionTitle : '').trim()
        const title = rawTitle
            ? (rawTitle.length > MAX_TITLE_PREVIEW_LENGTH ? `${rawTitle.slice(0, MAX_TITLE_PREVIEW_LENGTH)}...` : rawTitle)
            : ''
        const bodyText = title ? `${title} 任务已经完成` : '任务已经完成'
        const dataSessionTitle = rawTitle
            ? (rawTitle.length > MAX_DATA_SESSION_TITLE_LENGTH
                ? `${rawTitle.slice(0, MAX_DATA_SESSION_TITLE_LENGTH)}...`
                : rawTitle)
            : undefined

        const results = await Promise.allSettled(
            enabledClients.map(async (client): Promise<StaleClientRecord | null> => {
                const requestBody = {
                    deviceToken: client.deviceToken,
                    environment: client.environment,
                    title: 'Coding Professional Agent',
                    body: bodyText,
                    sound: 'default',
                    threadId: sessionId,
                    collapseId: sessionId ? `turn-complete-${sessionId}` : undefined,
                    data: {
                        connectionId: client.connectionId,
                        sessionId,
                        ...(dataSessionTitle ? { sessionTitle: dataSessionTitle } : {}),
                    },
                }

                try {
                    const response = await this.fetchFn(pushUrl, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify(requestBody),
                        signal: AbortSignal.timeout(this.timeoutMs),
                    })

                    let parsedBody: Record<string, unknown> | null = null
                    try {
                        const jsonValue = await response.json()
                        if (jsonValue && typeof jsonValue === 'object' && !Array.isArray(jsonValue)) {
                            parsedBody = jsonValue as Record<string, unknown>
                        }
                    } catch {
                        // Ignore non-JSON or empty response bodies
                    }

                    if (response.status === 410 || parsedBody?.unregistered === true) {
                        return {
                            clientId: client.clientId,
                            connectionId: client.connectionId,
                            deviceToken: client.deviceToken,
                        }
                    }

                    if (!response.ok) {
                        this.logger.warn?.(
                            `[ApnsPushService] Push gateway returned status ${response.status} for client ${client.clientId}`,
                        )
                    }
                } catch (err) {
                    this.logger.warn?.(
                        `[ApnsPushService] Failed to send APNs push to client ${client.clientId}:`,
                        err,
                    )
                }

                return null
            }),
        )

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
            const filtered = clients.filter((current) => {
                const matchedStale = staleRecords.some(
                    (stale) =>
                        stale.clientId === current.clientId &&
                        stale.connectionId === current.connectionId &&
                        stale.deviceToken === current.deviceToken,
                )
                return !matchedStale
            })

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
