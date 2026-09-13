import { PluginCapabilityError } from './errors.js'

export type CapabilityId = string & {}

/** Standard capability for AI Gateway network discovery via mDNS/DNS-SD */
export const GATEWAY_DISCOVER_CAPABILITY = 'gateway.discover'

export type CapabilityHandle = string & { readonly __capabilityHandle: unique symbol }

export interface CapabilityInvocationContext {
    pluginId: string
    senderId: number
    frameUrl: string
    transport: 'electron' | 'web'
    runtime?: 'main' | 'renderer' | 'agent'
    processId?: number
    routingId?: number
    documentId?: string
    /** Stable web client identity used to bind grants across browser sessions. */
    clientId?: string
}

export interface CapabilityDescriptor<TArgs extends unknown[] = unknown[], TResult = unknown> {
    method: string
    capability: CapabilityId
    validate(args: unknown[]): asserts args is TArgs
    invoke(context: CapabilityInvocationContext, ...args: TArgs): Promise<TResult>
}

export interface CapabilityGrant {
    pluginId: string
    capabilities: ReadonlySet<CapabilityId>
}

export interface PluginCapabilityClient {
    has(capability: CapabilityId): boolean
    invoke<TResult = unknown>(method: string, args?: unknown[]): Promise<TResult>
    subscribe<T = unknown>(eventName: string, listener: (payload: T) => void): () => void
}

/**
 * Validates whether a capability pattern is allowed in grants.
 * Allowed:
 * - Exact capability IDs, e.g. "sessions.read", "filesystem.writeFile" (no wildcards)
 * - Trailing namespace wildcards, e.g. "sessions.*", "filesystem.*"
 * Prohibited:
 * - Bare wildcards, e.g. "*"
 * - Infix or prefix wildcards, e.g. "*.read", "sessions.*.read", "sessions**"
 */
export function isValidCapabilityPattern(pattern: string): boolean {
    if (typeof pattern !== 'string' || !pattern.trim()) {
        return false
    }
    const starCount = (pattern.match(/\*/g) || []).length
    if (starCount === 0) {
        return true
    }
    if (starCount === 1) {
        return pattern.endsWith('.*') && pattern.length > 2
    }
    return false
}

/**
 * Asserts that a capability pattern is valid, throwing PluginCapabilityError if invalid.
 */
export function assertValidCapabilityPattern(pattern: string): void {
    if (!isValidCapabilityPattern(pattern)) {
        if (pattern === '*') {
            throw new PluginCapabilityError(
                'Wildcard "*" is prohibited in capability grants; use explicit capability IDs or namespace wildcards like "namespace.*"',
            )
        }
        throw new PluginCapabilityError(
            `Invalid capability pattern "${pattern}": bare wildcards, intermediate wildcards, and prefix wildcards are prohibited`,
        )
    }
}

/**
 * Checks whether a granted pattern matches a required capability ID.
 */
export function matchesCapability(grantedPattern: string, requiredCapability: string): boolean {
    if (!grantedPattern || !requiredCapability) {
        return false
    }
    if (grantedPattern === requiredCapability) {
        return true
    }
    if (grantedPattern.endsWith('.*') && grantedPattern.length > 2) {
        const prefix = grantedPattern.slice(0, -1) // e.g. "sessions."
        return requiredCapability.startsWith(prefix) && requiredCapability.length > prefix.length
    }
    return false
}
