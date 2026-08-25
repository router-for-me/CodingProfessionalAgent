/**
 * Canonical production agent surface.
 * CLIProxyAPIAgentService is the composition root.
 */

import type { AgentRunEvent } from '@/features/agent-runtime/agent/types'
import type { SubAgentHost } from '@/features/agent-runtime/host/SubAgentHost'
import type {
    AgentCompactInput,
    AgentCompactResult,
    AgentPrepareInput,
    AgentStreamChatInput,
    PreparedAgentRun,
} from './types'

export interface AgentService {
    /** Present on the production CLIProxyAPI runtime. */
    readonly subAgents?: SubAgentHost
    /**
     * Validate config, resolve agentDir/project/tools, load one ResourceSnapshot.
     * Must not open sockets or create sessions.
     */
    prepare(input: AgentPrepareInput): Promise<PreparedAgentRun>

    /**
     * Stream a single agent run as scoped AgentRunEvent values.
     * Reuses prepared snapshot/tools/model for the whole run.
     */
    streamChat(input: AgentStreamChatInput): AsyncIterable<AgentRunEvent>

    /** Abort the active run (or a specific runId). */
    abort(runId?: string): void

    /** Approve a pending tool for the exact runId/toolCallId. */
    approve(runId: string, toolCallId: string): boolean

    /** Reject a pending tool for the exact runId/toolCallId. */
    reject(runId: string, toolCallId: string): boolean

    /**
     * Manual /compact — isolated Task14 compaction using the prepared snapshot/model.
     * Does not append a user entry. Rejects when a run is already active.
     */
    compact(input: AgentCompactInput): Promise<AgentCompactResult>

    /**
     * Abort active work and release owned connection resources.
     * May be sync or async; callers must observe rejections (void/await).
     */
    dispose(): void | Promise<void>
}
