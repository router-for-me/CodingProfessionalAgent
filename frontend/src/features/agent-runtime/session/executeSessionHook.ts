import { HookProvider } from '../providers/HookProvider'
import { agentRegistry } from '@/plugins/platform/AgentPluginRuntimeHost'
import { useSessionStore } from '@/stores/sessionStore'
import { useProjectStore } from '@/stores/projectStore'
import { useSettingsStore } from '@/stores/settingsStore'

export interface ExecuteSessionHookOptions {
    sessionId: string
    reason?: string
}

/**
 * Dispatches the session completion / stop hooks (Stop and SessionEnd) for a given session
 * via the unified HookProvider SPI.
 */
export async function executeSessionCompletionHook(
    sessionId: string,
    opts?: { reason?: string },
): Promise<void> {
    const session = useSessionStore
        .getState()
        .sessions.find((s) => s.id === sessionId)
    const project = session?.projectId
        ? useProjectStore.getState().projects.find((p) => p.id === session.projectId)
        : undefined
    const cwd = project?.path ?? ''
    const model = useSettingsStore.getState().settings.modelId || 'default'

    const reason = opts?.reason ?? 'completed'

    try {
        await HookProvider.execute(
            'Stop',
            {
                event: 'Stop',
                sessionId,
                payload: {
                    hook_event_name: 'Stop',
                    session_id: sessionId,
                    cwd,
                    model,
                    permission_mode: 'default',
                    stop_reason: reason,
                },
            },
            { extensionRegistry: agentRegistry },
        )
    } catch (err) {
        console.warn('Failed to execute Stop hook:', err)
    }

    try {
        await HookProvider.execute(
            'SessionEnd',
            {
                event: 'SessionEnd',
                sessionId,
                payload: {
                    hook_event_name: 'SessionEnd',
                    session_id: sessionId,
                    cwd,
                    reason,
                },
            },
            { extensionRegistry: agentRegistry },
        )
    } catch (err) {
        console.warn('Failed to execute SessionEnd hook:', err)
    }
}
