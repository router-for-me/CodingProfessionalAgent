import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectStore } from '@/stores/projectStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { HookProvider } from '../providers/HookProvider'
import { executeSessionCompletionHook } from './executeSessionHook'

describe('executeSessionCompletionHook', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        useSessionStore.setState({
            sessions: [
                {
                    id: 'test-session',
                    title: 'Test',
                    projectId: 'proj-1',
                    pinned: false,
                    createdAt: 100,
                    updatedAt: 100,
                },
            ],
            currentSessionId: 'test-session',
        })
        useProjectStore.setState({
            projects: [
                {
                    id: 'proj-1',
                    name: 'Project 1',
                    path: '/path/to/project',
                    pinned: false,
                    createdAt: 100,
                    updatedAt: 100,
                },
            ],
        })
        useSettingsStore.setState({
            settings: {
                ...useSettingsStore.getState().settings,
                modelId: 'gpt-4o',
            },
        })
    })

    it('executes Stop and SessionEnd hooks with project cwd and model via HookProvider', async () => {
        const executeSpy = vi.spyOn(HookProvider, 'execute').mockResolvedValue({
            continue: true,
            additionalContexts: [],
            errors: [],
        })

        await executeSessionCompletionHook('test-session')

        expect(executeSpy).toHaveBeenCalledWith(
            'Stop',
            expect.objectContaining({
                event: 'Stop',
                sessionId: 'test-session',
                payload: expect.objectContaining({
                    hook_event_name: 'Stop',
                    session_id: 'test-session',
                    cwd: '/path/to/project',
                    model: 'gpt-4o',
                    permission_mode: 'default',
                    stop_reason: 'completed',
                }),
            }),
            expect.anything(),
        )

        expect(executeSpy).toHaveBeenCalledWith(
            'SessionEnd',
            expect.objectContaining({
                event: 'SessionEnd',
                sessionId: 'test-session',
                payload: expect.objectContaining({
                    hook_event_name: 'SessionEnd',
                    session_id: 'test-session',
                    cwd: '/path/to/project',
                    reason: 'completed',
                }),
            }),
            expect.anything(),
        )
    })

    it('uses custom reason when provided', async () => {
        const executeSpy = vi.spyOn(HookProvider, 'execute').mockResolvedValue({
            continue: true,
            additionalContexts: [],
            errors: [],
        })

        await executeSessionCompletionHook('test-session', { reason: 'user_abort' })

        expect(executeSpy).toHaveBeenCalledWith(
            'Stop',
            expect.objectContaining({
                payload: expect.objectContaining({
                    stop_reason: 'user_abort',
                }),
            }),
            expect.anything(),
        )

        expect(executeSpy).toHaveBeenCalledWith(
            'SessionEnd',
            expect.objectContaining({
                payload: expect.objectContaining({
                    reason: 'user_abort',
                }),
            }),
            expect.anything(),
        )
    })
})
