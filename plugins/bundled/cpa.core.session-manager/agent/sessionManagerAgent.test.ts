import { describe, expect, it, vi } from 'vitest'
import { createPluginTestHarness } from '@cpa/plugin-sdk'
import type { HostServices, SessionItem, ToolExecutionContext } from '@cpa/plugin-api'
import { sessionManagerAgentEntry } from './index.js'
import {
    createSetSessionTitleTool,
    validateSetSessionTitleArgs,
    SET_SESSION_TITLE_TOOL_NAME,
    SET_SESSION_TITLE_DESCRIPTION,
} from './sessionTitle.js'
import {
    createSessionSearchTool,
    createSessionCreateTool,
    parseTimestamp,
    resolveTimeRange,
    SESSION_SEARCH_TOOL_NAME,
    CREATE_SESSION_TOOL_NAME,
} from './sessionTools.js'
import manifest from '../manifest.json' with { type: 'json' }

describe('cpa.core.session-manager agent entry', () => {
    it('registers tool factories on activation', async () => {
        const harness = createPluginTestHarness(sessionManagerAgentEntry, {
            manifest,
        })

        await harness.activate()

        const tools = harness.getRegistered('tool-factory')
        expect(tools.map((t) => t.id).sort()).toEqual([
            'session_create',
            'session_search',
            'title',
        ])

        const sessionSearchFactory = tools.find((t) => t.id === 'session_search')?.value as any
        const createSessionFactory = tools.find((t) => t.id === 'session_create')?.value as any
        const setTitleFactory = tools.find((t) => t.id === 'title')?.value as any

        expect(sessionSearchFactory.requiresScheduledSession).toBe(true)
        expect(createSessionFactory.requiresScheduledSession).toBe(true)
        expect(setTitleFactory.requiresScheduledSession).toBeUndefined()

        // Non-scheduled session context returns undefined (tools not injected)
        const nonScheduledCtx = {
            sessionId: 'sess_normal',
            services: {
                sessions: {
                    getSnapshot: () => [{ id: 'sess_normal', scheduleId: undefined }],
                },
            },
        }
        expect(await sessionSearchFactory.create(nonScheduledCtx)).toBeUndefined()
        expect(await createSessionFactory.create(nonScheduledCtx)).toBeUndefined()

        // Scheduled session context returns the concrete tool
        const scheduledCtx = {
            scheduleId: 'sched_123',
            sessionId: 'sess_sched',
        }
        const createdSearchTool = await sessionSearchFactory.create(scheduledCtx)
        const createdNewSessionTool = await createSessionFactory.create(scheduledCtx)
        expect(createdSearchTool).toBeDefined()
        expect(createdSearchTool.name).toBe('session_search')
        expect(createdNewSessionTool).toBeDefined()
        expect(createdNewSessionTool.name).toBe('session_create')
    })

    describe('set_session_title tool', () => {
        it('has valid metadata and parameter validation', () => {
            const tool = createSetSessionTitleTool()
            expect(tool.name).toBe(SET_SESSION_TITLE_TOOL_NAME)
            expect(tool.label).toBe(SET_SESSION_TITLE_TOOL_NAME)
            expect(tool.description).toBe(SET_SESSION_TITLE_DESCRIPTION)
            expect(tool.parameters).toBeDefined()

            expect(() => tool.validate(null)).toThrow()
            expect(() => tool.validate({ title: '' })).toThrow()
            expect(() => tool.validate({ title: '   ' })).toThrow()
            expect(() => tool.validate({ title: 123 })).toThrow()
            expect(() => tool.validate({ title: 'Valid Title', extra: 123 })).toThrow()
            expect(tool.validate({ title: '  Valid Title  ' })).toEqual({ title: 'Valid Title' })
        })

        it('executes via onRename callback without window.electronBridge', async () => {
            const onRename = vi.fn()
            const tool = createSetSessionTitleTool(onRename)

            const result = await tool.execute('call_1', { title: 'Renamed Title' }, {
                sessionId: 'sess_123',
            } as ToolExecutionContext)

            expect(onRename).toHaveBeenCalledWith('sess_123', 'Renamed Title')
            expect(result.isError).toBe(false)
            expect(result.details).toEqual({ title: 'Renamed Title' })
        })

        it('executes via services.sessions.update without window.electronBridge', async () => {
            const updateSession = vi.fn().mockResolvedValue(undefined)
            const mockServices = {
                sessions: {
                    update: updateSession,
                },
            } as unknown as HostServices

            const tool = createSetSessionTitleTool({ services: mockServices })

            const result = await tool.execute('call_2', { title: 'Updated Title' }, {
                sessionId: 'sess_456',
                services: mockServices,
            } as ToolExecutionContext)

            expect(updateSession).toHaveBeenCalledWith('sess_456', { title: 'Updated Title' })
            expect(result.isError).toBe(false)
        })

        it('executes via capabilityClient without window.electronBridge', async () => {
            const invoke = vi.fn().mockResolvedValue(true)
            const mockCapClient = {
                has: () => true,
                invoke,
                subscribe: () => () => {},
            }

            const tool = createSetSessionTitleTool({ capabilityClient: mockCapClient as any })

            const result = await tool.execute('call_3', { title: 'Cap Title' }, {
                sessionId: 'sess_789',
            } as ToolExecutionContext)

            expect(invoke).toHaveBeenCalledWith('session:setMeta', [{ id: 'sess_789', title: 'Cap Title' }])
            expect(result.isError).toBe(false)
        })
    })

    describe('time parsing helpers', () => {
        it('parseTimestamp handles epoch ms, string numbers, and ISO strings', () => {
            expect(parseTimestamp(1700000000000)).toBe(1700000000000)
            expect(parseTimestamp('1700000000000')).toBe(1700000000000)
            expect(parseTimestamp('2025-05-01T00:00:00.000Z')).toBe(
                new Date('2025-05-01T00:00:00.000Z').getTime(),
            )
            expect(parseTimestamp(undefined)).toBeUndefined()
            expect(parseTimestamp('invalid-date')).toBeUndefined()
        })

        it('resolveTimeRange computes valid time ranges', () => {
            const today = resolveTimeRange('today')
            expect(today.startMs).toBeDefined()
            expect(today.endMs).toBeDefined()
            expect(today.startMs! <= today.endMs!).toBe(true)

            const past7 = resolveTimeRange('past_7_days')
            expect(past7.startMs).toBeDefined()
            expect(past7.endMs).toBeDefined()
            expect(past7.endMs! - past7.startMs!).toBeCloseTo(7 * 86_400_000, -3)

            expect(resolveTimeRange('all')).toEqual({})
            expect(resolveTimeRange(undefined)).toEqual({})
        })
    })

    describe('session_search tool', () => {
        const mockSessions: SessionItem[] = [
            {
                id: 'sess_alpha',
                title: 'Refactor Authentication Module',
                pinned: false,
                projectId: 'proj_main',
                scheduleId: 'sched_daily',
                createdAt: 1700000000000,
                updatedAt: 1700001000000,
            },
            {
                id: 'sess_beta',
                title: 'Fix Database Lock In SQLite',
                pinned: true,
                projectId: 'proj_main',
                createdAt: 1700002000000,
                updatedAt: 1700003000000,
            },
        ]

        it('rejects execution in non-scheduled sessions', async () => {
            const tool = createSessionSearchTool()
            const result = await tool.execute({ query: 'test' }, {})
            expect(result).toContain('only available in sessions created by scheduled tasks')
        })

        it('returns message when no sessions match in a scheduled session', async () => {
            const mockServices = {
                projects: { getSnapshot: () => [] },
                sessions: { getSnapshot: () => [] },
            } as unknown as HostServices
            const tool = createSessionSearchTool({ services: mockServices })
            const result = await tool.execute({ query: 'non-existent' }, { scheduleId: 'sched_daily' })
            expect(result).toBe('No sessions matched the specified search criteria.')
        })

        it('searches and filters sessions using HostServices in pure Node environment', async () => {
            const mockServices = {
                projects: {
                    getSnapshot: () => [{ id: 'proj_main', name: 'Main App', pinned: false, createdAt: 0, updatedAt: 0 }],
                    list: async () => [{ id: 'proj_main', name: 'Main App', pinned: false, createdAt: 0, updatedAt: 0 }],
                },
                sessions: {
                    getSnapshot: () => mockSessions,
                    list: async () => mockSessions,
                },
            } as unknown as HostServices

            const tool = createSessionSearchTool({ services: mockServices })

            const context = {
                scheduleId: 'sched_daily',
                services: mockServices,
            }

            const result = await tool.execute({ query: 'Database' }, context)
            expect(typeof result).toBe('string')
            expect(result).toContain('Fix Database Lock In SQLite')
            expect(result).toContain('sess_beta')
            expect(result).not.toContain('Refactor Authentication Module')
        })

        it('retrieves single session details by ID via HostServices', async () => {
            const mockServices = {
                projects: {
                    getSnapshot: () => [{ id: 'proj_main', name: 'Main App', pinned: false, createdAt: 0, updatedAt: 0 }],
                },
                sessions: {
                    getSnapshot: () => mockSessions,
                    get: async (id: string) => mockSessions.find((s) => s.id === id),
                },
            } as unknown as HostServices

            const tool = createSessionSearchTool({ services: mockServices })

            const context = {
                scheduleId: 'sched_daily',
                services: mockServices,
            }

            const result = await tool.execute({ sessionId: 'sess_alpha' }, context)
            expect(typeof result).toBe('string')
            expect(result).toContain('Refactor Authentication Module')
            expect(result).toContain('sess_alpha')
            expect(result).toContain('Main App')
        })
    })

    describe('session_create tool', () => {
        it('rejects execution when no scheduleId in context', async () => {
            const tool = createSessionCreateTool()
            const result = await tool.execute({ title: 'Test' }, {})
            expect(result).toContain('only available in sessions created by scheduled tasks')
        })

        it('rejects empty title', async () => {
            const tool = createSessionCreateTool()
            const result = await tool.execute({ title: '' }, { scheduleId: 'sched_daily' })
            expect(result).toContain('session title cannot be empty')
        })

        it('creates a session using HostServices or CapabilityClient in pure Node environment', async () => {
            const updateFn = vi.fn().mockResolvedValue(undefined)
            const mockServices = {
                sessions: {
                    update: updateFn,
                    getSnapshot: () => [],
                },
            } as unknown as HostServices

            const tool = createSessionCreateTool({ services: mockServices })

            const context = {
                scheduleId: 'sched_daily',
                sessionId: 'parent_sess',
                services: mockServices,
            }

            const result = (await tool.execute(
                {
                    title: 'New Subtask Session',
                    projectId: 'proj_1',
                    workLocation: 'worktree',
                },
                context,
            )) as any

            expect(result).toBeDefined()
            expect(result.ok).toBe(true)
            expect(result.title).toBe('New Subtask Session')
            expect(result.scheduleId).toBe('sched_daily')
            expect(result.parentSessionId).toBe('parent_sess')
            expect(updateFn).toHaveBeenCalled()
        })
    })
})
