import { describe, expect, it, vi } from 'vitest'
import type { ActionExecutionContext, HostServices } from '@cpa/plugin-api'
import {
    executeCycleReasoningEffort,
    executeNextModel,
    executePreviousModel,
} from './actions.js'

function createMockServices(overrides: Partial<HostServices> = {}): HostServices {
    const mockSessions: any[] = [
        {
            id: 'session-1',
            title: 'Test Session',
            modelId: 'gpt-5-codex',
            reasoningEffort: 'medium',
            speed: 'standard',
        },
    ]
    let activeRun: any = undefined

    const mockSettings: any = {
        modelId: 'gpt-5-codex',
        reasoningLevel: 'medium',
        speed: 'standard',
        modelSettings: {},
    }

    const mockModels: any[] = [
        {
            id: 'gpt-5-codex',
            label: 'GPT-5 CPA',
            contextWindow: 200000,
            supportedReasoningEfforts: ['low', 'medium', 'high', 'off'],
        },
        {
            id: 'claude-3-7-sonnet',
            label: 'Claude 3.7 Sonnet',
            contextWindow: 200000,
            supportedReasoningEfforts: ['low', 'high', 'off'],
        },
        {
            id: 'gemini-2-5-pro',
            label: 'Gemini 2.5 Pro',
            contextWindow: 1000000,
            supportedReasoningEfforts: ['off'],
        },
    ]

    return {
        sessions: {
            list: vi.fn(async () => mockSessions),
            get: vi.fn(async (id: string) => mockSessions.find((s) => s.id === id)),
            update: vi.fn(async () => {}),
            broadcastRunStatus: vi.fn(async () => {}),
            getSnapshot: () => mockSessions,
            getCurrentSessionId: () => 'session-1',
            getActiveRun: () => activeRun,
            setSessionRuntimeSettings: vi.fn((sessionId, patch) => {
                const s = mockSessions.find((x) => x.id === sessionId)
                if (s) Object.assign(s, patch)
            }),
            __setActiveRun: (run: any) => {
                activeRun = run
            },
        } as any,
        projects: {
            list: vi.fn(async () => []),
            save: vi.fn(async () => {}),
            remove: vi.fn(async () => {}),
            selectDirectory: vi.fn(async () => '/selected/folder'),
        },
        settings: {
            getSnapshot: () => mockSettings,
            subscribe: vi.fn(() => () => {}),
            update: vi.fn(async () => {}),
            setModelId: vi.fn((id: string) => {
                mockSettings.modelId = id
            }),
            setReasoningLevel: vi.fn((lvl: string) => {
                mockSettings.reasoningLevel = lvl
            }),
        },
        models: {
            getModels: () => mockModels,
            getStatus: () => 'ready',
            getError: () => null,
            subscribe: vi.fn(() => () => {}),
            refresh: vi.fn(async () => {}),
        },
        worktrees: {
            list: vi.fn(async () => []),
            getSnapshot: () => [],
            setup: vi.fn(async () => ({ success: true, worktreePath: '' })),
        },
        hooks: { executeHook: vi.fn(async () => {}) },
        navigation: { navigate: vi.fn() },
        notifications: { notify: vi.fn() },
        schedule: { getSchedules: () => [], subscribe: vi.fn(() => () => {}) },
        skillUsage: {
            recordUsage: vi.fn(),
            fetchUsageCounts: vi.fn(async () => ({})),
            getSnapshot: () => ({}),
            subscribe: vi.fn(() => () => {}),
        },
        persistence: { get: vi.fn(async () => null), set: vi.fn(async () => {}), delete: vi.fn(async () => {}) },
        ui: {
            getPendingSessionContext: () => ({ projectId: null, branch: null }),
            setPendingSessionContext: vi.fn(),
            isGroupCollapsed: () => false,
            toggleGroup: vi.fn(),
            setSidebarCollapsed: vi.fn(),
            openSettings: vi.fn(),
            pushToast: vi.fn(),
            emitEvent: vi.fn(),
        },
        ...overrides,
    }
}

describe('Composer Actions utils', () => {
    it('executeCycleReasoningEffort cycles reasoning effort for current model and updates settings and session', () => {
        const services = createMockServices()
        const context: ActionExecutionContext = {
            actionId: 'cycle-reasoning-effort',
            services,
        }

        // Current is medium in ['low', 'medium', 'high', 'off'] -> next is high
        const next1 = executeCycleReasoningEffort(context)
        expect(next1).toBe('high')
        expect(services.settings.setReasoningLevel).toHaveBeenCalledWith('high')
        expect(services.sessions.setSessionRuntimeSettings).toHaveBeenCalledWith(
            'session-1',
            expect.objectContaining({ reasoningEffort: 'high' }),
        )

        // high -> off
        const next2 = executeCycleReasoningEffort(context)
        expect(next2).toBe('off')

        // off -> low
        const next3 = executeCycleReasoningEffort(context)
        expect(next3).toBe('low')
    })

    it('executeNextModel cycles to next model in catalog', () => {
        const services = createMockServices()
        const context: ActionExecutionContext = {
            actionId: 'next-model',
            services,
        }

        // Current: gpt-5-codex (index 0) -> next: claude-3-7-sonnet (index 1)
        const next = executeNextModel(context)
        expect(next).toBe('claude-3-7-sonnet')
        expect(services.settings.setModelId).toHaveBeenCalledWith('claude-3-7-sonnet')
        expect(services.sessions.setSessionRuntimeSettings).toHaveBeenCalledWith(
            'session-1',
            expect.objectContaining({ modelId: 'claude-3-7-sonnet' }),
        )
    })

    it('executeNextModel does nothing if active run is running', () => {
        const services = createMockServices()
        ;(services.sessions as any).__setActiveRun({ status: 'running' })

        const context: ActionExecutionContext = {
            actionId: 'next-model',
            services,
        }

        const res = executeNextModel(context)
        expect(res).toBeNull()
        expect(services.settings.setModelId).not.toHaveBeenCalled()
    })

    it('executePreviousModel cycles to previous model in catalog', () => {
        const services = createMockServices()
        // Start at claude-3-7-sonnet (index 1)
        services.sessions.getSnapshot!()[0].modelId = 'claude-3-7-sonnet'
        const context: ActionExecutionContext = {
            actionId: 'previous-model',
            services,
        }

        const prev = executePreviousModel(context)
        expect(prev).toBe('gpt-5-codex')
        expect(services.settings.setModelId).toHaveBeenCalledWith('gpt-5-codex')
    })

    it('executePreviousModel does nothing if active run is running', () => {
        const services = createMockServices()
        ;(services.sessions as any).__setActiveRun({ status: 'running' })

        const context: ActionExecutionContext = {
            actionId: 'previous-model',
            services,
        }

        const res = executePreviousModel(context)
        expect(res).toBeNull()
        expect(services.settings.setModelId).not.toHaveBeenCalled()
    })
})
