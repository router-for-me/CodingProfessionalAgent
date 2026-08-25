/**
 * Deterministic hash computation for hook configurations.
 * Used for trust tracking and change detection.
 */

import type { HookHandlerConfig } from './types.js'

/**
 * Normalizes an object into a canonical key-sorted JSON string.
 */
export function canonicalizeJson(value: unknown): string {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value)
    }

    if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalizeJson(item)).join(',')}]`
    }

    const record = value as Record<string, unknown>
    const sortedKeys = Object.keys(record).sort()
    const entries = sortedKeys
        .filter((k) => record[k] !== undefined)
        .map((k) => `${JSON.stringify(k)}:${canonicalizeJson(record[k])}`)

    return `{${entries.join(',')}}`
}

/**
 * Computes a hash string from a hook handler configuration and its matcher/event.
 */
export async function computeHookHash(
    eventName: string,
    matcher: string | null | undefined,
    handler: HookHandlerConfig,
): Promise<string> {
    const canonical = canonicalizeJson({
        eventName,
        matcher: matcher ?? null,
        handler,
    })

    if (typeof globalThis.crypto?.subtle?.digest === 'function') {
        try {
            const encoder = new TextEncoder()
            const data = encoder.encode(canonical)
            const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', data)
            const hashArray = Array.from(new Uint8Array(hashBuffer))
            return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
        } catch {
            // Fallback
        }
    }

    // Fallback hash implementation
    let hash = 5381
    for (let i = 0; i < canonical.length; i++) {
        hash = (hash * 33) ^ canonical.charCodeAt(i)
    }
    return (hash >>> 0).toString(16).padStart(8, '0')
}
