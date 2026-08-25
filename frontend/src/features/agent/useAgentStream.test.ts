import { act, renderHook, waitFor } from '@testing-library/react'
import {
    createElement,
    type ReactNode,
} from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelCatalogEntry } from '@/features/models/types'
import type { AgentRunEvent } from '@/features/agent-runtime/agent/types'
import type { AgentService } from './AgentService'
import type {
    AgentCompactInput,
    AgentCompactResult,
    AgentPrepareInput,
    AgentStreamChatInput,
    PreparedAgentRun,
} from './types'
import { AgentPreflightError } from './types'
import {
    AgentServiceProvider,
    __getAgentStreamSnapshotForTests,
    __resetAgentStreamForTests,
    disposeAgentRuntime,
    useAgentStream,
} from './useAgentStream'
import { SubAgentHost } from '@/features/agent-runtime/host/SubAgentHost'
import { getHostServices } from '@/application/services/createHostServices'
import type { SubAgentRecord } from '@cpa/plugin-api'
import { useMessageStore } from '@/stores/messageStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useModelCatalogStore } from '@/stores/modelCatalogStore'
import { useProjectStore } from '@/stores/projectStore'
import { useSubAgentStore } from '@/stores/subAgentStore'
import { useUiStore } from '@/stores/uiStore'
import { getHostAgentController } from '@/application/services/createHostServices'
import { useWorktreeSetupStore } from '@/stores/worktreeSetupStore'

const persistTestState = vi.hoisted(() => ({
    flushPendingPersistence: vi.fn<() => Promise<void>>(),
}))

vi.mock('@/application/services/persistenceService', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/application/services/persistenceService')>()),
    flushPendingPersistence: persistTestState.flushPendingPersistence,
}))

const model: ModelCatalogEntry = {
    id: 'test-model',
    label: 'Test',
    supportsFast: true,
    reasoningLevels: [{ id: 'medium', requestValue: 'medium' }],
    input: ['text', 'image'],
    contextWindow: 128_000,
    maxTokens: 4_096,
}

const modelTextOnly: ModelCatalogEntry = {
    ...model,
    id: 'text-only',
    input: ['text'],
}

function makePrepared(partial?: Partial<PreparedAgentRun>): PreparedAgentRun {
    return {
        baseUrl: 'http://127.0.0.1:8317',
        apiKey: 'key',
        model,
        reasoningEffort: 'medium',
        speed: 'standard',
        requestApproval: false,
        fastContextCompaction: true,
        agentDir: '/cfg/coding-professional-agent/agent',
        projectPaths: [],
        tools: [],
        snapshot: {
            contextFiles: [],
            skills: [],
            prompts: [],
            systemPrompt: 'SYS',
            diagnostics: [],
        },
        diagnostics: [],
        systemPrompt: 'SYS',
        supportsImages: true,
        skills: [],
        prompts: [],
        ...partial,
    }
}

class FakeService implements AgentService {
    prepareImpl: (input: AgentPrepareInput) => Promise<PreparedAgentRun> =
        async () => makePrepared()
    streamEvents: AgentRunEvent[] = []
    streamDelayMs = 0
    streamHold: Promise<void> | null = null
    streamImpl?: (input: AgentStreamChatInput) => AsyncGenerator<AgentRunEvent>
    compactImpl: (input: AgentCompactInput) => Promise<AgentCompactResult> =
        async (input) => {
            const entry = {
                id: 'c1',
                sessionId: input.sessionId,
                createdAt: 1,
                kind: 'compaction' as const,
                summary: 'sum',
                firstKeptEntryId: 'u1',
            }
            return {
                ok: true,
                entry,
                events: [
                    {
                        type: 'agent-start',
                        runId: input.runId,
                        sessionId: input.sessionId,
                    },
                    {
                        type: 'compaction-start',
                        runId: input.runId,
                        sessionId: input.sessionId,
                    },
                    {
                        type: 'compaction-end',
                        runId: input.runId,
                        sessionId: input.sessionId,
                        entry,
                    },
                    {
                        type: 'agent-end',
                        runId: input.runId,
                        sessionId: input.sessionId,
                        entries: [...input.entries, entry],
                    },
                ],
            }
        }
    abortCalls: (string | undefined)[] = []
    approveCalls: [string, string][] = []
    rejectCalls: [string, string][] = []
    prepareCalls = 0
    prepareInputs: AgentPrepareInput[] = []
    streamCalls: unknown[] = []
    compactCalls: AgentCompactInput[] = []
    disposed = false
    subAgents?: SubAgentHost

    async prepare(input: AgentPrepareInput): Promise<PreparedAgentRun> {
        this.prepareCalls += 1
        this.prepareInputs.push(input)
        return this.prepareImpl(input)
    }

    async *streamChat(
        input: AgentStreamChatInput,
    ): AsyncGenerator<AgentRunEvent> {
        this.streamCalls.push(input)
        if (this.streamImpl) {
            yield* this.streamImpl(input)
            return
        }
        yield {
            type: 'agent-start',
            runId: input.runId,
            sessionId: input.sessionId,
        }
        if (this.streamHold) await this.streamHold
        if (this.streamDelayMs > 0) {
            await new Promise((r) => setTimeout(r, this.streamDelayMs))
        }
        for (const event of this.streamEvents) {
            const next = {
                ...event,
                runId: input.runId,
                sessionId: input.sessionId,
            } as AgentRunEvent
            if ('entry' in next && next.entry && typeof next.entry === 'object') {
                ;(next as { entry: { sessionId: string } }).entry = {
                    ...(next as { entry: { sessionId: string } }).entry,
                    sessionId: input.sessionId,
                }
            }
            yield next
        }
        yield {
            type: 'agent-end',
            runId: input.runId,
            sessionId: input.sessionId,
        }
    }

    abort(runId?: string): void {
        this.abortCalls.push(runId)
    }

    approve(runId: string, toolCallId: string): boolean {
        this.approveCalls.push([runId, toolCallId])
        return true
    }

    reject(runId: string, toolCallId: string): boolean {
        this.rejectCalls.push([runId, toolCallId])
        return true
    }

    async compact(input: AgentCompactInput): Promise<AgentCompactResult> {
        this.compactCalls.push(input)
        return this.compactImpl(input)
    }

    dispose(): void {
        this.disposed = true
    }
}

function makeSubAgent(
    partial: Pick<
        SubAgentRecord,
        'id' | 'name' | 'parentSessionId' | 'parentToolCallId'
    >,
): SubAgentRecord {
    return {
        color: '#9b7dff',
        icon: 'sparkle',
        sessionId: partial.id,
        modelId: 'test-model',
        status: 'completed',
        createdAt: 1,
        updatedAt: 1,
        ...partial,
    }
}

function seedReadyWorktreeSession(input: {
    sourceTreePath?: string
    includeProject: boolean
}): string {
    const sessionId = 'restored-worktree'
    if (input.includeProject) {
        useProjectStore.setState({ projects: [{
            id: 'project-1',
            name: 'Repo',
            path: '/projects/repo',
            pinned: false,
            createdAt: 1,
            updatedAt: 1,
        }] })
    }
    const setup = {
        sessionId,
        status: 'ready' as const,
        stepWorkspace: 'done' as const,
        stepCheckout: 'done' as const,
        stepEnvironment: 'done' as const,
        worktreePath: '/worktrees/repo-session',
        ...(input.sourceTreePath
            ? { sourceTreePath: input.sourceTreePath }
            : {}),
        logs: '',
        expandedDetails: false,
    }
    useSessionStore.getState().createSession({
        id: sessionId,
        title: 'Restored',
        ...(input.includeProject ? { projectId: 'project-1' } : {}),
        workLocation: 'worktree',
        worktreePath: '/worktrees/repo-session',
        worktreeSetup: setup,
    })
    useSessionStore.getState().setCurrentSession(sessionId)
    useWorktreeSetupStore.getState().importSetups({ [sessionId]: setup })
    return sessionId
}

function seedLocalSessionWithStaleWorktreeMetadata(): string {
    const sessionId = 'local-stale-worktree-session'
    useProjectStore.setState({ projects: [{
        id: 'project-1',
        name: 'Repo',
        path: '/projects/repo',
        pinned: false,
        createdAt: 1,
        updatedAt: 1,
    }] })
    const staleSetup = {
        sessionId,
        status: 'ready' as const,
        stepWorkspace: 'done' as const,
        stepCheckout: 'done' as const,
        stepEnvironment: 'done' as const,
        worktreePath: '/worktrees/stale-worktree',
        sourceTreePath: '/projects/repo',
        logs: '',
        expandedDetails: false,
    }
    useSessionStore.getState().createSession({
        id: sessionId,
        title: 'Local Session',
        projectId: 'project-1',
        workLocation: 'local',
        worktreePath: '/worktrees/stale-worktree',
        worktreeSetup: staleSetup,
    })
    useSessionStore.getState().setCurrentSession(sessionId)
    return sessionId
}

function wrapperFor(service: AgentService) {
    return function Wrapper({ children }: { children: ReactNode }) {
        return createElement(AgentServiceProvider, { service }, children)
    }
}

function resetStores(): void {
    useMessageStore.setState({ entriesBySession: {} })
    useSessionStore.setState({ sessions: [], currentSessionId: null })
    useProjectStore.setState({ projects: [] })
    useWorktreeSetupStore.setState({ setups: {} })
    useSubAgentStore.setState({
        agents: [],
        openTabIdsByParent: {},
        focusedIdByParent: {},
    })
    useUiStore.setState({ toasts: [], composerDraft: '' })
    useSettingsStore.getState().hydrate({
        modelId: model.id,
        reasoningLevel: 'medium',
        speed: 'standard',
        requestApproval: false,
        fastContextCompaction: true,
        cliProxyApi: { baseUrl: 'http://127.0.0.1:8317', apiKey: 'key' },
        locale: 'en',
    })
    useModelCatalogStore.setState({
        models: [model, modelTextOnly],
        status: 'ready',
        error: null,
    })
}

const originalUserAgent = navigator.userAgent

