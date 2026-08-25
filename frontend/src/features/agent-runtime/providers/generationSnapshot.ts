/**
 * AgentGenerationSnapshot: deterministic, frozen provider generation snapshot
 * held by an active Agent run throughout its entire execution lifecycle.
 */

import type {
    AgentTool,
    HookContribution,
    ModelCatalogProviderContribution,
    ProtocolMiddleware,
    ProtocolSession,
} from '@cpa/plugin-api'
import type { PluginGenerationLease } from '@cpa/plugin-kernel'
import type { ResourceSnapshot } from './ResourceProvider'

export type { PluginGenerationLease }

/**
 * Immutable snapshot of all runtime providers, tools, resources, hooks,
 * middlewares, and protocol sessions pinned to a specific plugin generation.
 */
export interface AgentGenerationSnapshot {
    readonly generation: number
    readonly lease: PluginGenerationLease
    readonly tools: readonly AgentTool[]
    readonly resources: ResourceSnapshot
    readonly hooks: readonly HookContribution[]
    readonly protocolSession: ProtocolSession
    readonly middleware: readonly ProtocolMiddleware[]
    readonly modelProvider: ModelCatalogProviderContribution
    readonly providerIds: readonly string[]
}

/**
 * Type guard for AgentGenerationSnapshot.
 */
export function isAgentGenerationSnapshot(value: unknown): value is AgentGenerationSnapshot {
    if (!value || typeof value !== 'object') return false
    const s = value as Record<string, unknown>
    return (
        typeof s.generation === 'number' &&
        s.lease !== null &&
        typeof s.lease === 'object' &&
        Array.isArray(s.tools) &&
        s.resources !== null &&
        typeof s.resources === 'object' &&
        Array.isArray(s.hooks) &&
        s.protocolSession !== null &&
        typeof s.protocolSession === 'object' &&
        Array.isArray(s.middleware) &&
        s.modelProvider !== null &&
        typeof s.modelProvider === 'object' &&
        Array.isArray(s.providerIds)
    )
}

/**
 * Collect all provider IDs associated with a generation snapshot, prepared run, or active stream run.
 */
export function collectProviderIds(target: unknown): readonly string[] {
    if (!target || typeof target !== 'object') {
        return Object.freeze([])
    }

    if (isAgentGenerationSnapshot(target)) {
        return target.providerIds
    }

    const anyTarget = target as Record<string, unknown>

    if (isAgentGenerationSnapshot(anyTarget.generationSnapshot)) {
        return anyTarget.generationSnapshot.providerIds
    }

    if (anyTarget.prepared && typeof anyTarget.prepared === 'object') {
        const prep = anyTarget.prepared as { generationSnapshot?: AgentGenerationSnapshot }
        if (prep.generationSnapshot) {
            return prep.generationSnapshot.providerIds
        }
    }

    if (Array.isArray(anyTarget.providerIds)) {
        return Object.freeze([...(anyTarget.providerIds as string[])])
    }

    return Object.freeze([])
}

/**
 * Safely dispose a generation snapshot by releasing its generation lease
 * and disposing its protocol session.
 */
export async function disposeGenerationSnapshot(
    snapshot?: AgentGenerationSnapshot | null
): Promise<void> {
    if (!snapshot) return

    try {
        if (typeof snapshot.lease?.release === 'function') {
            snapshot.lease.release()
        }
    } catch (err) {
        console.error('[AgentGenerationSnapshot] Error releasing generation lease:', err)
    }

    try {
        if (typeof snapshot.protocolSession?.dispose === 'function') {
            await snapshot.protocolSession.dispose()
        }
    } catch (err) {
        console.error('[AgentGenerationSnapshot] Error disposing protocol session:', err)
    }
}