describe('useAgentStream', () => {
    let service: FakeService

    beforeEach(() => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Electron/34.2.0 Safari/537.36',
            configurable: true,
        })
        service = new FakeService()
        persistTestState.flushPendingPersistence.mockReset()
        persistTestState.flushPendingPersistence.mockResolvedValue(undefined)
        service.prepareImpl = async (input) => makePrepared({
            projectCwd: input.projectPath ?? undefined,
            projectPaths: input.projectPaths?.slice() ?? [],
            worktreePolicy: input.worktreePolicy,
        })
        __resetAgentStreamForTests(service)
        resetStores()
        service.streamEvents = [
            {
                type: 'assistant-start',
                runId: 'x',
                sessionId: 'x',
                entry: {
                    id: 'a1',
                    sessionId: 'x',
                    createdAt: 1,
                    kind: 'assistant',
                    content: [{ type: 'text', text: 'hi' }],
                    stopReason: 'pending',
                    status: 'streaming',
                },
            },
            {
                type: 'assistant-end',
                runId: 'x',
                sessionId: 'x',
                entry: {
                    id: 'a1',
                    sessionId: 'x',
                    createdAt: 1,
                    kind: 'assistant',
                    content: [{ type: 'text', text: 'hi' }],
                    stopReason: 'stop',
                    status: 'done',
                },
            },
        ]
    })

    afterEach(() => {
        Object.defineProperty(navigator, 'userAgent', {
            value: originalUserAgent,
            configurable: true,
        })
        __resetAgentStreamForTests(service)
        vi.useRealTimers()
    })

    it('preflight failure creates no session or user entry and rejects', async () => {
        service.prepareImpl = async () => {
            throw new AgentPreflightError(
                'missing_api_key',
                'API key required',
                'agent.preflight.missing_api_key',
            )
        }

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })

        await expect(
            act(async () => result.current.send('hello')),
        ).rejects.toMatchObject({ code: 'missing_api_key' })

        expect(useSessionStore.getState().sessions).toHaveLength(0)
        expect(Object.keys(useMessageStore.getState().entriesBySession)).toHaveLength(
            0,
        )
        expect(result.current.isStreaming).toBe(false)
        expect(service.streamCalls).toHaveLength(0)
        expect(useUiStore.getState().toasts.length).toBeGreaterThan(0)
    })

    it('config fail with pending projectId still creates zero sessions', async () => {
        service.prepareImpl = async () => {
            throw new AgentPreflightError(
                'invalid_base_url',
                'bad url',
                'agent.preflight.invalid_base_url',
            )
        }
        useProjectStore.setState({
            projects: [
                {
                    id: 'proj-1',
                    name: 'P',
                    path: '/repo',
                    pinned: false,
                    createdAt: 1,
                    updatedAt: 1,
                },
            ],
        })

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })

        await expect(
            act(async () =>
                result.current.send({
                    text: 'hello',
                    projectId: 'proj-1',
                }),
            ),
        ).rejects.toBeTruthy()

        expect(useSessionStore.getState().sessions).toHaveLength(0)
        expect(useMessageStore.getState().entriesBySession).toEqual({})
    })

    it('successful send creates session + UserEntry once and streams to original session', async () => {
        const { result } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })

        let sessionId: string | null = null
        await act(async () => {
            sessionId = await result.current.send('hello world')
        })

        expect(sessionId).toBeTruthy()
        expect(useSessionStore.getState().sessions).toHaveLength(1)

        await waitFor(() => {
            expect(result.current.isStreaming).toBe(false)
        })

        const entries = useMessageStore.getState().getEntries(sessionId!)
        const users = entries.filter((e) => e.kind === 'user')
        expect(users).toHaveLength(1)
        expect(users[0].content).toEqual([{ type: 'text', text: 'hello world' }])
        expect(service.streamCalls).toHaveLength(1)
        expect(service.prepareInputs[0]?.fastContextCompaction).toBe(true)
        expect(service.prepareInputs[0]?.language).toBe('en')
        const streamInput = service.streamCalls[0] as {
            sessionId: string
            entries: { kind: string }[]
            userEntry: { id: string }
        }
        expect(streamInput.sessionId).toBe(sessionId)
        expect(
            streamInput.entries.filter((e) => e.kind === 'user'),
        ).toHaveLength(1)
    })

    it('resends an edited user entry without any later context', async () => {
        const sessionId = useSessionStore.getState().createSession({ title: 't' })
        useSessionStore.getState().setCurrentSession(sessionId)
        useMessageStore.getState().appendEntry({
            id: 'u1',
            sessionId,
            createdAt: 1,
            kind: 'user',
            content: [{ type: 'text', text: 'first' }],
        })
        useMessageStore.getState().appendEntry({
            id: 'a1',
            sessionId,
            createdAt: 2,
            kind: 'assistant',
            content: [{ type: 'text', text: 'old answer' }],
            stopReason: 'stop',
            status: 'done',
        })
        useMessageStore.getState().appendEntry({
            id: 'u2',
            sessionId,
            createdAt: 3,
            kind: 'user',
            content: [{ type: 'text', text: 'later question' }],
        })

        let release!: () => void
        service.streamHold = new Promise<void>((resolve) => {
            release = resolve
        })

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })

        let sentSessionId: string | null = null
        await act(async () => {
            sentSessionId = await result.current.send({
                text: 'edited first',
                sessionId,
                editMessageId: 'u1',
            })
        })

        expect(sentSessionId).toBe(sessionId)
        const entries = useMessageStore.getState().getEntries(sessionId)
        expect(entries).toEqual([
            expect.objectContaining({
                id: 'u1',
                kind: 'user',
                content: [{ type: 'text', text: 'edited first' }],
            }),
        ])
        expect(entries[0]?.createdAt).toBeGreaterThan(1)
        await waitFor(() => expect(service.streamCalls).toHaveLength(1))
        expect(
            (service.streamCalls[0] as { entries: { id: string }[] }).entries,
        ).toEqual([expect.objectContaining({ id: 'u1' })])
        await waitFor(() => expect(result.current.isStreaming).toBe(true))

        release()
        await waitFor(() => expect(result.current.isStreaming).toBe(false))
        expect(
            useMessageStore
                .getState()
                .getEntries(sessionId)
                .filter((entry) => entry.kind === 'user'),
        ).toHaveLength(1)
    })

    it('removes historical sub-agents when an earlier user entry is resent', async () => {
        const sessionId = useSessionStore.getState().createSession({ title: 't' })
        useSessionStore.getState().setCurrentSession(sessionId)
        useMessageStore.getState().appendEntry({
            id: 'u1',
            sessionId,
            createdAt: 1,
            kind: 'user',
            content: [{ type: 'text', text: 'first' }],
        })
        useMessageStore.getState().appendEntry({
            id: 'a1',
            sessionId,
            createdAt: 2,
            kind: 'assistant',
            content: [
                {
                    type: 'toolCall',
                    id: 'call-keep',
                    name: 'spawn_agent',
                    arguments: { name: 'Keep', prompt: 'earlier' },
                },
            ],
            stopReason: 'toolUse',
            status: 'done',
        })
        useMessageStore.getState().appendEntry({
            id: 'u2',
            sessionId,
            createdAt: 3,
            kind: 'user',
            content: [{ type: 'text', text: 'later' }],
        })
        useMessageStore.getState().appendEntry({
            id: 'a2',
            sessionId,
            createdAt: 4,
            kind: 'assistant',
            content: [
                {
                    type: 'toolCall',
                    id: 'call-drop',
                    name: 'spawn_agent',
                    arguments: { name: 'Drop', prompt: 'later' },
                },
            ],
            stopReason: 'toolUse',
            status: 'done',
        })

        const keep = makeSubAgent({
            id: 'ag-keep',
            name: 'Keep',
            parentSessionId: sessionId,
            parentToolCallId: 'call-keep',
        })
        const drop = makeSubAgent({
            id: 'ag-drop',
            name: 'Drop',
            parentSessionId: sessionId,
            parentToolCallId: 'call-drop',
        })
        const other = makeSubAgent({
            id: 'ag-other',
            name: 'Other',
            parentSessionId: 'other-session',
            parentToolCallId: 'call-other',
        })
        useSubAgentStore.setState({
            agents: [keep, drop, other],
            openTabIdsByParent: { [sessionId]: ['ag-drop'] },
            focusedIdByParent: { [sessionId]: 'ag-drop' },
        })
        useMessageStore.getState().appendEntry({
            id: 'child-u',
            sessionId: 'ag-drop',
            createdAt: 5,
            kind: 'user',
            content: [{ type: 'text', text: 'child work' }],
        })

        service.subAgents = new SubAgentHost({
            generateId: () => 'x',
            now: () => 1,
            run: async function* () {},
        })

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })

        await act(async () => {
            await result.current.send({
                text: 'edited later',
                sessionId,
                editMessageId: 'u2',
            })
        })

        const remaining = useSubAgentStore.getState().agents
        expect(remaining.map((agent) => agent.id).sort()).toEqual([
            'ag-keep',
            'ag-other',
        ])
        expect(service.subAgents.get('ag-drop')).toBeUndefined()
        expect(service.subAgents.get('ag-keep')?.id).toBe('ag-keep')
        expect(useMessageStore.getState().getEntries('ag-drop')).toEqual([])
        await waitFor(() => expect(result.current.isStreaming).toBe(false))
    })

    it('removes every session sub-agent when the first user entry is resent', async () => {
        const sessionId = useSessionStore.getState().createSession({ title: 't' })
        useSessionStore.getState().setCurrentSession(sessionId)
        useMessageStore.getState().appendEntry({
            id: 'u1',
            sessionId,
            createdAt: 1,
            kind: 'user',
            content: [{ type: 'text', text: 'first' }],
        })
        useMessageStore.getState().appendEntry({
            id: 'a1',
            sessionId,
            createdAt: 2,
            kind: 'assistant',
            content: [
                {
                    type: 'toolCall',
                    id: 'call-1',
                    name: 'spawn_agent',
                    arguments: { name: 'Atlas', prompt: 'work' },
                },
            ],
            stopReason: 'toolUse',
            status: 'done',
        })
        useSubAgentStore.setState({
            agents: [
                makeSubAgent({
                    id: 'ag-1',
                    name: 'Atlas',
                    parentSessionId: sessionId,
                    parentToolCallId: 'call-1',
                }),
            ],
            openTabIdsByParent: {},
            focusedIdByParent: {},
        })

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })

        await act(async () => {
            await result.current.send({
                text: 'edited first',
                sessionId,
                editMessageId: 'u1',
            })
        })

        expect(useSubAgentStore.getState().agents).toEqual([])
        await waitFor(() => expect(result.current.isStreaming).toBe(false))
    })

    it('pending projectId creates session after preflight with that project', async () => {
        useProjectStore.setState({
            projects: [
                {
                    id: 'proj-9',
                    name: 'Repo',
                    path: '/repo',
                    paths: ['/repo', '/repo-shared'],
                    pinned: false,
                    createdAt: 1,
                    updatedAt: 1,
                },
            ],
        })
        const { result } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })

        let sessionId: string | null = null
        await act(async () => {
            sessionId = await result.current.send({
                text: 'hi',
                projectId: 'proj-9',
                branch: 'dev',
            })
        })

        expect(sessionId).toBeTruthy()
        const session = useSessionStore
            .getState()
            .sessions.find((s) => s.id === sessionId)
        expect(session?.projectId).toBe('proj-9')
        expect(session?.branch).toBe('dev')
        expect(service.prepareInputs[0]?.projectPath).toBe('/repo')
        expect(service.prepareInputs[0]?.projectPaths).toEqual([
            '/repo',
            '/repo-shared',
        ])
        await waitFor(() => expect(result.current.isStreaming).toBe(false))
    })

    it('falls back to pendingSessionContext when no projectId provided in payload', async () => {
        useProjectStore.setState({
            projects: [
                {
                    id: 'proj-pending',
                    name: 'PendingRepo',
                    path: '/pending-repo',
                    pinned: false,
                    createdAt: 1,
                    updatedAt: 1,
                },
            ],
        })
        useUiStore.setState({
            pendingSessionContext: {
                projectId: 'proj-pending',
                branch: 'feature-review',
            },
        })

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })

        let sessionId: string | null = null
        await act(async () => {
            sessionId = await result.current.send('review prompt')
        })

        expect(sessionId).toBeTruthy()
        const session = useSessionStore
            .getState()
            .sessions.find((s) => s.id === sessionId)
        expect(session?.projectId).toBe('proj-pending')
        expect(session?.branch).toBe('feature-review')
        expect(service.prepareInputs[0]?.projectPath).toBe('/pending-repo')
        await waitFor(() => expect(result.current.isStreaming).toBe(false))
    })

    it('allows image-only sends', async () => {
        const { result } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })

        let sessionId: string | null = null
        await act(async () => {
            sessionId = await result.current.send({
                text: '   ',
                images: [
                    {
                        id: 'img1',
                        name: 'a.png',
                        mimeType: 'image/png',
                        data: 'abc',
                        width: 10,
                        height: 10,
                    },
                ],
            })
        })

        expect(sessionId).toBeTruthy()
        await waitFor(() => expect(result.current.isStreaming).toBe(false))
        const entries = useMessageStore.getState().getEntries(sessionId!)
        const user = entries.find((e) => e.kind === 'user')
        expect(user?.content).toEqual([
            { type: 'image', data: 'abc', mimeType: 'image/png' },
        ])
    })

    it('supportsImages derives from live model catalog, not last prepare', async () => {
        const { result, rerender } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })

        expect(result.current.supportsImages).toBe(true)

        act(() => {
            useSettingsStore.getState().setModelId(modelTextOnly.id)
        })
        rerender()
        expect(result.current.supportsImages).toBe(false)

        act(() => {
            useSettingsStore.getState().setModelId(model.id)
        })
        rerender()
        expect(result.current.supportsImages).toBe(true)
    })

    it('send during active preflight interrupts prior run and sends new prompt', async () => {
        let release!: () => void
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        service.prepareImpl = async () => {
            await gate
            return makePrepared()
        }

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })

        let first!: Promise<string | null>
        let second!: Promise<string | null>
        act(() => {
            first = result.current.send('one')
        })
        const firstSettled = first.then(
            (v) => ({ ok: true as const, v }),
            (e: unknown) => ({ ok: false as const, e }),
        )

        act(() => {
            second = result.current.send('two')
        })

        const firstOutcome = await firstSettled
        expect(firstOutcome.ok).toBe(false)
        if (!firstOutcome.ok) {
            expect(firstOutcome.e).toMatchObject({ name: 'AbortError' })
        }

        release()
        await expect(second).resolves.toBeTruthy()
        await waitFor(() => expect(result.current.isStreaming).toBe(false))
    })

    it('send during active streamChat with steer mode queues steer and does not abort flight', async () => {
        let releaseHold: () => void = () => {}
        service.streamHold = new Promise<void>((resolve) => {
            releaseHold = resolve
        })

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })

        let firstSessionId: string | null = null
        await act(async () => {
            firstSessionId = await result.current.send('first prompt')
        })

        expect(firstSessionId).toBeTruthy()
        expect(result.current.isStreaming).toBe(true)
        const firstRunId = result.current.runId
        expect(firstRunId).toBeTruthy()

        let secondSessionId: string | null = null
        await act(async () => {
            secondSessionId = await result.current.send({
                text: 'second prompt steer',
                sessionId: firstSessionId!,
                followUpMode: 'steer',
            })
        })

        expect(service.abortCalls).not.toContain(firstRunId)
        expect(secondSessionId).toBe(firstSessionId)
        let entries = useMessageStore.getState().getEntries(firstSessionId!)
        const steerEntry = entries.find((e) => e.kind === 'user' && (e as any).pendingStatus === 'steer')
        expect(steerEntry).toBeDefined()

        // Send a second steer message while still running
        let thirdSessionId: string | null = null
        await act(async () => {
            thirdSessionId = await result.current.send({
                text: 'third prompt steer',
                sessionId: firstSessionId!,
                followUpMode: 'steer',
            })
        })
        expect(thirdSessionId).toBe(firstSessionId)
        entries = useMessageStore.getState().getEntries(firstSessionId!)
        const steerEntries = entries.filter((e) => e.kind === 'user' && (e as any).pendingStatus === 'steer')
        expect(steerEntries).toHaveLength(2)

        // Verify consumeSteerEntries passes all steer entries
        const firstStreamCall = service.streamCalls[0] as AgentStreamChatInput
        expect(firstStreamCall.consumeSteerEntries).toBeDefined()
        const consumed = firstStreamCall.consumeSteerEntries!()
        expect(consumed).toHaveLength(2)
        expect(consumed![0].id).toBe(steerEntries[0].id)
        expect(consumed![1].id).toBe(steerEntries[1].id)
        expect(consumed![0].pendingStatus).toBeUndefined()
        expect(consumed![1].pendingStatus).toBeUndefined()

        releaseHold()
        await waitFor(() => expect(result.current.isStreaming).toBe(false))
    })

    it('send during active streamChat with queue mode queues entry and auto-runs on turn completion', async () => {
        let releaseHold: () => void = () => {}
        service.streamHold = new Promise<void>((resolve) => {
            releaseHold = resolve
        })

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })

        let firstSessionId: string | null = null
        await act(async () => {
            firstSessionId = await result.current.send('first prompt')
        })

        expect(firstSessionId).toBeTruthy()
        expect(result.current.isStreaming).toBe(true)
        const firstRunId = result.current.runId

        let queuedSessionId: string | null = null
        await act(async () => {
            queuedSessionId = await result.current.send({
                text: 'queued message 1',
                sessionId: firstSessionId!,
                followUpMode: 'queue',
            })
        })

        expect(service.abortCalls).not.toContain(firstRunId)
        expect(queuedSessionId).toBe(firstSessionId)
        let entries = useMessageStore.getState().getEntries(firstSessionId!)
        const queuedEntry = entries.find((e) => e.kind === 'user' && (e as any).pendingStatus === 'queue')
        expect(queuedEntry).toBeDefined()

        // Test dequeueMessage before completion
        const dequeued = await getHostAgentController()?.dequeueMessage?.(firstSessionId!, queuedEntry!.id)
        expect(dequeued?.text).toBe('queued message 1')
        entries = useMessageStore.getState().getEntries(firstSessionId!)
        expect(entries.some((e) => e.id === queuedEntry!.id)).toBe(false)

        releaseHold()
        await waitFor(() => expect(result.current.isStreaming).toBe(false))
    })

    it('auto-executes queued message with refreshed createdAt when turn completes', async () => {
        let releaseFirstHold: () => void = () => {}
        service.streamHold = new Promise<void>((resolve) => {
            releaseFirstHold = resolve
        })

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })

        let sessionId: string | null = null
        await act(async () => {
            sessionId = await result.current.send('first prompt')
        })
        expect(sessionId).toBeTruthy()
        expect(result.current.isStreaming).toBe(true)

        // Queue a second message with an older timestamp
        const oldQueuedTime = Date.now() - 50_000
        await act(async () => {
            await result.current.send({
                text: 'queued prompt 2',
                sessionId: sessionId!,
                followUpMode: 'queue',
                userEntryCreatedAt: oldQueuedTime,
            })
        })

        let entries = useMessageStore.getState().getEntries(sessionId!)
        const queuedBefore = entries.find((e) => e.kind === 'user' && (e as any).pendingStatus === 'queue')
        expect(queuedBefore).toBeDefined()

        // Complete first turn
        service.streamHold = null
        releaseFirstHold()

        // Wait for queued run to be triggered
        await waitFor(() => {
            const currentEntries = useMessageStore.getState().getEntries(sessionId!)
            const target = currentEntries.find((e) => (e as any).id === queuedBefore!.id) as any
            expect(target?.pendingStatus).toBeUndefined()
            // createdAt must be updated to recent execution time, NOT the 50s old timestamp!
            expect(target?.createdAt).toBeGreaterThan(oldQueuedTime + 40_000)
        })
    })

    it('auto-executes multiple queued messages in batch and sends all to LLM when turn completes', async () => {
        let releaseFirstHold: () => void = () => {}
        service.streamHold = new Promise<void>((resolve) => {
            releaseFirstHold = resolve
        })

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })

        let sessionId: string | null = null
        await act(async () => {
            sessionId = await result.current.send('first prompt')
        })
        expect(sessionId).toBeTruthy()
        expect(result.current.isStreaming).toBe(true)

        // Queue message 1
        await act(async () => {
            await result.current.send({
                text: 'queued prompt A',
                sessionId: sessionId!,
                followUpMode: 'queue',
            })
        })

        // Queue message 2
        await act(async () => {
            await result.current.send({
                text: 'queued prompt B',
                sessionId: sessionId!,
                followUpMode: 'queue',
            })
        })

        const entriesBefore = useMessageStore.getState().getEntries(sessionId!)
        const queuedList = entriesBefore.filter((e) => e.kind === 'user' && (e as any).pendingStatus === 'queue')
        expect(queuedList).toHaveLength(2)

        // Complete first turn
        service.streamHold = null
        releaseFirstHold()

        // Wait for queued batch run to be triggered
        await waitFor(() => {
            const currentEntries = useMessageStore.getState().getEntries(sessionId!)
            const qA = currentEntries.find((e) => e.id === queuedList[0].id) as any
            const qB = currentEntries.find((e) => e.id === queuedList[1].id) as any
            expect(qA?.pendingStatus).toBeUndefined()
            expect(qB?.pendingStatus).toBeUndefined()
        })

        // Verify that the second streamChat call received BOTH queued entries in its entries payload
        await waitFor(() => {
            expect(service.streamCalls.length).toBeGreaterThanOrEqual(2)
        })
        const secondCall = service.streamCalls[1] as AgentStreamChatInput
        const entryIds = secondCall.entries.map((e) => e.id)
        expect(entryIds).toContain(queuedList[0].id)
        expect(entryIds).toContain(queuedList[1].id)
    })

    it('stop during never-resolving prepare releases flight and rejects', async () => {
        service.prepareImpl = () => new Promise(() => {})

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })

        let pending!: Promise<string | null>
        act(() => {
            pending = result.current.send('hello')
        })

        await waitFor(() => expect(result.current.isStreaming).toBe(true))

        act(() => {
            result.current.stop()
        })

        await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
        await waitFor(() => expect(result.current.isStreaming).toBe(false))
        expect(result.current.runStatus).toBe('idle')
        expect(useSessionStore.getState().sessions).toHaveLength(0)
    })

    it('session removed during preflight aborts without creating another session', async () => {
        const sessionId = useSessionStore.getState().createSession({ title: 't' })
        useSessionStore.getState().setCurrentSession(sessionId)

        let release!: () => void
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        service.prepareImpl = async () => {
            await gate
            return makePrepared()
        }

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })

        let pending!: Promise<string | null>
        act(() => {
            pending = result.current.send('hello')
        })

        act(() => {
            useSessionStore.getState().removeSession(sessionId)
        })
        release()

        await expect(pending).rejects.toMatchObject({ code: 'session_gone' })
        expect(useSessionStore.getState().sessions).toHaveLength(0)
        expect(service.streamCalls).toHaveLength(0)
    })

    it('approve/reject route exact current runId', async () => {
        let release!: () => void
        service.streamHold = new Promise<void>((resolve) => {
            release = resolve
        })

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })

        await act(async () => {
            void result.current.send('hello')
        })

        await waitFor(() => expect(result.current.runId).toBeTruthy())
        const runId = result.current.runId!

        act(() => {
            result.current.approveTool('tool-1')
            result.current.rejectTool('tool-2')
        })

        expect(service.approveCalls).toEqual([[runId, 'tool-1']])
        expect(service.rejectCalls).toEqual([[runId, 'tool-2']])

        release()
        await waitFor(() => expect(result.current.isStreaming).toBe(false))
    })

    it('stop aborts controller and service with runId', async () => {
        let release!: () => void
        service.streamHold = new Promise<void>((resolve) => {
            release = resolve
        })

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })

        await act(async () => {
            void result.current.send('hello')
        })
        await waitFor(() => expect(result.current.runId).toBeTruthy())
        const runId = result.current.runId!

        act(() => {
            result.current.stop()
        })

        expect(service.abortCalls).toContain(runId)
        release()
        await waitFor(() => expect(result.current.isStreaming).toBe(false))
    })

    it('manual compact persists entry via agent-start…agent-end and keeps draft path free of user entry', async () => {
        useSettingsStore.getState().setFastContextCompaction(false)
        const sessionId = useSessionStore.getState().createSession({ title: 't' })
        useMessageStore.getState().appendEntry({
            id: 'u1',
            sessionId,
            createdAt: 1,
            kind: 'user',
            content: [{ type: 'text', text: 'prior' }],
        })

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })

        await act(async () => {
            await result.current.compact('focus on tests')
        })

        const after = useMessageStore.getState().getEntries(sessionId)
        const users = after.filter((e) => e.kind === 'user')
        expect(users).toHaveLength(1)
        expect(after.some((e) => e.kind === 'compaction')).toBe(true)
        expect(service.compactCalls).toHaveLength(1)
        expect(
            service.prepareInputs[service.prepareInputs.length - 1]
                ?.fastContextCompaction,
        ).toBe(false)
        expect(
            service.prepareInputs[service.prepareInputs.length - 1]?.language,
        ).toBe('en')
        expect(result.current.isStreaming).toBe(false)
    })

    it('passes zh-CN language when locale is set to zh-CN', async () => {
        useSettingsStore.getState().setLocale('zh-CN')
        const { result } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })

        await act(async () => {
            await result.current.send('Hello')
        })

        expect(service.prepareInputs[0]?.language).toBe('zh-CN')
    })

    it('events stay on original session when currentSession changes mid-stream', async () => {
        let release!: () => void
        service.streamHold = new Promise<void>((resolve) => {
            release = resolve
        })

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })

        let original: string | null = null
        await act(async () => {
            original = await result.current.send('hello')
        })
        expect(original).toBeTruthy()

        const other = useSessionStore.getState().createSession({ title: 'other' })
        useSessionStore.getState().setCurrentSession(other)

        release()
        await waitFor(() => expect(result.current.isStreaming).toBe(false))

        const streamInput = service.streamCalls[0] as { sessionId: string }
        expect(streamInput.sessionId).toBe(original)
        const originalEntries = useMessageStore
            .getState()
            .getEntries(original!)
        expect(originalEntries.some((e) => e.kind === 'assistant')).toBe(true)
        expect(useMessageStore.getState().getEntries(other)).toHaveLength(0)
    })

    it('two providers isolate flight state while same service shares single-flight', async () => {
        const serviceA = new FakeService()
        const serviceB = new FakeService()
        __resetAgentStreamForTests(serviceA)
        __resetAgentStreamForTests(serviceB)

        let releaseA!: () => void
        serviceA.prepareImpl = () =>
            new Promise((resolve) => {
                releaseA = () => resolve(makePrepared())
            })

        const hookA = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(serviceA),
        })
        const hookB = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(serviceB),
        })
        const hookA2 = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(serviceA),
        })

        let a1Promise!: Promise<string | null>
        act(() => {
            a1Promise = hookA.result.current.send('a1')
        })
        const a1Settled = a1Promise.then(
            (v) => ({ ok: true as const, v }),
            (e: unknown) => ({ ok: false as const, e }),
        )
        await waitFor(() => expect(hookA.result.current.isStreaming).toBe(true))
        expect(hookA2.result.current.isStreaming).toBe(true)
        expect(hookB.result.current.isStreaming).toBe(false)

        let secondA!: Promise<string | null>
        act(() => {
            secondA = hookA2.result.current.send('a2')
        })
        const a1Outcome = await a1Settled
        expect(a1Outcome.ok).toBe(false)
        if (!a1Outcome.ok) {
            expect(a1Outcome.e).toMatchObject({ name: 'AbortError' })
        }

        let bSend!: Promise<string | null>
        act(() => {
            bSend = hookB.result.current.send('b1')
        })
        await expect(bSend).resolves.toBeTruthy()

        releaseA()
        await expect(secondA).resolves.toBeTruthy()
        await waitFor(() => expect(hookA.result.current.isStreaming).toBe(false))

        expect(__getAgentStreamSnapshotForTests(serviceA).isStreaming).toBe(false)
        hookA.unmount()
        hookB.unmount()
        hookA2.unmount()
    })

    it('disposeAgentRuntime aborts never-resolving prepare without creating a session', async () => {
        service.prepareImpl = () => new Promise(() => {})

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })

        let pending!: Promise<string | null>
        act(() => {
            pending = result.current.send('hello')
        })
        // Observe early so abort rejection during dispose is never unhandled.
        const settled = pending.then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error }),
        )

        await waitFor(() => expect(result.current.isStreaming).toBe(true))
        expect(useSessionStore.getState().sessions).toHaveLength(0)

        await act(async () => {
            await disposeAgentRuntime(service)
        })

        const outcome = await settled
        expect(outcome.ok).toBe(false)
        if (!outcome.ok) {
            expect(outcome.error).toMatchObject({ name: 'AbortError' })
        }
        expect(useSessionStore.getState().sessions).toHaveLength(0)
        expect(service.disposed).toBe(true)
        expect(service.streamCalls).toHaveLength(0)
    })

    it('disposeAgentRuntime notifies idle once, tombstones runtime, same service send rejects', async () => {
        const { result } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })

        const snapshots: string[] = []
        // Subscribe via the hook's external store by reading after dispose.
        await act(async () => {
            await disposeAgentRuntime(service)
        })

        // Same service remains tombstoned: idle snapshot, send rejects, no recreated flight.
        expect(__getAgentStreamSnapshotForTests(service)).toMatchObject({
            isStreaming: false,
            runStatus: 'idle',
        })
        snapshots.push(__getAgentStreamSnapshotForTests(service).runStatus)

        await act(async () => {
            await expect(result.current.send('after-dispose')).rejects.toMatchObject({
                code: 'disposed',
            })
        })
        expect(__getAgentStreamSnapshotForTests(service).isStreaming).toBe(false)
        expect(service.prepareCalls).toBe(0)

        // Idempotent dispose.
        await act(async () => {
            await disposeAgentRuntime(service)
        })
        expect(snapshots).toEqual(['idle'])

        // A brand-new service object gets a fresh non-disposed runtime.
        const service2 = new FakeService()
        const hook2 = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service2),
        })
        expect(__getAgentStreamSnapshotForTests(service2).runStatus).toBe('idle')
        await act(async () => {
            await hook2.result.current.send('fresh')
        })
        await waitFor(() =>
            expect(__getAgentStreamSnapshotForTests(service2).isStreaming).toBe(false),
        )
        expect(service2.prepareCalls).toBe(1)
        hook2.unmount()
    })

    it('creates a new session when explicit sessionId is null even if currentSessionId is set', async () => {
        const oldSessionId = useSessionStore.getState().createSession({ title: 'Old Session' })
        useSessionStore.getState().setCurrentSession(oldSessionId)

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })

        let createdSessionId: string | null = null
        await act(async () => {
            createdSessionId = await result.current.send({
                text: 'New conversation starting from home',
                sessionId: null,
            })
        })

        await waitFor(() => expect(result.current.isStreaming).toBe(false))

        expect(createdSessionId).not.toBeNull()
        expect(createdSessionId).not.toBe(oldSessionId)
        expect(useSessionStore.getState().sessions).toHaveLength(2)
        expect(
            useSessionStore.getState().sessions.find((session) => session.id === createdSessionId),
        ).toMatchObject({
            modelId: 'test-model',
            reasoningEffort: 'medium',
            speed: 'standard',
        })
        expect(useMessageStore.getState().getEntries(oldSessionId)).toHaveLength(0)
        const newEntries = useMessageStore.getState().getEntries(createdSessionId!)
        expect(newEntries.length).toBeGreaterThanOrEqual(1)
        expect(newEntries[0].kind).toBe('user')
        expect((newEntries[0] as import('@/features/agent-runtime/session/types').UserEntry).content[0]).toEqual({
            type: 'text',
            text: 'New conversation starting from home',
        })
    })

    it('resumes unfinished session without appending extra user message', async () => {
        const sessionId = useSessionStore.getState().createSession({ title: 'Unfinished' })
        useSessionStore.getState().setCurrentSession(sessionId)

        useMessageStore.getState().appendEntry({
            id: 'u1',
            sessionId,
            createdAt: 100,
            kind: 'user',
            content: [{ type: 'text', text: 'Original question' }],
        })

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })

        let resumedId: string | null = null
        await act(async () => {
            resumedId = await result.current.resumeSession(sessionId)
        })

        await waitFor(() => expect(result.current.isStreaming).toBe(false))
        expect(resumedId).toBe(sessionId)
        expect(service.streamCalls).toHaveLength(1)
        const call = service.streamCalls[0] as AgentStreamChatInput
        expect(call.sessionId).toBe(sessionId)
        expect(call.entries).toHaveLength(1)
        expect(call.entries[0].id).toBe('u1')
    })

    it('resumes an interrupted session with its recorded settings without overwriting the global selection', async () => {
        const sessionId = 'interrupted-session'
        const interruptedSession = {
            id: sessionId,
            title: 'Interrupted',
            pinned: false,
            modelId: 'gpt-5.6-sol',
            reasoningEffort: 'xhigh',
            speed: 'standard' as const,
            createdAt: 1,
            updatedAt: 1,
        }
        useSessionStore.setState({
            sessions: [interruptedSession],
            currentSessionId: sessionId,
        })
        useSettingsStore.getState().hydrate({
            modelId: 'gemini-3.7-flash',
            reasoningLevel: 'high',
            speed: 'fast',
        })
        useMessageStore.getState().appendEntry({
            id: 'u1',
            sessionId,
            createdAt: 100,
            kind: 'user',
            content: [{ type: 'text', text: 'Original question' }],
        })

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })

        await act(async () => {
            await result.current.resumeSession(sessionId)
        })

        await waitFor(() => expect(result.current.isStreaming).toBe(false))
        expect(service.prepareInputs[0]).toMatchObject({
            modelId: 'gpt-5.6-sol',
            reasoningLevel: 'xhigh',
            speed: 'standard',
        })
        expect(useSettingsStore.getState().settings).toMatchObject({
            modelId: 'gemini-3.7-flash',
            reasoningLevel: 'high',
            speed: 'fast',
        })
    })

    it('accumulates pausedMs on user entry when resuming an interrupted session to exclude stopped time', async () => {
        const sessionId = 'paused-session'
        const session = {
            id: sessionId,
            title: 'Paused and Resumed',
            pinned: false,
            createdAt: 1000,
            updatedAt: 1000,
        }
        useSessionStore.setState({
            sessions: [session],
            currentSessionId: sessionId,
        })

        // User message sent at t = 1000
        useMessageStore.getState().appendEntry({
            id: 'u1',
            sessionId,
            createdAt: 1000,
            kind: 'user',
            content: [{ type: 'text', text: 'Run long task' }],
        })

        // Assistant interrupted at t = 10_000 (ran for 9s)
        useMessageStore.getState().appendEntry({
            id: 'a1',
            sessionId,
            createdAt: 1000,
            completedAt: 10_000,
            kind: 'assistant',
            status: 'aborted',
            stopReason: 'aborted',
            content: [{ type: 'text', text: 'Partial text before interruption' }],
        })

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })

        // Mock Date.now() to 70_000 when resume is clicked (stopped for 60_000ms = 60s)
        const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(70_000)

        try {
            await act(async () => {
                await result.current.resumeSession(sessionId)
            })

            await waitFor(() => expect(result.current.isStreaming).toBe(false))

            // Check that the user entry's pausedMs was updated to 60_000
            const entries = useMessageStore.getState().getEntries(sessionId)
            const userEntry = entries.find((e) => e.id === 'u1')
            expect(userEntry).toBeDefined()
            expect(userEntry?.pausedMs).toBe(60_000) // 70_000 - 10_000 = 60_000ms paused
        } finally {
            dateNowSpy.mockRestore()
        }
    })

    it('clears pausedMs on retrySession so retrying from scratch starts with zero pause', async () => {
        const sessionId = 'retry-paused-session'
        const session = {
            id: sessionId,
            title: 'Paused and Retried',
            pinned: false,
            createdAt: 1000,
            updatedAt: 1000,
        }
        useSessionStore.setState({
            sessions: [session],
            currentSessionId: sessionId,
        })

        useMessageStore.getState().appendEntry({
            id: 'u1',
            sessionId,
            createdAt: 1000,
            pausedMs: 30_000,
            kind: 'user',
            content: [{ type: 'text', text: 'Original task' }],
        })

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })

        await act(async () => {
            await result.current.retrySession(sessionId)
        })

        await waitFor(() => expect(result.current.isStreaming).toBe(false))

        const entries = useMessageStore.getState().getEntries(sessionId)
        const userEntry = entries.find((e) => e.id === 'u1')
        expect(userEntry).toBeDefined()
        expect(userEntry?.pausedMs).toBeUndefined()
    })

    it('resumes unfinished session with subagent tool call, preserving assistant entry and passing it to streamChat', async () => {
        const sessionId = useSessionStore.getState().createSession({ title: 'SubagentParent' })
        useSessionStore.getState().setCurrentSession(sessionId)

        useMessageStore.getState().appendEntry({
            id: 'u1',
            sessionId,
            createdAt: 100,
            kind: 'user',
            content: [{ type: 'text', text: 'Please review code with subagent' }],
        })

        useMessageStore.getState().appendEntry({
            id: 'a1',
            sessionId,
            createdAt: 101,
            kind: 'assistant',
            model: 'model-1',
            content: [
                {
                    type: 'toolCall',
                    id: 'spawn-call-1',
                    name: 'spawn_agent',
                    arguments: { name: 'Reviewer', prompt: 'Review this PR', model: 'model-1' },
                },
            ],
            stopReason: 'toolUse',
            status: 'done',
        })

        useSubAgentStore.getState().setAgentsForParent(sessionId, [
            {
                id: 'sub-rev-1',
                name: 'Reviewer',
                color: '#3dd68c',
                icon: 'atom',
                parentSessionId: sessionId,
                sessionId: 'sub-rev-1',
                modelId: 'model-1',
                parentToolCallId: 'spawn-call-1',
                status: 'running',
                createdAt: 101,
                updatedAt: 101,
            },
        ])

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })

        let resumedId: string | null = null
        await act(async () => {
            resumedId = await result.current.resumeSession(sessionId)
        })

        await waitFor(() => expect(result.current.isStreaming).toBe(false))
        expect(resumedId).toBe(sessionId)
        expect(service.streamCalls).toHaveLength(1)
        const call = service.streamCalls[0] as AgentStreamChatInput
        expect(call.sessionId).toBe(sessionId)
        // Entries must preserve both user message and assistant toolCall message so AgentLoop can fulfill it!
        expect(call.entries).toHaveLength(2)
        expect(call.entries[0].id).toBe('u1')
        expect(call.entries[1].id).toBe('a1')
    })

    it('rehydrates subagents loaded after host binding before replaying a pending spawn call', async () => {
        const sessionId = useSessionStore.getState().createSession({ title: 'RestoredParent' })
        useSessionStore.getState().setCurrentSession(sessionId)
        useMessageStore.getState().appendEntry({
            id: 'u-restored',
            sessionId,
            createdAt: 100,
            kind: 'user',
            content: [{ type: 'text', text: 'Dispatch a reviewer' }],
        })
        useMessageStore.getState().appendEntry({
            id: 'a-restored',
            sessionId,
            createdAt: 101,
            kind: 'assistant',
            content: [
                {
                    type: 'toolCall',
                    id: 'spawn-restored',
                    name: 'spawn_agent',
                    arguments: {
                        name: 'Reviewer',
                        prompt: 'Review the changes',
                        model: 'model-1',
                    },
                },
            ],
            stopReason: 'toolUse',
            status: 'done',
        })
        service.subAgents = new SubAgentHost({
            generateId: () => 'unexpected-new-agent',
            now: () => 1,
            run: async function* () {},
        })

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })
        expect(service.subAgents.list()).toEqual([])

        const restoredAgent: SubAgentRecord = {
            id: 'restored-agent',
            name: 'Reviewer',
            color: '#3dd68c',
            icon: 'atom',
            parentSessionId: sessionId,
            sessionId: 'restored-agent',
            modelId: 'model-1',
            parentToolCallId: 'spawn-restored',
            status: 'running',
            createdAt: 101,
            updatedAt: 101,
        }
        useSubAgentStore.getState().setAgentsForParent(sessionId, [restoredAgent])

        await act(async () => {
            await result.current.resumeSession(sessionId)
        })

        await waitFor(() => expect(result.current.isStreaming).toBe(false))
        expect(service.subAgents.list(sessionId)).toEqual([restoredAgent])
    })

    it('retries session from the point of failure preserving prior completed tool calls and tool results', async () => {
        const sessionId = useSessionStore.getState().createSession({ title: 'RetrySession' })
        useSessionStore.getState().setCurrentSession(sessionId)

        useMessageStore.getState().appendEntry({
            id: 'u1',
            sessionId,
            createdAt: 100,
            kind: 'user',
            content: [{ type: 'text', text: 'Read and edit file' }],
        })

        useMessageStore.getState().appendEntry({
            id: 'a1',
            sessionId,
            createdAt: 101,
            kind: 'assistant',
            content: [
                {
                    type: 'toolCall',
                    id: 'read-call-1',
                    name: 'read',
                    arguments: { path: 'a.ts' },
                },
            ],
            stopReason: 'toolUse',
            status: 'done',
        })

        useMessageStore.getState().appendEntry({
            id: 'tr1',
            sessionId,
            createdAt: 102,
            kind: 'toolResult',
            toolCallId: 'read-call-1',
            toolName: 'read',
            content: [{ type: 'text', text: 'const x = 1;' }],
            isError: false,
        })

        useMessageStore.getState().appendEntry({
            id: 'a2-err',
            sessionId,
            createdAt: 103,
            kind: 'assistant',
            content: [],
            stopReason: 'error',
            status: 'error',
            errorMessage: 'Network timeout',
        })

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })

        let retriedId: string | null = null
        await act(async () => {
            retriedId = await result.current.retrySession(sessionId, 'a2-err')
        })

        await waitFor(() => expect(result.current.isStreaming).toBe(false))
        expect(retriedId).toBe(sessionId)
        expect(service.streamCalls).toHaveLength(1)
        const call = service.streamCalls[0] as AgentStreamChatInput
        expect(call.sessionId).toBe(sessionId)
        // Entries must preserve u1, a1, and tr1, removing only the failed a2-err!
        expect(call.entries).toHaveLength(3)
        expect(call.entries.map((e) => e.id)).toEqual(['u1', 'a1', 'tr1'])
    })

    it('retries session when passed merged turn id a1 preserving subsequent completed tool calls in the same turn', async () => {
        const sessionId = useSessionStore.getState().createSession({ title: 'RetryTurnId' })
        useSessionStore.getState().setCurrentSession(sessionId)

        useMessageStore.getState().appendEntry({
            id: 'u1',
            sessionId,
            createdAt: 100,
            kind: 'user',
            content: [{ type: 'text', text: 'Multi-step tool task' }],
        })

        useMessageStore.getState().appendEntry({
            id: 'a1',
            sessionId,
            createdAt: 101,
            kind: 'assistant',
            content: [
                {
                    type: 'toolCall',
                    id: 'tool-call-1',
                    name: 'read',
                    arguments: { path: 'file1.ts' },
                },
            ],
            stopReason: 'toolUse',
            status: 'done',
        })

        useMessageStore.getState().appendEntry({
            id: 'tr1',
            sessionId,
            createdAt: 102,
            kind: 'toolResult',
            toolCallId: 'tool-call-1',
            toolName: 'read',
            content: [{ type: 'text', text: 'content 1' }],
            isError: false,
        })

        useMessageStore.getState().appendEntry({
            id: 'a2-err',
            sessionId,
            createdAt: 103,
            kind: 'assistant',
            content: [],
            stopReason: 'error',
            status: 'error',
            errorMessage: 'Connection reset by peer',
        })

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })

        let retriedId: string | null = null
        await act(async () => {
            // Passing a1 (the first assistant in the turn) must still preserve tr1 and only drop a2-err!
            retriedId = await result.current.retrySession(sessionId, 'a1')
        })

        await waitFor(() => expect(result.current.isStreaming).toBe(false))
        expect(retriedId).toBe(sessionId)
        expect(service.streamCalls).toHaveLength(1)
        const call = service.streamCalls[0] as AgentStreamChatInput
        expect(call.sessionId).toBe(sessionId)
        expect(call.entries).toHaveLength(3)
        expect(call.entries.map((e) => e.id)).toEqual(['u1', 'a1', 'tr1'])
    })

    it('allows multiple sessions to execute concurrently and have independent streaming status', async () => {
        let release1!: () => void
        const hold1 = new Promise<void>((resolve) => {
            release1 = resolve
        })
        let release2!: () => void
        const hold2 = new Promise<void>((resolve) => {
            release2 = resolve
        })

        const s1 = useSessionStore.getState().createSession({ title: 'Session 1' })
        const s2 = useSessionStore.getState().createSession({ title: 'Session 2' })

        service.streamImpl = async function* (input: AgentStreamChatInput) {
            yield {
                type: 'agent-start',
                runId: input.runId,
                sessionId: input.sessionId,
            }
            if (input.sessionId === s1) {
                await hold1
            } else if (input.sessionId === s2) {
                await hold2
            }
            yield {
                type: 'agent-end',
                runId: input.runId,
                sessionId: input.sessionId,
            }
        }

        const hook1 = renderHook(() => useAgentStream(s1), {
            wrapper: wrapperFor(service),
        })
        const hook2 = renderHook(() => useAgentStream(s2), {
            wrapper: wrapperFor(service),
        })
        const hookHome = renderHook(() => useAgentStream(null), {
            wrapper: wrapperFor(service),
        })

        // Initial state
        expect(hook1.result.current.isStreaming).toBe(false)
        expect(hook2.result.current.isStreaming).toBe(false)
        expect(hookHome.result.current.isStreaming).toBe(false)

        // Send on session 1
        act(() => {
            void hook1.result.current.send({ text: 'prompt for session 1', sessionId: s1 })
        })

        await waitFor(() => expect(hook1.result.current.isStreaming).toBe(true))
        // Session 2 and Home must remain NOT streaming
        expect(hook2.result.current.isStreaming).toBe(false)
        expect(hookHome.result.current.isStreaming).toBe(false)

        // Send on session 2 concurrently
        act(() => {
            void hook2.result.current.send({ text: 'prompt for session 2', sessionId: s2 })
        })

        await waitFor(() => expect(hook2.result.current.isStreaming).toBe(true))
        expect(hook1.result.current.isStreaming).toBe(true)
        expect(hookHome.result.current.isStreaming).toBe(false)

        // Stop session 1 only
        act(() => {
            hook1.result.current.stop(s1)
        })

        await waitFor(() => expect(hook1.result.current.isStreaming).toBe(false))
        // Session 2 must still be streaming
        expect(hook2.result.current.isStreaming).toBe(true)

        // Release session 2
        release2()
        await waitFor(() => expect(hook2.result.current.isStreaming).toBe(false))

        release1()
    })

    it('refreshes userEntry createdAt to now when retrying via userEntryId', async () => {
        const sessionId = useSessionStore.getState().createSession({ title: 'Worktree retry test' })
        useSessionStore.getState().setCurrentSession(sessionId)
        const oldTimestamp = 1000000
        useMessageStore.getState().appendEntry({
            id: 'u-initial',
            sessionId,
            createdAt: oldTimestamp,
            kind: 'user',
            content: [{ type: 'text', text: 'initial prompt before worktree setup' }],
        })

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })

        const beforeTime = Date.now()
        await act(async () => {
            await result.current.send({
                text: 'initial prompt before worktree setup',
                sessionId,
                userEntryId: 'u-initial',
            })
        })

        await waitFor(() => expect(result.current.isStreaming).toBe(false))
        const entries = useMessageStore.getState().getEntries(sessionId)
        const userEntry = entries.find((e) => e.id === 'u-initial')
        expect(userEntry).toBeDefined()
        expect(userEntry?.createdAt).toBeGreaterThanOrEqual(beforeTime)
        expect(userEntry?.createdAt).not.toBe(oldTimestamp)
    })

    it('preserves an explicit user entry start time across worktree retry setup', async () => {
        const sessionId = useSessionStore.getState().createSession({ title: 'Timed worktree retry' })
        useSessionStore.getState().setCurrentSession(sessionId)
        const oldTimestamp = 1000000
        const retryStartedAt = 2000000
        useMessageStore.getState().appendEntry({
            id: 'u-timed-retry',
            sessionId,
            createdAt: oldTimestamp,
            kind: 'user',
            content: [{ type: 'text', text: 'retry after environment setup' }],
        })

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })

        await act(async () => {
            await result.current.send({
                text: 'retry after environment setup',
                sessionId,
                userEntryId: 'u-timed-retry',
                userEntryCreatedAt: retryStartedAt,
            })
        })

        await waitFor(() => expect(result.current.isStreaming).toBe(false))
        const entries = useMessageStore.getState().getEntries(sessionId)
        const userEntry = entries.find((entry) => entry.id === 'u-timed-retry')
        expect(userEntry?.createdAt).toBe(retryStartedAt)
    })

    it('refreshes last user entry createdAt to now when retrying via retrySession', async () => {
        const sessionId = useSessionStore.getState().createSession({ title: 'Session retry test' })
        useSessionStore.getState().setCurrentSession(sessionId)
        const oldTimestamp = 2000000
        useMessageStore.getState().appendEntry({
            id: 'u-retry',
            sessionId,
            createdAt: oldTimestamp,
            kind: 'user',
            content: [{ type: 'text', text: 'prompt to retry' }],
        })
        useMessageStore.getState().appendEntry({
            id: 'a-err',
            sessionId,
            createdAt: oldTimestamp + 100,
            kind: 'assistant',
            content: [],
            stopReason: 'error',
            status: 'error',
            errorMessage: 'Network error',
        })

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })

        const beforeTime = Date.now()
        await act(async () => {
            await result.current.retrySession(sessionId, 'a-err')
        })

        await waitFor(() => expect(result.current.isStreaming).toBe(false))
        const entries = useMessageStore.getState().getEntries(sessionId)
        const userEntry = entries.find((e) => e.id === 'u-retry')
        expect(userEntry).toBeDefined()
        expect(userEntry?.createdAt).toBeGreaterThanOrEqual(beforeTime)
        expect(userEntry?.createdAt).not.toBe(oldTimestamp)
    })

    it('waits for persisted worktree state before the actual prepare and stream', async () => {
        seedReadyWorktreeSession({
            sourceTreePath: '/projects/repo',
            includeProject: true,
        })
        let releaseFlush: (() => void) | undefined
        persistTestState.flushPendingPersistence.mockImplementationOnce(
            () => new Promise<void>((resolve) => {
                releaseFlush = resolve
            }),
        )
        const { result } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })

        const sendPromise = act(async () => {
            await result.current.send({ text: 'continue' })
        })
        await waitFor(() => expect(service.prepareCalls).toBe(1))
        expect(service.streamCalls).toHaveLength(0)

        releaseFlush?.()
        await sendPromise

        expect(service.prepareInputs).toHaveLength(2)
        expect(service.prepareInputs[1]).toMatchObject({
            projectPath: '/worktrees/repo-session',
            projectPaths: ['/worktrees/repo-session'],
            worktreePolicy: {
                worktreePath: '/worktrees/repo-session',
                sourceTreePath: '/projects/repo',
            },
        })
        expect((service.streamCalls[0] as AgentStreamChatInput).prepared).toMatchObject({
            worktreePolicy: {
                worktreePath: '/worktrees/repo-session',
                sourceTreePath: '/projects/repo',
            },
        })
    })

    it('backfills a missing persisted sourceTreePath before worktree prepare', async () => {
        const sessionId = seedReadyWorktreeSession({
            sourceTreePath: undefined,
            includeProject: true,
        })
        const { result } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })

        await act(async () => {
            await result.current.send({ text: 'continue legacy worktree' })
        })

        expect(
            useWorktreeSetupStore.getState().getSetup(sessionId)?.sourceTreePath,
        ).toBe('/projects/repo')
        expect(service.prepareInputs[1]?.worktreePolicy).toEqual({
            worktreePath: '/worktrees/repo-session',
            sourceTreePath: '/projects/repo',
        })
        expect(persistTestState.flushPendingPersistence).toHaveBeenCalledTimes(1)
    })

    it('never streams with the original prepare when worktree policy recovery fails', async () => {
        seedReadyWorktreeSession({
            sourceTreePath: undefined,
            includeProject: false,
        })
        const { result } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })

        await expect(act(async () => {
            await result.current.send({ text: 'must not run locally' })
        })).rejects.toMatchObject({ code: 'invalid_worktree_policy' })

        expect(service.prepareCalls).toBe(1)
        expect(service.streamCalls).toHaveLength(0)
        expect(persistTestState.flushPendingPersistence).not.toHaveBeenCalled()
    })

    it('does not run when the worktree persistence checkpoint fails', async () => {
        seedReadyWorktreeSession({
            sourceTreePath: '/projects/repo',
            includeProject: true,
        })
        persistTestState.flushPendingPersistence.mockRejectedValueOnce(
            new Error('disk full'),
        )
        const { result } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })

        await expect(act(async () => {
            await result.current.send({ text: 'must wait for persistence' })
        })).rejects.toMatchObject({ code: 'worktree_persistence_failed' })

        expect(service.prepareCalls).toBe(1)
        expect(service.streamCalls).toHaveLength(0)
    })

    it('preserves AbortError when aborted during worktree persistence flush', async () => {
        seedReadyWorktreeSession({
            sourceTreePath: '/projects/repo',
            includeProject: true,
        })
        const abortErr = new Error('The operation was aborted')
        abortErr.name = 'AbortError'
        persistTestState.flushPendingPersistence.mockRejectedValueOnce(abortErr)

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })

        await expect(act(async () => {
            await result.current.send({ text: 'abort flush test' })
        })).rejects.toSatisfy((err: unknown) => {
            const error = err as Error
            return error.name === 'AbortError' || /abort/i.test(error.message)
        })

        expect(service.prepareCalls).toBe(1)
        expect(service.streamCalls).toHaveLength(0)
    })

    it('aborts worktree execution when stop is called during persistence flush or second prepare', async () => {
        const sessionId = seedReadyWorktreeSession({
            sourceTreePath: '/projects/repo',
            includeProject: true,
        })
        let releaseFlush!: () => void
        persistTestState.flushPendingPersistence.mockImplementationOnce(
            () => new Promise<void>((resolve) => {
                releaseFlush = resolve
            }),
        )

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })

        const sendPromise = act(async () => {
            await result.current.send({ text: 'stop during flush', sessionId })
        })

        await waitFor(() => expect(service.prepareCalls).toBe(1))

        act(() => {
            result.current.stop(sessionId)
        })

        releaseFlush()

        await expect(sendPromise).rejects.toSatisfy((err: unknown) => {
            const error = err as Error
            return error.name === 'AbortError' || /abort/i.test(error.message)
        })

        expect(service.prepareCalls).toBe(1)
        expect(service.streamCalls).toHaveLength(0)
    })

    it('retrying a worktree session prepares with worktreePolicy and flushes persistence', async () => {
        const sessionId = seedReadyWorktreeSession({
            sourceTreePath: '/projects/repo',
            includeProject: true,
        })
        useMessageStore.getState().appendEntry({
            id: 'u1',
            sessionId,
            createdAt: 100,
            kind: 'user',
            content: [{ type: 'text', text: 'retry me' }],
        })
        useMessageStore.getState().appendEntry({
            id: 'a1',
            sessionId,
            createdAt: 101,
            kind: 'assistant',
            content: [],
            stopReason: 'error',
            status: 'error',
            errorMessage: 'Network timeout',
        })

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })

        await act(async () => {
            await result.current.retrySession(sessionId, 'a1')
        })

        expect(persistTestState.flushPendingPersistence).toHaveBeenCalledTimes(1)
        expect(service.prepareInputs).toHaveLength(1)
        expect(service.prepareInputs[0]).toMatchObject({
            projectPath: '/worktrees/repo-session',
            projectPaths: ['/worktrees/repo-session'],
            worktreePolicy: {
                worktreePath: '/worktrees/repo-session',
                sourceTreePath: '/projects/repo',
            },
        })
        expect((service.streamCalls[0] as AgentStreamChatInput).prepared).toMatchObject({
            worktreePolicy: {
                worktreePath: '/worktrees/repo-session',
                sourceTreePath: '/projects/repo',
            },
        })
    })

    it('retrying a worktree session fails closed when worktree metadata is missing', async () => {
        const sessionId = seedReadyWorktreeSession({
            sourceTreePath: undefined,
            includeProject: false,
        })
        useMessageStore.getState().appendEntry({
            id: 'u1',
            sessionId,
            createdAt: 100,
            kind: 'user',
            content: [{ type: 'text', text: 'retry me invalid' }],
        })
        useMessageStore.getState().appendEntry({
            id: 'a1',
            sessionId,
            createdAt: 101,
            kind: 'assistant',
            content: [],
            stopReason: 'error',
            status: 'error',
            errorMessage: 'Fail',
        })

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })

        await expect(act(async () => {
            await result.current.retrySession(sessionId, 'a1')
        })).rejects.toMatchObject({ code: 'invalid_worktree_policy' })

        expect(service.prepareCalls).toBe(0)
        expect(service.streamCalls).toHaveLength(0)
    })

    it('resuming an unfinished worktree session prepares with worktreePolicy and flushes persistence', async () => {
        const sessionId = seedReadyWorktreeSession({
            sourceTreePath: '/projects/repo',
            includeProject: true,
        })
        useMessageStore.getState().appendEntry({
            id: 'u1',
            sessionId,
            createdAt: 100,
            kind: 'user',
            content: [{ type: 'text', text: 'unfinished task' }],
        })
        useMessageStore.getState().appendEntry({
            id: 'a1',
            sessionId,
            createdAt: 101,
            kind: 'assistant',
            content: [
                {
                    type: 'toolCall',
                    id: 'tc1',
                    name: 'read',
                    arguments: { path: 'file.ts' },
                },
            ],
            stopReason: 'toolUse',
            status: 'done',
        })

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })

        await act(async () => {
            await result.current.resumeSession(sessionId)
        })

        expect(persistTestState.flushPendingPersistence).toHaveBeenCalledTimes(1)
        expect(service.prepareInputs).toHaveLength(1)
        expect(service.prepareInputs[0]).toMatchObject({
            projectPath: '/worktrees/repo-session',
            projectPaths: ['/worktrees/repo-session'],
            worktreePolicy: {
                worktreePath: '/worktrees/repo-session',
                sourceTreePath: '/projects/repo',
            },
        })
        expect((service.streamCalls[0] as AgentStreamChatInput).prepared).toMatchObject({
            worktreePolicy: {
                worktreePath: '/worktrees/repo-session',
                sourceTreePath: '/projects/repo',
            },
        })
    })

    it('compacting a worktree session prepares with worktreePolicy and flushes persistence', async () => {
        const sessionId = seedReadyWorktreeSession({
            sourceTreePath: '/projects/repo',
            includeProject: true,
        })
        useMessageStore.getState().appendEntry({
            id: 'u1',
            sessionId,
            createdAt: 100,
            kind: 'user',
            content: [{ type: 'text', text: 'message to compact' }],
        })

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })

        await act(async () => {
            await result.current.compact('Summary focus', sessionId)
        })

        expect(persistTestState.flushPendingPersistence).toHaveBeenCalledTimes(1)
        expect(service.prepareInputs).toHaveLength(1)
        expect(service.prepareInputs[0]).toMatchObject({
            projectPath: '/worktrees/repo-session',
            projectPaths: ['/worktrees/repo-session'],
            worktreePolicy: {
                worktreePath: '/worktrees/repo-session',
                sourceTreePath: '/projects/repo',
            },
        })
    })

    it('compacting an invalid worktree session fails closed', async () => {
        const sessionId = seedReadyWorktreeSession({
            sourceTreePath: undefined,
            includeProject: false,
        })
        useMessageStore.getState().appendEntry({
            id: 'u1',
            sessionId,
            createdAt: 100,
            kind: 'user',
            content: [{ type: 'text', text: 'message to compact' }],
        })

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })

        await expect(act(async () => {
            await result.current.compact('Summary focus', sessionId)
        })).rejects.toMatchObject({ code: 'invalid_worktree_policy' })

        expect(service.prepareCalls).toBe(0)
    })

    it('retrying a local session with stale worktree metadata uses local project paths and omits worktreePolicy', async () => {
        const sessionId = seedLocalSessionWithStaleWorktreeMetadata()
        useMessageStore.getState().appendEntry({
            id: 'u1',
            sessionId,
            createdAt: 100,
            kind: 'user',
            content: [{ type: 'text', text: 'retry local' }],
        })
        useMessageStore.getState().appendEntry({
            id: 'a1',
            sessionId,
            createdAt: 101,
            kind: 'assistant',
            content: [],
            stopReason: 'error',
            status: 'error',
            errorMessage: 'Timeout',
        })

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })

        await act(async () => {
            await result.current.retrySession(sessionId, 'a1')
        })

        expect(service.prepareInputs).toHaveLength(1)
        expect(service.prepareInputs[0]).toMatchObject({
            projectPath: '/projects/repo',
            projectPaths: ['/projects/repo'],
        })
        expect(service.prepareInputs[0]?.worktreePolicy).toBeUndefined()
    })

    it('resuming an unfinished local session with stale worktree metadata uses local project paths and omits worktreePolicy', async () => {
        const sessionId = seedLocalSessionWithStaleWorktreeMetadata()
        useMessageStore.getState().appendEntry({
            id: 'u1',
            sessionId,
            createdAt: 100,
            kind: 'user',
            content: [{ type: 'text', text: 'unfinished local' }],
        })
        useMessageStore.getState().appendEntry({
            id: 'a1',
            sessionId,
            createdAt: 101,
            kind: 'assistant',
            content: [
                {
                    type: 'toolCall',
                    id: 'tc1',
                    name: 'read',
                    arguments: { path: 'file.ts' },
                },
            ],
            stopReason: 'toolUse',
            status: 'done',
        })

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })

        await act(async () => {
            await result.current.resumeSession(sessionId)
        })

        expect(service.prepareInputs).toHaveLength(1)
        expect(service.prepareInputs[0]).toMatchObject({
            projectPath: '/projects/repo',
            projectPaths: ['/projects/repo'],
        })
        expect(service.prepareInputs[0]?.worktreePolicy).toBeUndefined()
    })

    it('compacting a local session with stale worktree metadata uses local project paths and omits worktreePolicy', async () => {
        const sessionId = seedLocalSessionWithStaleWorktreeMetadata()
        useMessageStore.getState().appendEntry({
            id: 'u1',
            sessionId,
            createdAt: 100,
            kind: 'user',
            content: [{ type: 'text', text: 'compact local' }],
        })

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })

        await act(async () => {
            await result.current.compact('Local summary focus', sessionId)
        })

        expect(service.prepareInputs).toHaveLength(1)
        expect(service.prepareInputs[0]).toMatchObject({
            projectPath: '/projects/repo',
            projectPaths: ['/projects/repo'],
        })
        expect(service.prepareInputs[0]?.worktreePolicy).toBeUndefined()
    })

    it('publishes runtime skills, prompts, and diagnostics only from the final worktree prepared run', async () => {
        seedReadyWorktreeSession({
            sourceTreePath: '/projects/repo',
            includeProject: true,
        })
        service.prepareImpl = async (input) => {
            if (input.worktreePolicy) {
                return makePrepared({
                    projectCwd: input.projectPath ?? undefined,
                    projectPaths: input.projectPaths?.slice() ?? [],
                    worktreePolicy: input.worktreePolicy,
                    skills: [{
                        name: 'worktree-skill',
                        description: 'from worktree',
                        filePath: '/worktrees/repo-session/.cpa/skills/worktree-skill/SKILL.md',
                        baseDir: '/worktrees/repo-session/.cpa/skills/worktree-skill',
                        disableModelInvocation: false,
                        body: '',
                    }],
                    prompts: [{
                        name: 'worktree-prompt',
                        description: 'worktree prompt',
                        content: 'hello',
                        filePath: '/worktrees/repo-session/.cpa/prompts/worktree-prompt.md',
                    }],
                    diagnostics: [{ type: 'warning', message: 'worktree diagnostic warning' }],
                })
            }
            return makePrepared({
                projectCwd: input.projectPath ?? undefined,
                projectPaths: input.projectPaths?.slice() ?? [],
                skills: [{
                    name: 'local-skill',
                    description: 'from local',
                    filePath: '/projects/repo/.cpa/skills/local-skill/SKILL.md',
                    baseDir: '/projects/repo/.cpa/skills/local-skill',
                    disableModelInvocation: false,
                    body: '',
                }],
                prompts: [{
                    name: 'local-prompt',
                    description: 'local prompt',
                    content: 'hello local',
                    filePath: '/projects/repo/.cpa/prompts/local-prompt.md',
                }],
                diagnostics: [{ type: 'warning', message: 'local diagnostic warning' }],
            })
        }

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })

        await act(async () => {
            await result.current.send({ text: 'check diagnostics' })
        })

        expect(result.current.skills).toEqual([
            expect.objectContaining({ name: 'worktree-skill' }),
        ])
        expect(result.current.prompts).toEqual([
            expect.objectContaining({ name: 'worktree-prompt' }),
        ])
        expect(result.current.lastDiagnostics).toEqual(['worktree diagnostic warning'])
    })

    it('bridges host chatMessages.send to useAgentStream when mounted', async () => {
        const { unmount } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })

        const hostServices = getHostServices()
        expect(hostServices.chatMessages).toBeDefined()
        expect(hostServices.chatMessages!.send).toBeDefined()

        let acceptedSessionId: string | null = null
        let sendResult: string | null | undefined = null
        await act(async () => {
            sendResult = await hostServices.chatMessages!.send?.({
                text: 'host sent text',
                sessionId: '',
                onSessionAccepted: (sId) => {
                    acceptedSessionId = sId
                },
            })
        })

        expect(sendResult).toBeTruthy()
        expect(acceptedSessionId).toBe(sendResult)

        unmount()
    })

    it('accepts new assistant messages when editing and resending after stopping a session', async () => {
        let release1: () => void = () => {}
        const hold1 = new Promise<void>((resolve) => {
            release1 = resolve
        })

        let streamCallCount = 0
        service.streamImpl = async function* (input: AgentStreamChatInput): AsyncGenerator<AgentRunEvent> {
            streamCallCount += 1
            const isFirst = streamCallCount === 1
            yield {
                type: 'agent-start',
                runId: input.runId,
                sessionId: input.sessionId,
            }
            if (isFirst) {
                yield {
                    type: 'assistant-start',
                    runId: input.runId,
                    sessionId: input.sessionId,
                    entry: {
                        id: 'a1',
                        sessionId: input.sessionId,
                        kind: 'assistant',
                        version: 1,
                        createdAt: Date.now(),
                        status: 'streaming',
                        stopReason: 'pending',
                        content: [{ type: 'text', text: 'first partial' }],
                    },
                }
                await hold1
            } else {
                yield {
                    type: 'assistant-start',
                    runId: input.runId,
                    sessionId: input.sessionId,
                    entry: {
                        id: 'a2',
                        sessionId: input.sessionId,
                        kind: 'assistant',
                        version: 1,
                        createdAt: Date.now(),
                        status: 'streaming',
                        stopReason: 'pending',
                        content: [{ type: 'text', text: 'second complete' }],
                    },
                }
                yield {
                    type: 'assistant-end',
                    runId: input.runId,
                    sessionId: input.sessionId,
                    entry: {
                        id: 'a2',
                        sessionId: input.sessionId,
                        kind: 'assistant',
                        version: 1,
                        createdAt: Date.now(),
                        status: 'done',
                        stopReason: 'stop',
                        completedAt: Date.now(),
                        content: [{ type: 'text', text: 'second complete' }],
                    },
                }
                yield {
                    type: 'agent-end',
                    runId: input.runId,
                    sessionId: input.sessionId,
                }
            }
        }

        const sessionId = useSessionStore.getState().createSession({ title: 'Stop and edit test' })
        useSessionStore.getState().setCurrentSession(sessionId)

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })

        // 1. Send first prompt
        await act(async () => {
            void result.current.send({
                text: 'first prompt',
                sessionId,
            })
        })

        await waitFor(() => {
            const entries = useMessageStore.getState().getEntries(sessionId)
            expect(entries.some((e) => e.kind === 'assistant' && e.id === 'a1')).toBe(true)
        })

        // 2. Stop mid-flight
        act(() => {
            result.current.stop(sessionId)
        })

        release1()

        await waitFor(() => {
            expect(result.current.isStreaming).toBe(false)
        })

        const entriesAfterStop = useMessageStore.getState().getEntries(sessionId)
        const userEntry = entriesAfterStop.find((e) => e.kind === 'user')
        expect(userEntry).toBeDefined()

        // 3. Edit message and send again
        await act(async () => {
            await result.current.send({
                text: 'edited prompt',
                sessionId,
                editMessageId: userEntry!.id,
            })
        })

        await waitFor(() => {
            expect(result.current.isStreaming).toBe(false)
        })

        // 4. Verify that the second run's assistant message was accepted into messageStore!
        const finalEntries = useMessageStore.getState().getEntries(sessionId)
        const finalUser = finalEntries.find((e): e is import('@cpa/plugin-api').UserEntry => e.kind === 'user')
        expect(finalUser?.content).toEqual([{ type: 'text', text: 'edited prompt' }])

        const finalAssistant = finalEntries.find((e): e is import('@cpa/plugin-api').AssistantEntry => e.kind === 'assistant' && e.id === 'a2')
        expect(finalAssistant).toBeDefined()
        expect(finalAssistant?.content).toEqual([{ type: 'text', text: 'second complete' }])
    })

    it('provides dynamic getRuntimeSettings that reflects setSessionRuntimeSettings during run', async () => {
        let capturedInput: AgentStreamChatInput | undefined
        const service = new FakeService()
        service.streamImpl = async function* (input) {
            capturedInput = input
            yield { type: 'agent-start', runId: input.runId, sessionId: input.sessionId }
            yield {
                type: 'assistant-end',
                runId: input.runId,
                sessionId: input.sessionId,
                entry: {
                    id: 'a1',
                    sessionId: input.sessionId,
                    createdAt: 1,
                    kind: 'assistant',
                    content: [{ type: 'text', text: 'hi' }],
                    status: 'done',
                    stopReason: 'stop',
                    model: model.id,
                },
            }
            yield { type: 'agent-end', runId: input.runId, sessionId: input.sessionId }
        }

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })
        const sessionId = 'session-dynamic-reasoning'
        useSessionStore.getState().createSession({
            id: sessionId,
            title: 'Dynamic Reasoning Test',
            reasoningEffort: 'low',
        })

        await act(async () => {
            await result.current.send({
                text: 'hello',
                sessionId,
            })
        })

        expect(capturedInput).toBeDefined()
        expect(capturedInput?.getRuntimeSettings).toBeDefined()
        // Initial resolver returns current session reasoningEffort
        expect(capturedInput?.getRuntimeSettings?.()?.reasoningEffort).toBe('low')

        // Simulate user changing reasoning effort via ModelSelect (setSessionRuntimeSettings)
        act(() => {
            useSessionStore.getState().setSessionRuntimeSettings(sessionId, {
                reasoningEffort: 'high',
            })
        })

        // Verify resolver immediately returns updated reasoning effort
        expect(capturedInput?.getRuntimeSettings?.()?.reasoningEffort).toBe('high')
    })

    it('stamps completedAt on active assistant entry when stopped so duration is preserved', async () => {
        let releaseStream: (() => void) | undefined
        const gate = new Promise<void>((resolve) => {
            releaseStream = resolve
        })
        const service = new FakeService()
        service.streamImpl = async function* (input) {
            yield { type: 'agent-start', runId: input.runId, sessionId: input.sessionId }
            yield {
                type: 'assistant-start',
                runId: input.runId,
                sessionId: input.sessionId,
                entry: {
                    id: 'a1',
                    sessionId: input.sessionId,
                    kind: 'assistant',
                    version: 1,
                    createdAt: 1000,
                    status: 'streaming',
                    stopReason: 'pending',
                    content: [],
                },
            }
            yield {
                type: 'assistant-end',
                runId: input.runId,
                sessionId: input.sessionId,
                entry: {
                    id: 'a1',
                    sessionId: input.sessionId,
                    createdAt: 1000,
                    kind: 'assistant',
                    content: [
                        {
                            type: 'toolCall',
                            id: 'tc1',
                            name: 'spawn_agent',
                            arguments: { name: 'Worker', prompt: 'Work' },
                        },
                    ],
                    stopReason: 'toolUse',
                    status: 'done',
                    completedAt: 1000,
                },
            }
            await gate
        }

        const sessionId = useSessionStore.getState().createSession({
            title: 'Stop ToolUse Duration Test',
        })
        useSessionStore.getState().setCurrentSession(sessionId)

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: wrapperFor(service),
        })

        await act(async () => {
            void result.current.send({
                text: 'Run subagent task',
                sessionId,
            })
        })

        await waitFor(() => {
            const entries = useMessageStore.getState().getEntries(sessionId)
            const a = entries.find((e) => e.id === 'a1') as any
            expect(a?.stopReason).toBe('toolUse')
        })

        const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(300_000)
        try {
            act(() => {
                result.current.stop(sessionId)
            })
            releaseStream?.()

            await waitFor(() => {
                expect(result.current.isStreaming).toBe(false)
            })

            const entries = useMessageStore.getState().getEntries(sessionId)
            const assistantEntry = entries.find((e) => e.id === 'a1') as any
            expect(assistantEntry).toBeDefined()
            expect(assistantEntry?.completedAt).toBe(300_000)
            expect(assistantEntry?.interrupted).toBe(true)
        } finally {
            dateNowSpy.mockRestore()
        }
    })
})
