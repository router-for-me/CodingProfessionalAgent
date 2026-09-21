import { act, renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UserEntry } from '@cpa/plugin-api'
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
import {
    AgentServiceProvider,
    __resetAgentStreamForTests,
    __resetDelegateRunsForTests,
    bumpSessionActionEpoch,
    dequeueQueuedMessage,
    disposeAgentRuntime,
    getRuntime,
    useAgentStream,
} from './useAgentStream'
import { useMessageStore } from '@/stores/messageStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useModelCatalogStore } from '@/stores/modelCatalogStore'
import { useProjectStore } from '@/stores/projectStore'
import { useUiStore } from '@/stores/uiStore'
import { useSessionRunStore } from '@/stores/sessionRunStore'
import { useSubAgentStore } from '@/stores/subAgentStore'
import {
    __resetToolOverlayStoreForTests,
    useToolOverlayStore,
} from '@/stores/toolOverlayStore'
import { __resetPersistenceForTests, bindPersistence } from '@/application/services/persistenceService'
import { setHostBridge } from '@/application/services/hostTransport'

const model: ModelCatalogEntry = {
    id: 'test-model',
    label: 'Test',
    supportsFast: true,
    reasoningLevels: [{ id: 'medium', requestValue: 'medium' }],
    input: ['text', 'image'],
    contextWindow: 128_000,
    maxTokens: 4_096,
}

function makePrepared(partial?: Partial<PreparedAgentRun>): PreparedAgentRun {
    return {
        baseUrl: 'http://127.0.0.1:8317',
        apiKey: 'key',
        model,
        reasoningEffort: 'medium',
        speed: 'standard',
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

class FakeSyncService implements AgentService {
    prepareImpl: (input: AgentPrepareInput) => Promise<PreparedAgentRun> =
        async () => makePrepared()
    streamEvents: AgentRunEvent[] = []
    streamHold: Promise<void> | null = null
    streamChatCalls: AgentStreamChatInput[] = []
    abortCalls: (string | undefined)[] = []
    disposed = false

    async prepare(input: AgentPrepareInput): Promise<PreparedAgentRun> {
        return this.prepareImpl(input)
    }

    async *streamChat(
        input: AgentStreamChatInput,
    ): AsyncGenerator<AgentRunEvent> {
        this.streamChatCalls.push(input)
        yield {
            type: 'agent-start',
            runId: input.runId,
            sessionId: input.sessionId,
        }
        if (input.signal?.aborted) {
            yield {
                type: 'aborted',
                runId: input.runId,
                sessionId: input.sessionId,
            }
            return
        }
        if (this.streamHold) {
            const holdPromise = this.streamHold
            const signal = input.signal
            if (signal) {
                if (signal.aborted) {
                    yield {
                        type: 'aborted',
                        runId: input.runId,
                        sessionId: input.sessionId,
                    }
                    return
                }
                const abortedPromise = new Promise<'aborted'>((resolve) => {
                    signal.addEventListener('abort', () => resolve('aborted'), {
                        once: true,
                    })
                })
                const result = await Promise.race([holdPromise, abortedPromise])
                if (result === 'aborted' || signal.aborted) {
                    yield {
                        type: 'aborted',
                        runId: input.runId,
                        sessionId: input.sessionId,
                    }
                    return
                }
            } else {
                await holdPromise
            }
        }
        if (input.signal?.aborted) {
            yield {
                type: 'aborted',
                runId: input.runId,
                sessionId: input.sessionId,
            }
            return
        }
        for (const event of this.streamEvents) {
            if (input.signal?.aborted) {
                yield {
                    type: 'aborted',
                    runId: input.runId,
                    sessionId: input.sessionId,
                }
                return
            }
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

    approve(): boolean {
        return true
    }

    reject(): boolean {
        return true
    }

    async compact(input: AgentCompactInput): Promise<AgentCompactResult> {
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
                    type: 'compaction-end',
                    runId: input.runId,
                    sessionId: input.sessionId,
                    entry,
                } as any,
            ],
        }
    }

    dispose(): void {
        this.disposed = true
    }
}

function resetStores(): void {
    useUiStore.setState({ toasts: [], composerDraft: '' })
    useMessageStore.getState().hydrate({})
    useSessionStore.setState({
        sessions: [],
        currentSessionId: null,
    })
    useSessionRunStore.setState({ activeRuns: {} })
    useProjectStore.setState({ projects: [] })
    useSettingsStore.getState().hydrate({
        modelId: model.id,
        reasoningLevel: 'medium',
        speed: 'standard',
        fastContextCompaction: true,
        cliProxyApi: { baseUrl: 'http://127.0.0.1:8317', apiKey: 'test-key' },
        locale: 'en',
    })
    useModelCatalogStore.setState({
        models: [model],
        status: 'ready',
        error: null,
    })
}

const originalUserAgent = navigator.userAgent

describe('useAgentStreamSync', () => {
    let service: FakeSyncService
    let nativeEventListeners: Array<(event: any) => void>
    let broadcastRunStatusMock: any
    let broadcastStreamEventMock: any
    let abortRunMock: any
    let delegateRunMock: any

    beforeEach(() => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Electron/34.2.0 Safari/537.36',
            configurable: true,
        })
        service = new FakeSyncService()
        __resetAgentStreamForTests(service)
        __resetPersistenceForTests()
        __resetToolOverlayStoreForTests()
        resetStores()

        nativeEventListeners = []
        broadcastRunStatusMock = vi.fn().mockResolvedValue(undefined)
        broadcastStreamEventMock = vi.fn().mockResolvedValue(undefined)
        abortRunMock = vi.fn().mockResolvedValue(undefined)
        delegateRunMock = vi.fn().mockResolvedValue('ok')

        setHostBridge({
            SessionBroadcastRunStatus: broadcastRunStatusMock,
            SessionBroadcastStreamEvent: broadcastStreamEventMock,
            SessionAbortRun: abortRunMock,
            SessionDelegateRun: delegateRunMock,
            SessionClaimPendingDelegateRuns: vi.fn().mockResolvedValue([]),
            SessionAckDelegateRun: vi.fn().mockResolvedValue(undefined),
            onNativeEvent: vi.fn((cb: (event: any) => void) => {
                nativeEventListeners.push(cb)
                return () => {
                    const idx = nativeEventListeners.indexOf(cb)
                    if (idx >= 0) nativeEventListeners.splice(idx, 1)
                }
            }),
        } as any)
    })

    afterEach(async () => {
        setHostBridge(null)
        Object.defineProperty(navigator, 'userAgent', {
            value: originalUserAgent,
            configurable: true,
        })
        await disposeAgentRuntime(service)
        __resetAgentStreamForTests(service)
        __resetDelegateRunsForTests()
        __resetPersistenceForTests()
        vi.useRealTimers()
    })

    function createWrapper(svc: AgentService) {
        return function Wrapper({ children }: { children?: ReactNode }) {
            return createElement(
                AgentServiceProvider,
                { service: svc },
                children,
            )
        }
    }

    it('Host mode broadcasts SessionBroadcastRunStatus and SessionBroadcastStreamEvent', async () => {
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
                    content: [{ type: 'thinking', thinking: '' }],
                    stopReason: 'pending',
                    status: 'streaming',
                },
            },
            {
                type: 'assistant-update',
                runId: 'x',
                sessionId: 'x',
                entry: {
                    id: 'a1',
                    sessionId: 'x',
                    createdAt: 1,
                    kind: 'assistant',
                    content: [{ type: 'thinking', thinking: 'Analyzing code...' }],
                    stopReason: 'pending',
                    status: 'streaming',
                },
                streamEvent: {
                    type: 'thinking-delta',
                    contentIndex: 0,
                    delta: 'Analyzing code...',
                    partial: {
                        id: 'a1',
                        sessionId: 'x',
                        createdAt: 1,
                        kind: 'assistant',
                        content: [{ type: 'thinking', thinking: 'Analyzing code...' }],
                        stopReason: 'pending',
                        status: 'streaming',
                    },
                },
            },
            {
                type: 'tool-start',
                runId: 'x',
                sessionId: 'x',
                toolCallId: 'tool-1',
                toolName: 'read_file',
                args: { path: 'index.ts' },
            },
            {
                type: 'tool-end',
                runId: 'x',
                sessionId: 'x',
                toolCallId: 'tool-1',
                toolName: 'read_file',
                result: { content: [{ type: 'text', text: 'file content' }] },
                isError: false,
            },
            {
                type: 'assistant-update',
                runId: 'x',
                sessionId: 'x',
                entry: {
                    id: 'a1',
                    sessionId: 'x',
                    createdAt: 1,
                    kind: 'assistant',
                    content: [
                        { type: 'thinking', thinking: 'Analyzing code...' },
                        { type: 'text', text: 'Found the issue.' },
                    ],
                    stopReason: 'pending',
                    status: 'streaming',
                },
                streamEvent: {
                    type: 'text-delta',
                    contentIndex: 1,
                    delta: 'Found the issue.',
                    partial: {
                        id: 'a1',
                        sessionId: 'x',
                        createdAt: 1,
                        kind: 'assistant',
                        content: [{ type: 'text', text: 'Found the issue.' }],
                        stopReason: 'pending',
                        status: 'streaming',
                    },
                },
            },
        ]

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: createWrapper(service),
        })

        let createdSessionId: string | null = null
        await act(async () => {
            createdSessionId = await result.current.send('Fix bug')
        })

        expect(createdSessionId).toBeTruthy()

        // Wait for background stream loop to complete
        await waitFor(() => {
            expect(result.current.isStreaming).toBe(false)
        })

        // Check SessionBroadcastRunStatus calls:
        // 1. Initial 'running' on stream execution entry
        // 2. Transition to 'thinking'
        // 3. Transition to 'tool'
        // 4. Transition back to 'running'
        // 5. Final 'idle' on stream completion
        const runStatusCalls = broadcastRunStatusMock.mock.calls
        expect(runStatusCalls.length).toBeGreaterThanOrEqual(4)

        const statuses = runStatusCalls.map((call: any[]) => call[1])
        expect(statuses[0]).toBe('running')
        expect(statuses).toContain('thinking')
        expect(statuses).toContain('tool')
        expect(statuses).toContain('running')
        expect(statuses[statuses.length - 1]).toBe('idle')

        // All run status broadcasts should target the created sessionId
        for (const call of runStatusCalls) {
            expect(call[0]).toBe(createdSessionId)
        }

        // Check SessionBroadcastStreamEvent calls
        expect(broadcastStreamEventMock).toHaveBeenCalled()
        const streamEventCalls = broadcastStreamEventMock.mock.calls
        const broadcastEventTypes = streamEventCalls.map((c: any[]) => c[2].type)

        expect(broadcastEventTypes).toContain('user-entry')
        expect(broadcastEventTypes).toContain('agent-start')
        expect(broadcastEventTypes).toContain('assistant-start')
        expect(broadcastEventTypes).toContain('assistant-update')
        expect(broadcastEventTypes).toContain('tool-start')
        expect(broadcastEventTypes).toContain('tool-end')
        expect(broadcastEventTypes).toContain('agent-end')

        const assistantUpdate = streamEventCalls.find(
            (call: any[]) => call[2]?.type === 'assistant-update',
        )?.[2]
        expect(assistantUpdate?.entry).toBeDefined()
        expect(assistantUpdate?.streamEvent).not.toHaveProperty('partial')
    })

    it('Mirror mode receives remote session:stream-event and applies it into useMessageStore', async () => {
        const remoteSessionId = 'remote-sess-1'
        const remoteRunId = 'remote-run-1'

        useSessionStore.setState({
            sessions: [
                {
                    id: remoteSessionId,
                    title: 'Remote Session',
                    pinned: false,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                },
            ],
            currentSessionId: remoteSessionId,
        })

        renderHook(() => useAgentStream(), {
            wrapper: createWrapper(service),
        })

        expect(nativeEventListeners).toHaveLength(1)
        const emitNative = nativeEventListeners[0]!

        // 1. Remote agent-start
        act(() => {
            emitNative({
                kind: 'session:stream-event',
                data: JSON.stringify({
                    sessionId: remoteSessionId,
                    runId: remoteRunId,
                    event: {
                        type: 'agent-start',
                        sessionId: remoteSessionId,
                        runId: remoteRunId,
                    },
                }),
            })
        })

        // 2. Remote assistant-start
        act(() => {
            emitNative({
                kind: 'session:stream-event',
                data: JSON.stringify({
                    sessionId: remoteSessionId,
                    runId: remoteRunId,
                    event: {
                        type: 'assistant-start',
                        sessionId: remoteSessionId,
                        runId: remoteRunId,
                        entry: {
                            id: 'msg-remote-1',
                            sessionId: remoteSessionId,
                            createdAt: 1000,
                            kind: 'assistant',
                            content: [{ type: 'text', text: 'Hello' }],
                            stopReason: 'pending',
                            status: 'streaming',
                        },
                    },
                }),
            })
        })

        let entries = useMessageStore.getState().getEntries(remoteSessionId)
        expect(entries).toHaveLength(1)
        expect(entries[0]?.id).toBe('msg-remote-1')
        expect(entries[0]?.kind).toBe('assistant')

        // 3. Remote assistant-update
        act(() => {
            emitNative({
                kind: 'session:stream-event',
                data: JSON.stringify({
                    sessionId: remoteSessionId,
                    runId: remoteRunId,
                    event: {
                        type: 'assistant-update',
                        sessionId: remoteSessionId,
                        runId: remoteRunId,
                        entry: {
                            id: 'msg-remote-1',
                            sessionId: remoteSessionId,
                            createdAt: 1000,
                            kind: 'assistant',
                            content: [{ type: 'text', text: 'Hello from remote client' }],
                            stopReason: 'pending',
                            status: 'streaming',
                        },
                        streamEvent: {
                            type: 'text-delta',
                            contentIndex: 0,
                            delta: ' from remote client',
                            partial: {
                                id: 'msg-remote-1',
                                sessionId: remoteSessionId,
                                createdAt: 1000,
                                kind: 'assistant',
                                content: [{ type: 'text', text: 'Hello from remote client' }],
                                stopReason: 'pending',
                                status: 'streaming',
                            },
                        },
                    },
                }),
            })
        })

        entries = useMessageStore.getState().getEntries(remoteSessionId)
        expect(entries).toHaveLength(1)
        const asstEntry = entries[0]
        expect(asstEntry?.kind).toBe('assistant')
        if (asstEntry && asstEntry.kind === 'assistant') {
            const contentBlock = asstEntry.content[0]
            expect(contentBlock?.type).toBe('text')
            expect((contentBlock as any)?.text).toBe('Hello from remote client')
        }

        // 4. Remote assistant-end
        act(() => {
            emitNative({
                kind: 'session:stream-event',
                data: JSON.stringify({
                    sessionId: remoteSessionId,
                    runId: remoteRunId,
                    event: {
                        type: 'assistant-end',
                        sessionId: remoteSessionId,
                        runId: remoteRunId,
                        entry: {
                            id: 'msg-remote-1',
                            sessionId: remoteSessionId,
                            createdAt: 1000,
                            kind: 'assistant',
                            content: [{ type: 'text', text: 'Hello from remote client' }],
                            stopReason: 'stop',
                            status: 'done',
                        },
                    },
                }),
            })
        })

        // 5. Remote agent-end
        act(() => {
            emitNative({
                kind: 'session:stream-event',
                data: JSON.stringify({
                    sessionId: remoteSessionId,
                    runId: remoteRunId,
                    event: {
                        type: 'agent-end',
                        sessionId: remoteSessionId,
                        runId: remoteRunId,
                    },
                }),
            })
        })

        entries = useMessageStore.getState().getEntries(remoteSessionId)
        expect(entries).toHaveLength(1)
        expect((entries[0] as any).status).toBe('done')
    })

    it('Mirror mode ignores session:stream-event for non-current session', async () => {
        const currentSessionId = 'current-active-sess'
        const backgroundSessionId = 'background-sess'
        const remoteRunId = 'remote-run-bg'

        useSessionStore.setState({
            sessions: [
                {
                    id: currentSessionId,
                    title: 'Current Session',
                    pinned: false,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                },
                {
                    id: backgroundSessionId,
                    title: 'Background Session',
                    pinned: false,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                },
            ],
            currentSessionId: currentSessionId,
        })

        renderHook(() => useAgentStream(), {
            wrapper: createWrapper(service),
        })

        const emitNative = nativeEventListeners[0]!

        act(() => {
            emitNative({
                kind: 'session:stream-event',
                data: JSON.stringify({
                    sessionId: backgroundSessionId,
                    runId: remoteRunId,
                    event: {
                        type: 'assistant-start',
                        sessionId: backgroundSessionId,
                        runId: remoteRunId,
                        entry: {
                            id: 'msg-bg-1',
                            sessionId: backgroundSessionId,
                            createdAt: 1000,
                            kind: 'assistant',
                            content: [{ type: 'text', text: 'Hello background' }],
                            stopReason: 'pending',
                            status: 'streaming',
                        },
                    },
                }),
            })
        })

        const bgEntries = useMessageStore.getState().getEntries(backgroundSessionId)
        expect(bgEntries).toHaveLength(0)
    })

    it('prevents self-echo when receiving session:stream-event for a local hosted runId', async () => {
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
                    content: [{ type: 'text', text: 'Local answer' }],
                    stopReason: 'stop',
                    status: 'done',
                },
            },
        ]

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: createWrapper(service),
        })

        let createdSessionId: string | null = null
        await act(async () => {
            createdSessionId = await result.current.send('Hello world')
        })

        await waitFor(() => {
            expect(result.current.isStreaming).toBe(false)
        })

        expect(broadcastStreamEventMock).toHaveBeenCalled()
        const capturedRunId = broadcastStreamEventMock.mock.calls[0][1]
        expect(capturedRunId).toBeTruthy()

        const initialEntries = useMessageStore.getState().getEntries(createdSessionId!)
        const initialCount = initialEntries.length

        // Simulate backend echoing stream event back to this client via session:stream-event
        const emitNative = nativeEventListeners[0]!
        act(() => {
            emitNative({
                kind: 'session:stream-event',
                data: JSON.stringify({
                    sessionId: createdSessionId,
                    runId: capturedRunId,
                    event: {
                        type: 'assistant-start',
                        sessionId: createdSessionId,
                        runId: capturedRunId,
                        entry: {
                            id: 'duplicate-entry',
                            sessionId: createdSessionId,
                            createdAt: 2,
                            kind: 'assistant',
                            content: [{ type: 'text', text: 'Duplicate should not exist' }],
                            stopReason: 'stop',
                            status: 'done',
                        },
                    },
                }),
            })
        })

        const afterEntries = useMessageStore.getState().getEntries(createdSessionId!)
        expect(afterEntries.length).toBe(initialCount)
        expect(afterEntries.some((e) => e.id === 'duplicate-entry')).toBe(false)
    })

    it('prevents self-echo for locally hosted subagent runs', () => {
        let subAgentListener: {
            onStateChange: (agents: readonly any[]) => void
            onEvent?: (event: AgentRunEvent) => void
        } | undefined
        ;(service as FakeSyncService & { subAgents: any }).subAgents = {
            hydrate: vi.fn(),
            subscribe: vi.fn((listener) => {
                subAgentListener = listener
                listener.onStateChange([])
                return () => {}
            }),
        }

        const parentSessionId = 'local-subagent-parent'
        const childSessionId = 'local-subagent-child'
        const childRunId = 'local-subagent-run'
        useSessionStore.setState({
            sessions: [
                {
                    id: parentSessionId,
                    title: 'Parent',
                    pinned: false,
                    createdAt: 1,
                    updatedAt: 1,
                },
            ],
            currentSessionId: parentSessionId,
        })
        useSubAgentStore.setState({
            agents: [
                {
                    id: childSessionId,
                    sessionId: childSessionId,
                    parentSessionId,
                    name: 'Local child',
                    status: 'running',
                    icon: 'sparkle',
                    color: '#7c3aed',
                    modelId: 'test-model',
                    createdAt: 1,
                    updatedAt: 1,
                },
            ],
        })

        renderHook(() => useAgentStream(), {
            wrapper: createWrapper(service),
        })

        const localStart: AgentRunEvent = {
            type: 'agent-start',
            sessionId: childSessionId,
            runId: childRunId,
        }
        const localAssistant: AgentRunEvent = {
            type: 'assistant-start',
            sessionId: childSessionId,
            runId: childRunId,
            entry: {
                id: 'local-child-answer',
                sessionId: childSessionId,
                createdAt: 2,
                kind: 'assistant',
                content: [{ type: 'text', text: 'local' }],
                stopReason: 'pending',
                status: 'streaming',
            },
        }
        act(() => {
            subAgentListener?.onEvent?.(localStart)
            subAgentListener?.onEvent?.(localAssistant)
        })

        expect(broadcastStreamEventMock).toHaveBeenCalledWith(
            childSessionId,
            childRunId,
            localStart,
        )
        expect(broadcastStreamEventMock).toHaveBeenCalledWith(
            childSessionId,
            childRunId,
            localAssistant,
        )

        const emitNative = nativeEventListeners[0]!
        act(() => {
            emitNative({
                kind: 'session:stream-event',
                data: JSON.stringify({
                    sessionId: childSessionId,
                    runId: childRunId,
                    event: {
                        type: 'assistant-start',
                        sessionId: childSessionId,
                        runId: childRunId,
                        entry: {
                            id: 'self-echo-duplicate',
                            sessionId: childSessionId,
                            createdAt: 3,
                            kind: 'assistant',
                            content: [{ type: 'text', text: 'duplicate' }],
                            stopReason: 'pending',
                            status: 'streaming',
                        },
                    },
                }),
            })
        })

        const entries = useMessageStore.getState().getEntries(childSessionId)
        expect(entries.some((entry) => entry.id === 'local-child-answer')).toBe(true)
        expect(entries.some((entry) => entry.id === 'self-echo-duplicate')).toBe(false)
    })

    it('suppresses persistence when applying remote session:stream-event in mirror mode', async () => {
        const sessionSetMock = vi.fn().mockResolvedValue(undefined)
        setHostBridge({
            SessionBroadcastRunStatus: broadcastRunStatusMock,
            SessionBroadcastStreamEvent: broadcastStreamEventMock,
            SessionAbortRun: abortRunMock,
            SessionDelegateRun: delegateRunMock,
            SessionSet: sessionSetMock,
            onNativeEvent: vi.fn((cb: (event: any) => void) => {
                nativeEventListeners.push(cb)
                return () => {
                    const idx = nativeEventListeners.indexOf(cb)
                    if (idx >= 0) nativeEventListeners.splice(idx, 1)
                }
            }),
        } as any)

        const remoteSessionId = 'mirror-sess-persist-test'
        const remoteRunId = 'remote-run-persist-test'

        useSessionStore.setState({
            sessions: [
                {
                    id: remoteSessionId,
                    title: 'Remote Session',
                    pinned: false,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                },
            ],
            currentSessionId: remoteSessionId,
        })

        bindPersistence({ debounceMs: 10 })

        renderHook(() => useAgentStream(), {
            wrapper: createWrapper(service),
        })

        const emitNative = nativeEventListeners[0]!

        // 1. Remote agent-start
        act(() => {
            emitNative({
                kind: 'session:stream-event',
                data: JSON.stringify({
                    sessionId: remoteSessionId,
                    runId: remoteRunId,
                    event: {
                        type: 'agent-start',
                        sessionId: remoteSessionId,
                        runId: remoteRunId,
                    },
                }),
            })
        })

        // 2. Remote assistant-start
        act(() => {
            emitNative({
                kind: 'session:stream-event',
                data: JSON.stringify({
                    sessionId: remoteSessionId,
                    runId: remoteRunId,
                    event: {
                        type: 'assistant-start',
                        sessionId: remoteSessionId,
                        runId: remoteRunId,
                        entry: {
                            id: 'remote-msg-1',
                            sessionId: remoteSessionId,
                            createdAt: 1000,
                            kind: 'assistant',
                            content: [{ type: 'text', text: 'Remote response' }],
                            stopReason: 'stop',
                            status: 'done',
                        },
                    },
                }),
            })
        })

        const entries = useMessageStore.getState().getEntries(remoteSessionId)
        expect(entries).toHaveLength(1)
        expect(entries[0]?.id).toBe('remote-msg-1')

        await new Promise((r) => setTimeout(r, 50))
        expect(sessionSetMock).not.toHaveBeenCalled()
    })

    it('Remote session:abort-run triggers local flight abort', async () => {
        let releaseHold: () => void = () => {}
        service.streamHold = new Promise<void>((resolve) => {
            releaseHold = resolve
        })

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: createWrapper(service),
        })

        let targetSessionId: string | null = null
        await act(async () => {
            targetSessionId = await result.current.send('Long running task')
        })

        expect(targetSessionId).toBeTruthy()
        expect(result.current.isStreaming).toBe(true)
        expect(result.current.sessionId).toBe(targetSessionId)

        const emitNative = nativeEventListeners[0]!

        // Trigger abort for a different session - should not abort local flight
        act(() => {
            emitNative({
                kind: 'session:abort-run',
                data: JSON.stringify({ sessionId: 'other-session' }),
            })
        })
        expect(result.current.isStreaming).toBe(true)
        expect(service.abortCalls).toHaveLength(0)

        // Trigger abort for current session
        act(() => {
            emitNative({
                kind: 'session:abort-run',
                data: JSON.stringify({ sessionId: targetSessionId }),
            })
        })

        // Release hold so stream loop finishes abort handling
        act(() => {
            releaseHold()
        })

        await waitFor(() => {
            expect(result.current.isStreaming).toBe(false)
        })
    })

    it('stop() sends SessionAbortRun even when current client is in mirror mode', async () => {
        useSessionStore.setState({
            sessions: [
                {
                    id: 'mirror-sess-1',
                    title: 'Remote Session',
                    pinned: false,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                },
            ],
            currentSessionId: 'mirror-sess-1',
        })

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: createWrapper(service),
        })

        expect(result.current.isStreaming).toBe(false)
        expect(result.current.sessionId).toBeNull()

        // Call stop in mirror mode
        act(() => {
            result.current.stop()
        })

        expect(abortRunMock).toHaveBeenCalledWith('mirror-sess-1')
        expect(service.abortCalls).toHaveLength(0)
    })

    it('stop() aborts locally without calling SessionAbortRun when current client is in host mode', async () => {
        let releaseHold: () => void = () => {}
        service.streamHold = new Promise<void>((resolve) => {
            releaseHold = resolve
        })

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: createWrapper(service),
        })

        let sessionId: string | null = null
        await act(async () => {
            sessionId = await result.current.send('Host task')
        })

        expect(sessionId).toBeTruthy()
        expect(result.current.isStreaming).toBe(true)

        act(() => {
            result.current.stop()
        })

        expect(abortRunMock).not.toHaveBeenCalled()
        expect(service.abortCalls.length).toBeGreaterThan(0)

        releaseHold()
        await waitFor(() => {
            expect(result.current.isStreaming).toBe(false)
        })
    })

    it('cleans up native event listener when runtime is disposed', async () => {
        renderHook(() => useAgentStream(), {
            wrapper: createWrapper(service),
        })

        expect(nativeEventListeners).toHaveLength(1)

        await act(async () => {
            await disposeAgentRuntime(service)
        })

        expect(nativeEventListeners).toHaveLength(0)
    })

    it('send() in Mirror mode triggers SessionAbortRun on remote session and sends new prompt', async () => {
        useSessionStore.setState({
            sessions: [
                {
                    id: 'mirror-sess-1',
                    title: 'Remote Session',
                    pinned: false,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                },
            ],
            currentSessionId: 'mirror-sess-1',
        })

        useSessionRunStore.getState().setRun('mirror-sess-1', {
            sessionId: 'mirror-sess-1',
            runId: 'remote-run-999',
            status: 'running',
            clientId: 'remote-client',
            updatedAt: Date.now(),
        })

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: createWrapper(service),
        })

        expect(result.current.isStreaming).toBe(false)

        let targetSessionId: string | null = null
        await act(async () => {
            targetSessionId = await result.current.send('Mirror takeover prompt')
        })

        expect(abortRunMock).toHaveBeenCalledWith('mirror-sess-1')
        expect(targetSessionId).toBe('mirror-sess-1')
        expect(service.streamChatCalls.length).toBe(1)
        const lastCall = service.streamChatCalls[0]!
        const lastEntry = lastCall.entries[lastCall.entries.length - 1]
        expect(lastEntry?.kind).toBe('user')
        if (lastEntry?.kind === 'user') {
            const textBlock = lastEntry.content.find((c) => c.type === 'text')
            expect(textBlock?.text).toBe('Mirror takeover prompt')
        }
    })

    it('send() during active Host streaming with steer mode does not interrupt flight', async () => {
        let releaseHold: () => void = () => {}
        service.streamHold = new Promise<void>((resolve) => {
            releaseHold = resolve
        })

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: createWrapper(service),
        })

        let firstSessionId: string | null = null
        await act(async () => {
            firstSessionId = await result.current.send('First host prompt')
        })

        expect(firstSessionId).toBeTruthy()
        expect(result.current.isStreaming).toBe(true)
        const firstRunId = result.current.runId
        expect(firstRunId).toBeTruthy()

        let secondSessionId: string | null = null
        await act(async () => {
            secondSessionId = await result.current.send({
                text: 'Second host prompt',
                sessionId: firstSessionId!,
                followUpMode: 'steer',
            })
        })

        expect(service.abortCalls).not.toContain(firstRunId)
        expect(secondSessionId).toBe(firstSessionId)

        const entries = useMessageStore.getState().getEntries(firstSessionId!)
        const steerEntry = entries.find((e) => e.kind === 'user' && (e as any).pendingStatus === 'steer')
        expect(steerEntry).toBeDefined()

        service.streamHold = null
        releaseHold()

        await waitFor(() => expect(result.current.isStreaming).toBe(false))
    })

    it('Mirror takeover abort echo does not kill the new local flight', async () => {
        const remoteSessionId = 'mirror-takeover-1'
        const oldRemoteRunId = 'remote-run-old-1'

        useSessionStore.setState({
            sessions: [
                {
                    id: remoteSessionId,
                    title: 'Remote Session',
                    pinned: false,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                },
            ],
            currentSessionId: remoteSessionId,
        })

        useSessionRunStore.getState().setRun(remoteSessionId, {
            sessionId: remoteSessionId,
            runId: oldRemoteRunId,
            status: 'running',
            clientId: 'remote-client',
            updatedAt: Date.now(),
        })

        let releaseHold: () => void = () => {}
        service.streamHold = new Promise<void>((resolve) => {
            releaseHold = resolve
        })

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: createWrapper(service),
        })

        let targetSessionId: string | null = null
        await act(async () => {
            targetSessionId = await result.current.send('Takeover prompt')
        })

        expect(targetSessionId).toBe(remoteSessionId)
        expect(abortRunMock).toHaveBeenCalledWith(remoteSessionId)
        expect(result.current.isStreaming).toBe(true)

        // Native event loop echoes back session:abort-run caused by our SessionAbortRun
        const emitNative = nativeEventListeners[0]!
        act(() => {
            emitNative({
                kind: 'session:abort-run',
                data: JSON.stringify({ sessionId: remoteSessionId }),
            })
        })

        // Local flight must NOT be aborted by the echo
        expect(result.current.isStreaming).toBe(true)
        expect(service.streamChatCalls[0]?.signal?.aborted).toBe(false)
        expect(service.abortCalls.length).toBe(0)

        // Completes normally when stream finishes
        act(() => {
            releaseHold()
        })
        await waitFor(() => {
            expect(result.current.isStreaming).toBe(false)
        })
    })

    it('Subsequent session:abort-run after takeover successfully aborts the new local flight', async () => {
        const remoteSessionId = 'mirror-takeover-2'
        const oldRemoteRunId = 'remote-run-old-2'

        useSessionStore.setState({
            sessions: [
                {
                    id: remoteSessionId,
                    title: 'Remote Session',
                    pinned: false,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                },
            ],
            currentSessionId: remoteSessionId,
        })

        useSessionRunStore.getState().setRun(remoteSessionId, {
            sessionId: remoteSessionId,
            runId: oldRemoteRunId,
            status: 'running',
            clientId: 'remote-client',
            updatedAt: Date.now(),
        })

        service.streamHold = new Promise<void>(() => {})

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: createWrapper(service),
        })

        await act(async () => {
            await result.current.send('Takeover prompt')
        })

        expect(result.current.isStreaming).toBe(true)

        const emitNative = nativeEventListeners[0]!

        // 1. First abort echo from takeover is swallowed
        act(() => {
            emitNative({
                kind: 'session:abort-run',
                data: JSON.stringify({ sessionId: remoteSessionId }),
            })
        })
        expect(result.current.isStreaming).toBe(true)
        expect(service.streamChatCalls[0]?.signal?.aborted).toBe(false)
        expect(service.abortCalls.length).toBe(0)

        // 2. Second abort is a legit new abort from another client -> aborts the flight
        act(() => {
            emitNative({
                kind: 'session:abort-run',
                data: JSON.stringify({ sessionId: remoteSessionId }),
            })
        })

        expect(service.streamChatCalls[0]?.signal?.aborted).toBe(true)
        expect(service.abortCalls.length).toBe(1)

        await waitFor(() => {
            expect(result.current.isStreaming).toBe(false)
        })
    })

    it("Abort echo arriving during prepare is consumed and doesn't block future legit aborts", async () => {
        const remoteSessionId = 'mirror-takeover-3'
        const oldRemoteRunId = 'remote-run-old-3'

        useSessionStore.setState({
            sessions: [
                {
                    id: remoteSessionId,
                    title: 'Remote Session',
                    pinned: false,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                },
            ],
            currentSessionId: remoteSessionId,
        })

        useSessionRunStore.getState().setRun(remoteSessionId, {
            sessionId: remoteSessionId,
            runId: oldRemoteRunId,
            status: 'running',
            clientId: 'remote-client',
            updatedAt: Date.now(),
        })

        let resolvePrepare: () => void = () => {}
        service.prepareImpl = async () => {
            await new Promise<void>((resolve) => {
                resolvePrepare = resolve
            })
            return makePrepared()
        }

        service.streamHold = new Promise<void>(() => {})

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: createWrapper(service),
        })

        let sendPromise: Promise<string | null> | null = null
        act(() => {
            sendPromise = result.current.send('Takeover prompt during prepare')
        })

        // Now flight token is incremented, pendingTakeoverAborts has remoteSessionId, but prepare is paused
        const emitNative = nativeEventListeners[0]!

        // Abort echo arrives while prepare is still running
        act(() => {
            emitNative({
                kind: 'session:abort-run',
                data: JSON.stringify({ sessionId: remoteSessionId }),
            })
        })

        // Unblock prepare
        await act(async () => {
            resolvePrepare()
            await sendPromise
        })

        // Flight is streaming now
        expect(result.current.isStreaming).toBe(true)
        expect(service.streamChatCalls[0]?.signal?.aborted).toBe(false)
        expect(service.abortCalls.length).toBe(0)

        // Subsequent legit abort arrives and should abort the streaming flight
        act(() => {
            emitNative({
                kind: 'session:abort-run',
                data: JSON.stringify({ sessionId: remoteSessionId }),
            })
        })

        expect(service.streamChatCalls[0]?.signal?.aborted).toBe(true)
        expect(service.abortCalls.length).toBe(1)

        await waitFor(() => {
            expect(result.current.isStreaming).toBe(false)
        })
    })

    it('Trailing stream events from the old aborted remote runId are ignored during and after takeover', async () => {
        const remoteSessionId = 'mirror-takeover-4'
        const oldRemoteRunId = 'remote-run-old-4'

        useSessionStore.setState({
            sessions: [
                {
                    id: remoteSessionId,
                    title: 'Remote Session',
                    pinned: false,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                },
            ],
            currentSessionId: remoteSessionId,
        })

        useSessionRunStore.getState().setRun(remoteSessionId, {
            sessionId: remoteSessionId,
            runId: oldRemoteRunId,
            status: 'running',
            clientId: 'remote-client',
            updatedAt: Date.now(),
        })

        let releaseHold: () => void = () => {}
        service.streamHold = new Promise<void>((resolve) => {
            releaseHold = resolve
        })

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: createWrapper(service),
        })

        await act(async () => {
            await result.current.send('Takeover prompt')
        })

        expect(result.current.isStreaming).toBe(true)

        const emitNative = nativeEventListeners[0]!

        // Trailing event from the old aborted remote runId arrives during local flight
        act(() => {
            emitNative({
                kind: 'session:stream-event',
                data: JSON.stringify({
                    sessionId: remoteSessionId,
                    runId: oldRemoteRunId,
                    event: {
                        type: 'assistant-update',
                        sessionId: remoteSessionId,
                        runId: oldRemoteRunId,
                        entry: {
                            id: 'old-trailing-msg',
                            sessionId: remoteSessionId,
                            createdAt: 2000,
                            kind: 'assistant',
                            content: [{ type: 'text', text: 'Old trailing message' }],
                            stopReason: 'pending',
                            status: 'streaming',
                        },
                        streamEvent: {
                            type: 'text-delta',
                            contentIndex: 0,
                            delta: 'Old trailing message',
                        },
                    },
                }),
            })
        })

        let entries = useMessageStore.getState().getEntries(remoteSessionId)
        expect(entries.some((e) => e.id === 'old-trailing-msg')).toBe(false)

        // Release local flight
        act(() => {
            releaseHold()
        })
        await waitFor(() => {
            expect(result.current.isStreaming).toBe(false)
        })

        // Trailing event from the old aborted remote runId arrives after local flight completes
        act(() => {
            emitNative({
                kind: 'session:stream-event',
                data: JSON.stringify({
                    sessionId: remoteSessionId,
                    runId: oldRemoteRunId,
                    event: {
                        type: 'assistant-end',
                        sessionId: remoteSessionId,
                        runId: oldRemoteRunId,
                        entry: {
                            id: 'old-trailing-msg-2',
                            sessionId: remoteSessionId,
                            createdAt: 3000,
                            kind: 'assistant',
                            content: [{ type: 'text', text: 'Old trailing message 2' }],
                            stopReason: 'stop',
                            status: 'done',
                        },
                    },
                }),
            })
        })

        entries = useMessageStore.getState().getEntries(remoteSessionId)
        expect(entries.some((e) => e.id === 'old-trailing-msg-2')).toBe(false)
    })

    it('compact broadcasts running status at start, stream events during loop, and idle status at end', async () => {
        const sessionId = 'sess-compact-1'
        useSessionStore.setState({
            sessions: [
                {
                    id: sessionId,
                    title: 'Compact Session',
                    pinned: false,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                },
            ],
            currentSessionId: sessionId,
        })

        useMessageStore.getState().replaceSessionEntries(sessionId, [
            {
                id: 'u1',
                sessionId,
                createdAt: 1000,
                kind: 'user',
                version: 1,
                content: [{ type: 'text', text: 'First user message' }],
            },
            {
                id: 'a1',
                sessionId,
                createdAt: 2000,
                kind: 'assistant',
                version: 1,
                content: [{ type: 'text', text: 'First assistant response' }],
                stopReason: 'stop',
                status: 'done',
            },
        ])

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: createWrapper(service),
        })

        await act(async () => {
            await result.current.compact('Summarize prior context')
        })

        // Verify broadcastRunStatus called with running, then idle
        expect(broadcastRunStatusMock).toHaveBeenCalledWith(
            sessionId,
            'running',
            expect.any(String),
            '',
        )
        expect(broadcastRunStatusMock).toHaveBeenCalledWith(
            sessionId,
            'idle',
            expect.any(String),
            '',
        )

        // Verify broadcastStreamEvent called for compaction events
        expect(broadcastStreamEventMock).toHaveBeenCalled()
        const eventArgs = broadcastStreamEventMock.mock.calls.map((c: any[]) => c[2])
        expect(eventArgs.some((e: any) => e.type === 'compaction-end' || e.kind === 'compaction')).toBe(true)
    })

    it('pendingTakeoverAborts auto-expires after 3000ms safety timeout', async () => {
        const remoteSessionId = 'mirror-takeover-expire'
        const oldRemoteRunId = 'remote-run-old-expire'

        useSessionStore.setState({
            sessions: [
                {
                    id: remoteSessionId,
                    title: 'Takeover Expire Session',
                    pinned: false,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                },
            ],
            currentSessionId: remoteSessionId,
        })

        useSessionRunStore.getState().setRun(remoteSessionId, {
            sessionId: remoteSessionId,
            runId: oldRemoteRunId,
            status: 'running',
            clientId: 'remote-client',
            updatedAt: Date.now(),
        })

        service.streamHold = new Promise<void>(() => {})

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: createWrapper(service),
        })

        await act(async () => {
            void result.current.send('Takeover prompt')
        })

        await waitFor(() => {
            expect(result.current.isStreaming).toBe(true)
        })

        // Wait past the 3000ms takeover safety timeout
        await new Promise((resolve) => setTimeout(resolve, 3100))

        const emitNative = nativeEventListeners[0]!

        // Now emit session:abort-run. Since the 3000ms expired, it should NOT be swallowed as a takeover echo
        act(() => {
            emitNative({
                kind: 'session:abort-run',
                data: JSON.stringify({ sessionId: remoteSessionId }),
            })
        })

        // Verify that the flight was aborted
        expect(service.streamChatCalls[0]?.signal?.aborted).toBe(true)
        expect(service.abortCalls.length).toBe(1)
    })

    it('broadcasts user-entry event when send() starts streaming', async () => {
        const { result } = renderHook(() => useAgentStream(), {
            wrapper: createWrapper(service),
        })

        let createdSessionId: string | null = null
        await act(async () => {
            createdSessionId = await result.current.send('How do I write tests?')
        })

        await waitFor(() => {
            expect(result.current.isStreaming).toBe(false)
        })

        expect(broadcastStreamEventMock).toHaveBeenCalled()
        const userEntryBroadcast = broadcastStreamEventMock.mock.calls.find(
            (call: any[]) => call[2]?.type === 'user-entry',
        )
        expect(userEntryBroadcast).toBeDefined()
        expect(userEntryBroadcast[0]).toBe(createdSessionId)
        expect(userEntryBroadcast[2]).toMatchObject({
            type: 'user-entry',
            sessionId: createdSessionId,
            entry: expect.objectContaining({
                kind: 'user',
                content: [{ type: 'text', text: 'How do I write tests?' }],
            }),
        })
    })

    it('Mirror mode receives remote tool-start and tool-end session:stream-event and updates tool overlay', async () => {
        const remoteSessionId = 'mirror-tool-sess'
        const remoteRunId = 'mirror-tool-run'

        useSessionStore.setState({
            sessions: [
                {
                    id: remoteSessionId,
                    title: 'Tool Test Session',
                    pinned: false,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                },
            ],
            currentSessionId: remoteSessionId,
        })

        renderHook(() => useAgentStream(), {
            wrapper: createWrapper(service),
        })

        const emitNative = nativeEventListeners[0]!

        // 1. Assistant start with toolCall
        act(() => {
            emitNative({
                kind: 'session:stream-event',
                data: JSON.stringify({
                    sessionId: remoteSessionId,
                    runId: remoteRunId,
                    event: {
                        type: 'assistant-start',
                        sessionId: remoteSessionId,
                        runId: remoteRunId,
                        entry: {
                            id: 'msg-asst-tool',
                            sessionId: remoteSessionId,
                            createdAt: 1000,
                            kind: 'assistant',
                            content: [
                                {
                                    type: 'toolCall',
                                    id: 'call_bash_1',
                                    name: 'bash',
                                    arguments: { command: 'ls' },
                                },
                            ],
                            stopReason: 'pending',
                            status: 'streaming',
                        },
                    },
                }),
            })
        })

        // 2. tool-start event
        act(() => {
            emitNative({
                kind: 'session:stream-event',
                data: JSON.stringify({
                    sessionId: remoteSessionId,
                    runId: remoteRunId,
                    event: {
                        type: 'tool-start',
                        sessionId: remoteSessionId,
                        runId: remoteRunId,
                        toolCallId: 'call_bash_1',
                        toolName: 'bash',
                        args: { command: 'ls' },
                    },
                }),
            })
        })

        const runningOverlay = useToolOverlayStore
            .getState()
            .getOverlay(remoteSessionId, 'call_bash_1')
        expect(runningOverlay?.status).toBe('running')

        // 3. tool-end event
        act(() => {
            emitNative({
                kind: 'session:stream-event',
                data: JSON.stringify({
                    sessionId: remoteSessionId,
                    runId: remoteRunId,
                    event: {
                        type: 'tool-end',
                        sessionId: remoteSessionId,
                        runId: remoteRunId,
                        toolCallId: 'call_bash_1',
                        toolName: 'bash',
                        result: { content: [{ type: 'text', text: 'file1.ts\nfile2.ts' }] },
                        isError: false,
                    },
                }),
            })
        })

        const doneOverlay = useToolOverlayStore
            .getState()
            .getOverlay(remoteSessionId, 'call_bash_1')
        expect(doneOverlay?.status).toBe('done')
    })

    it('Mirror mode auto-bootstraps when receiving user-entry session:stream-event mid-stream', async () => {
        const remoteSessionId = 'mirror-mid-sess'
        const remoteRunId = 'mirror-mid-run'

        useSessionStore.setState({
            sessions: [
                {
                    id: remoteSessionId,
                    title: 'Mid Stream Session',
                    pinned: false,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                },
            ],
            currentSessionId: remoteSessionId,
        })

        renderHook(() => useAgentStream(), {
            wrapper: createWrapper(service),
        })

        const emitNative = nativeEventListeners[0]!

        // Emit user-entry without prior agent-start
        act(() => {
            emitNative({
                kind: 'session:stream-event',
                data: JSON.stringify({
                    sessionId: remoteSessionId,
                    runId: remoteRunId,
                    event: {
                        type: 'user-entry',
                        sessionId: remoteSessionId,
                        runId: remoteRunId,
                        entry: {
                            id: 'mid-user-1',
                            sessionId: remoteSessionId,
                            createdAt: 500,
                            kind: 'user',
                            content: [{ type: 'text', text: 'Mid-stream prompt' }],
                        },
                    },
                }),
            })
        })

        const entries = useMessageStore.getState().getEntries(remoteSessionId)
        expect(entries).toHaveLength(1)
        expect(entries[0]?.id).toBe('mid-user-1')
        expect(entries[0]?.kind).toBe('user')

        // Subsequent assistant-start works because run was auto-bootstrapped
        act(() => {
            emitNative({
                kind: 'session:stream-event',
                data: JSON.stringify({
                    sessionId: remoteSessionId,
                    runId: remoteRunId,
                    event: {
                        type: 'assistant-start',
                        sessionId: remoteSessionId,
                        runId: remoteRunId,
                        entry: {
                            id: 'mid-asst-1',
                            sessionId: remoteSessionId,
                            createdAt: 1000,
                            kind: 'assistant',
                            content: [{ type: 'text', text: 'Responding...' }],
                            stopReason: 'pending',
                            status: 'streaming',
                        },
                    },
                }),
            })
        })

        const entriesAfter = useMessageStore.getState().getEntries(remoteSessionId)
        expect(entriesAfter).toHaveLength(2)
        expect(entriesAfter[1]?.id).toBe('mid-asst-1')
    })

    it('calling send() in browser environment delegates via SessionDelegateRun and appends userEntry locally', async () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
            configurable: true,
        })

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: createWrapper(service),
        })

        let sessionId: string | null = null
        await act(async () => {
            sessionId = await result.current.send({
                text: 'Delegated prompt from browser',
                projectId: 'test-project',
                branch: 'feature-branch',
            })
        })

        expect(sessionId).toBeTruthy()
        // Web client has user entry appended locally
        const entries = useMessageStore.getState().getEntries(sessionId!)
        expect(entries).toHaveLength(1)
        expect(entries[0]?.kind).toBe('user')
        if (entries[0]?.kind === 'user') {
            const textBlock = entries[0].content.find((c) => c.type === 'text')
            expect(textBlock?.text).toBe('Delegated prompt from browser')
        }

        expect(delegateRunMock).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId,
                text: 'Delegated prompt from browser',
                images: undefined,
                projectId: 'test-project',
                branch: 'feature-branch',
                modelId: 'test-model',
                reasoningEffort: 'medium',
                speed: 'standard',
                editMessageId: undefined,
                userEntryId: entries[0]?.id,
                userEntryCreatedAt: entries[0]?.createdAt,
            }),
        )

        // Web client does NOT run AgentLoop / streamChat locally
        expect(service.streamChatCalls).toHaveLength(0)
        expect(result.current.isStreaming).toBe(false)
    })

    it('calling send() in browser environment with existing session preserves session ID and appends userEntry', async () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
            configurable: true,
        })

        const existingSessionId = useSessionStore.getState().createSession({
            title: 'Existing Web Session',
            projectId: 'proj-abc',
        })

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: createWrapper(service),
        })

        let returnedSessionId: string | null = null
        await act(async () => {
            returnedSessionId = await result.current.send({
                sessionId: existingSessionId,
                text: 'Follow-up message in browser',
            })
        })

        expect(returnedSessionId).toBe(existingSessionId)
        const entries = useMessageStore.getState().getEntries(existingSessionId)
        expect(entries).toHaveLength(1)
        expect(entries[0]?.kind).toBe('user')
        expect(service.streamChatCalls).toHaveLength(0)

        expect(delegateRunMock).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId: existingSessionId,
                text: 'Follow-up message in browser',
                images: undefined,
                projectId: 'proj-abc',
                branch: null,
                editMessageId: undefined,
                userEntryId: entries[0]?.id,
                userEntryCreatedAt: entries[0]?.createdAt,
            }),
        )
    })

    it('calling send() in browser environment with editMessageId replaces entries up to target', async () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
            configurable: true,
        })

        const sessId = useSessionStore.getState().createSession({ title: 'Edit Test' })
        useMessageStore.getState().replaceSessionEntries(sessId, [
            {
                id: 'u1',
                sessionId: sessId,
                createdAt: 1000,
                kind: 'user',
                content: [{ type: 'text', text: 'Original message' }],
            },
            {
                id: 'a1',
                sessionId: sessId,
                createdAt: 2000,
                kind: 'assistant',
                content: [{ type: 'text', text: 'Assistant reply' }],
                stopReason: 'stop',
                status: 'done',
            },
        ])

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: createWrapper(service),
        })

        await act(async () => {
            await result.current.send({
                sessionId: sessId,
                text: 'Edited message',
                editMessageId: 'u1',
            })
        })

        expect(delegateRunMock).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId: sessId,
                text: 'Edited message',
                editMessageId: 'u1',
            }),
        )

        const entries = useMessageStore.getState().getEntries(sessId)
        expect(entries).toHaveLength(1)
        expect(entries[0]?.id).toBe('u1')
        if (entries[0]?.kind === 'user') {
            const textBlock = entries[0].content.find((c) => c.type === 'text')
            expect(textBlock?.text).toBe('Edited message')
        }
    })

    it('Web client syncs message edit from Desktop and cleans up stale turn history', async () => {
        const syncSessionId = useSessionStore.getState().createSession({ title: 'Sync Edit Session' })
        useSessionStore.getState().setCurrentSession(syncSessionId)

        // Web client already loaded initial 2-turn conversation
        useMessageStore.getState().replaceSessionEntries(syncSessionId, [
            {
                id: 'user-turn-1',
                sessionId: syncSessionId,
                createdAt: 100,
                kind: 'user',
                content: [{ type: 'text', text: 'Original message' }],
            },
            {
                id: 'asst-turn-1',
                sessionId: syncSessionId,
                createdAt: 110,
                kind: 'assistant',
                status: 'done',
                stopReason: 'stop',
                content: [{ type: 'text', text: 'Original assistant response' }],
            },
            {
                id: 'user-turn-2',
                sessionId: syncSessionId,
                createdAt: 200,
                kind: 'user',
                content: [{ type: 'text', text: 'Second prompt' }],
            },
            {
                id: 'asst-turn-2',
                sessionId: syncSessionId,
                createdAt: 210,
                kind: 'assistant',
                status: 'done',
                stopReason: 'stop',
                content: [{ type: 'text', text: 'Second assistant response' }],
            },
        ])

        renderHook(() => useAgentStream(), {
            wrapper: createWrapper(service),
        })

        const emitNative = nativeEventListeners[0]!

        // Desktop edits user-turn-1 and broadcasts user-entry event
        await act(async () => {
            emitNative({
                kind: 'session:stream-event',
                data: JSON.stringify({
                    sessionId: syncSessionId,
                    runId: 'desktop-edit-run-1',
                    event: {
                        type: 'user-entry',
                        sessionId: syncSessionId,
                        runId: 'desktop-edit-run-1',
                        entry: {
                            id: 'user-turn-1',
                            sessionId: syncSessionId,
                            createdAt: 100,
                            kind: 'user',
                            content: [{ type: 'text', text: 'Desktop edited first message' }],
                        },
                    },
                }),
            })
        })

        // Web client store should now only have the edited user-turn-1 (subsequent old turns pruned)
        const entriesAfterUserEntry = useMessageStore.getState().getEntries(syncSessionId)
        expect(entriesAfterUserEntry).toHaveLength(1)
        expect(entriesAfterUserEntry[0]?.id).toBe('user-turn-1')
        expect(entriesAfterUserEntry[0]?.kind === 'user' ? entriesAfterUserEntry[0].content : undefined).toEqual([{ type: 'text', text: 'Desktop edited first message' }])

        // Desktop streams new assistant response
        await act(async () => {
            emitNative({
                kind: 'session:stream-event',
                data: JSON.stringify({
                    sessionId: syncSessionId,
                    runId: 'desktop-edit-run-1',
                    event: {
                        type: 'assistant-start',
                        sessionId: syncSessionId,
                        runId: 'desktop-edit-run-1',
                        entry: {
                            id: 'asst-new-stream',
                            sessionId: syncSessionId,
                            createdAt: 300,
                            kind: 'assistant',
                            status: 'streaming',
                            content: [{ type: 'text', text: 'Streaming new answer...' }],
                        },
                    },
                }),
            })
        })

        const entriesDuringStream = useMessageStore.getState().getEntries(syncSessionId)
        expect(entriesDuringStream).toHaveLength(2)
        expect(entriesDuringStream.map((e) => e.id)).toEqual(['user-turn-1', 'asst-new-stream'])

        // Desktop finishes run
        await act(async () => {
            emitNative({
                kind: 'session:stream-event',
                data: JSON.stringify({
                    sessionId: syncSessionId,
                    runId: 'desktop-edit-run-1',
                    event: {
                        type: 'agent-end',
                        sessionId: syncSessionId,
                        runId: 'desktop-edit-run-1',
                        entries: [
                            {
                                id: 'user-turn-1',
                                sessionId: syncSessionId,
                                createdAt: 100,
                                kind: 'user',
                                content: [{ type: 'text', text: 'Desktop edited first message' }],
                            },
                            {
                                id: 'asst-new-stream',
                                sessionId: syncSessionId,
                                createdAt: 300,
                                kind: 'assistant',
                                status: 'done',
                                stopReason: 'stop',
                                content: [{ type: 'text', text: 'Final new answer' }],
                            },
                        ],
                    },
                }),
            })
        })

        const finalEntries = useMessageStore.getState().getEntries(syncSessionId)
        expect(finalEntries).toHaveLength(2)
        expect(finalEntries.map((e) => e.id)).toEqual(['user-turn-1', 'asst-new-stream'])
        expect(finalEntries[0]?.kind === 'user' ? finalEntries[0].content : undefined).toEqual([{ type: 'text', text: 'Desktop edited first message' }])
        expect(finalEntries[1]?.kind === 'assistant' ? finalEntries[1].content : undefined).toEqual([{ type: 'text', text: 'Final new answer' }])
    })

    it('receiving session:delegate-run in Desktop environment starts local send() execution as Host', async () => {
        renderHook(() => useAgentStream(), {
            wrapper: createWrapper(service),
        })

        expect(nativeEventListeners).toHaveLength(1)
        const emitNative = nativeEventListeners[0]!

        const delegatedSessionId = 'delegated-web-session-1'

        await act(async () => {
            emitNative({
                kind: 'session:delegate-run',
                data: JSON.stringify({
                    sessionId: delegatedSessionId,
                    text: 'Run this on desktop host',
                    projectId: 'proj-123',
                    branch: 'main',
                }),
            })
        })

        // Host executes send(...) and runs streamChat
        await waitFor(() => {
            expect(service.streamChatCalls.length).toBeGreaterThanOrEqual(1)
        })

        const call = service.streamChatCalls[0]!
        expect(call.sessionId).toBe(delegatedSessionId)
        expect(call.userEntry?.sessionId).toBe(delegatedSessionId)
        const textBlock = call.userEntry?.content.find((c) => c.type === 'text')
        expect(textBlock?.text).toBe('Run this on desktop host')

        // Host broadcasts run status and stream events
        expect(broadcastRunStatusMock).toHaveBeenCalled()
        expect(broadcastStreamEventMock).toHaveBeenCalled()
    })

    it('keeps the Web runtime settings snapshot when shared session state changes during delegation', async () => {
        useSettingsStore.getState().hydrate({
            modelId: 'gpt-5.6-sol',
            reasoningLevel: 'xhigh',
            speed: 'standard',
        })
        const prepareInputs: AgentPrepareInput[] = []
        service.prepareImpl = async (input) => {
            prepareInputs.push(input)
            return makePrepared()
        }

        renderHook(() => useAgentStream(), {
            wrapper: createWrapper(service),
        })

        const emitNative = nativeEventListeners[0]!
        const delegatedSessionId = 'delegated-web-runtime-settings'

        await act(async () => {
            emitNative({
                kind: 'session:delegate-run',
                data: JSON.stringify({
                    sessionId: delegatedSessionId,
                    text: 'Run with the Web-selected model',
                    modelId: 'gemini-3.8-flash',
                    reasoningEffort: 'high',
                    speed: 'fast',
                }),
            })
            useSessionStore.getState().setSessionRuntimeSettings(delegatedSessionId, {
                modelId: 'gpt-5.6-sol',
                reasoningEffort: 'xhigh',
                speed: 'standard',
            })
        })

        await waitFor(() => {
            expect(prepareInputs).toHaveLength(1)
        })

        expect(prepareInputs[0]).toMatchObject({
            modelId: 'gemini-3.8-flash',
            reasoningLevel: 'high',
            speed: 'fast',
        })
        expect(
            useSessionStore.getState().sessions.find((session) => session.id === delegatedSessionId),
        ).toMatchObject({
            modelId: 'gemini-3.8-flash',
            reasoningEffort: 'high',
            speed: 'fast',
        })
        expect(useSettingsStore.getState().settings).toMatchObject({
            modelId: 'gpt-5.6-sol',
            reasoningLevel: 'xhigh',
            speed: 'standard',
        })
    })

    it('session:delegate-run in browser environment is ignored', async () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
            configurable: true,
        })

        renderHook(() => useAgentStream(), {
            wrapper: createWrapper(service),
        })

        const emitNative = nativeEventListeners[0]!
        act(() => {
            emitNative({
                kind: 'session:delegate-run',
                data: JSON.stringify({
                    sessionId: 'web-sess-ignore',
                    text: 'Ignore me on browser',
                }),
            })
        })

        expect(service.streamChatCalls).toHaveLength(0)
    })

    it('Desktop does not duplicate user entry when receiving session:delegate-run with userEntryId that was already in messageStore or appended', async () => {
        renderHook(() => useAgentStream(), {
            wrapper: createWrapper(service),
        })

        const emitNative = nativeEventListeners[0]!
        const delegatedSessionId = 'sess-dedup-1'
        const existingUserEntryId = 'user-entry-preset-1'
        const retryStartedAt = 2000

        // Pre-populate userEntry in messageStore
        useMessageStore.getState().replaceSessionEntries(delegatedSessionId, [
            {
                id: existingUserEntryId,
                sessionId: delegatedSessionId,
                createdAt: 1000,
                kind: 'user',
                content: [{ type: 'text', text: 'Pre-existing user message' }],
            },
        ])

        await act(async () => {
            emitNative({
                kind: 'session:delegate-run',
                data: JSON.stringify({
                    sessionId: delegatedSessionId,
                    text: 'Pre-existing user message',
                    userEntryId: existingUserEntryId,
                    userEntryCreatedAt: retryStartedAt,
                }),
            })
        })

        await waitFor(() => {
            expect(service.streamChatCalls.length).toBeGreaterThanOrEqual(1)
        })

        const entries = useMessageStore.getState().getEntries(delegatedSessionId)
        // Should have exactly 1 user entry, not 2
        const userEntries = entries.filter((e) => e.kind === 'user')
        expect(userEntries).toHaveLength(1)
        expect(userEntries[0]?.id).toBe(existingUserEntryId)
        expect(userEntries[0]?.createdAt).toBe(retryStartedAt)
        expect(service.streamChatCalls[0]?.userEntry?.id).toBe(existingUserEntryId)
    })

    it('pure image delegation (text: \'\' with images) is accepted and executed by Desktop', async () => {
        renderHook(() => useAgentStream(), {
            wrapper: createWrapper(service),
        })

        const emitNative = nativeEventListeners[0]!
        const delegatedSessionId = 'sess-pure-img-1'

        await act(async () => {
            emitNative({
                kind: 'session:delegate-run',
                data: JSON.stringify({
                    sessionId: delegatedSessionId,
                    text: '',
                    images: [
                        {
                            data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
                            mimeType: 'image/png',
                            name: 'pixel.png',
                        },
                    ],
                }),
            })
        })

        await waitFor(() => {
            expect(service.streamChatCalls.length).toBeGreaterThanOrEqual(1)
        })

        const call = service.streamChatCalls[0]!
        expect(call.sessionId).toBe(delegatedSessionId)
        expect(call.userEntry?.sessionId).toBe(delegatedSessionId)
        const imageBlock = call.userEntry?.content.find((c) => c.type === 'image')
        expect(imageBlock).toBeTruthy()

        const entries = useMessageStore.getState().getEntries(delegatedSessionId)
        expect(entries).toHaveLength(1)
        expect(entries[0]?.kind).toBe('user')
    })

    it('Desktop loads session via ensureSessionLoaded when handling editMessageId delegation', async () => {
        const delegatedSessionId = 'sess-edit-load-1'
        const targetEditId = 'user-to-edit-1'

        // Session not in messageStore memory initially, but SessionGet returns it
        const sessionGetMock = vi.fn().mockResolvedValue({
            entries: [
                {
                    id: targetEditId,
                    sessionId: delegatedSessionId,
                    createdAt: 1000,
                    kind: 'user',
                    content: [{ type: 'text', text: 'Original question' }],
                },
                {
                    id: 'asst-1',
                    sessionId: delegatedSessionId,
                    createdAt: 2000,
                    kind: 'assistant',
                    content: [{ type: 'text', text: 'Old answer' }],
                    stopReason: 'stop',
                    status: 'done',
                },
            ],
        })
        setHostBridge({
            SessionBroadcastRunStatus: broadcastRunStatusMock,
            SessionBroadcastStreamEvent: broadcastStreamEventMock,
            SessionAbortRun: abortRunMock,
            SessionDelegateRun: delegateRunMock,
            SessionGet: sessionGetMock,
            onNativeEvent: vi.fn((cb: (event: any) => void) => {
                nativeEventListeners.push(cb)
                return () => {
                    const idx = nativeEventListeners.indexOf(cb)
                    if (idx >= 0) nativeEventListeners.splice(idx, 1)
                }
            }),
        } as any)

        renderHook(() => useAgentStream(), {
            wrapper: createWrapper(service),
        })

        const emitNative = nativeEventListeners[0]!

        await act(async () => {
            emitNative({
                kind: 'session:delegate-run',
                data: JSON.stringify({
                    sessionId: delegatedSessionId,
                    text: 'Edited question',
                    editMessageId: targetEditId,
                }),
            })
        })

        await waitFor(() => {
            expect(service.streamChatCalls.length).toBeGreaterThanOrEqual(1)
        })

        expect(sessionGetMock).toHaveBeenCalledWith(delegatedSessionId)

        const call = service.streamChatCalls[0]!
        expect(call.sessionId).toBe(delegatedSessionId)
        expect(call.userEntry?.id).toBe(targetEditId)
        const textBlock = call.userEntry?.content.find((c) => c.type === 'text')
        expect(textBlock?.text).toBe('Edited question')

        // Older assistant entry discarded, only edited user entry remains
        const entries = useMessageStore.getState().getEntries(delegatedSessionId)
        expect(entries).toHaveLength(1)
        expect(entries[0]?.id).toBe(targetEditId)
    })

    it('Desktop retains currentSessionId and adds remote session when receiving session:delegate-run for unknown session', async () => {
        useSessionStore.getState().hydrate({
            sessions: [
                {
                    id: 'desktop-current-sess',
                    title: 'Desktop Active Session',
                    pinned: false,
                    createdAt: 100,
                    updatedAt: 100,
                },
            ],
            currentSessionId: 'desktop-current-sess',
        })

        renderHook(() => useAgentStream(), {
            wrapper: createWrapper(service),
        })

        const emitNative = nativeEventListeners[0]!
        const delegatedSessionId = 'sess-web-remote'

        await act(async () => {
            emitNative({
                kind: 'session:delegate-run',
                data: JSON.stringify({
                    sessionId: delegatedSessionId,
                    text: 'Remote web run prompt',
                    projectId: 'proj-remote',
                    branch: 'feat-remote',
                }),
            })
        })

        await waitFor(() => {
            expect(service.streamChatCalls.length).toBeGreaterThanOrEqual(1)
        })

        const sessionState = useSessionStore.getState()
        expect(sessionState.currentSessionId).toBe('desktop-current-sess')
        const addedSession = sessionState.sessions.find((s) => s.id === delegatedSessionId)
        expect(addedSession).toBeDefined()
        expect(addedSession?.projectId).toBe('proj-remote')
        expect(addedSession?.branch).toBe('feat-remote')
    })

    it('Desktop session:delegate-run catches error during preflight/send, broadcasts idle status, and pushes toast', async () => {
        service.prepareImpl = async () => {
            throw new Error('Preflight validation error')
        }

        renderHook(() => useAgentStream(), {
            wrapper: createWrapper(service),
        })

        const emitNative = nativeEventListeners[0]!
        const delegatedSessionId = 'sess-err-delegate'

        await act(async () => {
            emitNative({
                kind: 'session:delegate-run',
                data: JSON.stringify({
                    sessionId: delegatedSessionId,
                    text: 'Failing prompt',
                }),
            })
        })

        await waitFor(() => {
            expect(broadcastRunStatusMock).toHaveBeenCalledWith(
                delegatedSessionId,
                'idle',
                '',
                '',
            )
        })

        const toasts = useUiStore.getState().toasts
        expect(toasts.length).toBeGreaterThanOrEqual(1)
        expect(toasts.some((t) => t.message.includes('Preflight validation error'))).toBe(true)
    })

    it('Mirror mode receives session:subagent-state and synchronizes useSubAgentStore', async () => {
        useSubAgentStore.setState({ agents: [] })
        renderHook(() => useAgentStream(), {
            wrapper: createWrapper(service),
        })

        const emitNative = nativeEventListeners[0]!
        const subAgent = {
            id: 'subagent-sync-1',
            sessionId: 'subagent-sync-1',
            parentSessionId: 'sess-parent-1',
            name: 'SubWorker',
            status: 'running' as const,
            icon: 'sparkle' as const,
            color: '#7c3aed',
            modelId: 'test-model',
            createdAt: 100,
            updatedAt: 200,
        }

        await act(async () => {
            emitNative({
                kind: 'session:subagent-state',
                data: JSON.stringify({
                    parentSessionId: 'sess-parent-1',
                    agents: [subAgent],
                }),
            })
        })

        const agents = useSubAgentStore.getState().agents
        expect(agents).toHaveLength(1)
        expect(agents[0]?.id).toBe('subagent-sync-1')
        expect(agents[0]?.status).toBe('running')
        expect(agents[0]?.name).toBe('SubWorker')
    })

    it('Mirror mode receives subagent session:stream-event and updates useMessageStore', async () => {
        const subAgent = {
            id: 'subagent-child-1',
            sessionId: 'subagent-child-1',
            parentSessionId: 'sess-current',
            name: 'ChildWorker',
            status: 'running' as const,
            icon: 'sparkle' as const,
            color: '#7c3aed',
            modelId: 'test-model',
            createdAt: 100,
            updatedAt: 200,
        }
        useSubAgentStore.setState({ agents: [subAgent] })
        useSessionStore.setState({
            sessions: [{ id: 'sess-current', title: 'Main Session', pinned: false, createdAt: 100, updatedAt: 100 }],
            currentSessionId: 'sess-current',
        })

        renderHook(() => useAgentStream(), {
            wrapper: createWrapper(service),
        })

        const emitNative = nativeEventListeners[0]!

        act(() => {
            emitNative({
                kind: 'session:stream-event',
                data: JSON.stringify({
                    sessionId: 'subagent-child-1',
                    runId: 'sub-run-1',
                    event: {
                        type: 'agent-start',
                        sessionId: 'subagent-child-1',
                        runId: 'sub-run-1',
                    },
                }),
            })
            emitNative({
                kind: 'session:stream-event',
                data: JSON.stringify({
                    sessionId: 'subagent-child-1',
                    runId: 'sub-run-1',
                    event: {
                        type: 'assistant-start',
                        sessionId: 'subagent-child-1',
                        runId: 'sub-run-1',
                        entry: {
                            id: 'msg-sub-1',
                            sessionId: 'subagent-child-1',
                            createdAt: 1000,
                            kind: 'assistant',
                            content: [{ type: 'text', text: 'Hello' }],
                        },
                    },
                }),
            })
            emitNative({
                kind: 'session:stream-event',
                data: JSON.stringify({
                    sessionId: 'subagent-child-1',
                    runId: 'sub-run-1',
                    event: {
                        type: 'assistant-update',
                        sessionId: 'subagent-child-1',
                        runId: 'sub-run-1',
                        entry: {
                            id: 'msg-sub-1',
                            sessionId: 'subagent-child-1',
                            createdAt: 1000,
                            kind: 'assistant',
                            content: [{ type: 'text', text: 'Hello from subagent' }],
                        },
                    },
                }),
            })
        })

        const subEntries = useMessageStore.getState().getEntries('subagent-child-1')
        expect(subEntries.length).toBeGreaterThanOrEqual(1)
        const assistantEntry = subEntries.find((e) => e.kind === 'assistant')
        expect(assistantEntry).toBeDefined()
        const textBlock = assistantEntry?.content.find((c) => c.type === 'text')
        expect(textBlock?.text).toBe('Hello from subagent')
    })

    it('optimistically sets session run status to running in browser environment upon send', async () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
            configurable: true,
        })

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: createWrapper(service),
        })

        let delegatedSessionId: string | null = null
        await act(async () => {
            delegatedSessionId = await result.current.send({
                text: 'Optimistic run test',
                projectId: 'test-proj',
            })
        })

        expect(delegatedSessionId).toBeTruthy()
        const runState = useSessionRunStore.getState().activeRuns[delegatedSessionId!]
        expect(runState).toBeDefined()
        expect(runState?.status).toBe('running')
        expect(runState?.clientId).toBe('browser-local')
    })

    it('rolls back optimistic run status if SessionDelegateRun throws an error', async () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
            configurable: true,
        })

        delegateRunMock.mockRejectedValueOnce(new Error('Network error'))

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: createWrapper(service),
        })

        let errorCaught: any = null
        await act(async () => {
            try {
                await result.current.send({
                    text: 'Failing delegation test',
                    projectId: 'test-proj',
                })
            } catch (err) {
                errorCaught = err
            }
        })

        expect(errorCaught).toBeDefined()
        const runs = useSessionRunStore.getState().activeRuns
        const optimisticRuns = Object.values(runs).filter((r) => r.clientId === 'browser-local')
        expect(optimisticRuns).toHaveLength(0)
    })

    it('does not clear run status on delegation error if remote run has already replaced optimistic runId', async () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
            configurable: true,
        })

        const targetSessionId = 'sess-concurrent-replace'
        delegateRunMock.mockImplementationOnce(async () => {
            // Simulate concurrent arrival of real host run status before delegation call rejects
            useSessionRunStore.getState().setRun(targetSessionId, {
                sessionId: targetSessionId,
                status: 'running',
                runId: 'real-host-run-456',
                clientId: 'desktop-main',
                updatedAt: Date.now(),
            })
            throw new Error('Late network error')
        })

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: createWrapper(service),
        })

        await act(async () => {
            try {
                await result.current.send({
                    sessionId: targetSessionId,
                    text: 'Failing delegation test',
                })
            } catch {
                // Expected error
            }
        })

        // Real host run must NOT be cleared by the rollback
        const runState = useSessionRunStore.getState().activeRuns[targetSessionId]
        expect(runState).toBeDefined()
        expect(runState?.runId).toBe('real-host-run-456')
        expect(runState?.clientId).toBe('desktop-main')
    })

    it('claims and executes pending delegate runs from host on mount', async () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) CPA/1.0.0 Chrome/120.0.0.0 Electron/28.0.0 Safari/537.36',
            configurable: true,
        })

        const earlySessionId = 'early-claim-sess'
        const claimPendingMock = vi.fn().mockResolvedValue([
            {
                sessionId: earlySessionId,
                text: 'Claim and execute early prompt',
                userEntryId: 'early-user-entry',
            },
        ])
        const ackMock = vi.fn().mockResolvedValue(undefined)

        setHostBridge({
            SessionBroadcastRunStatus: broadcastRunStatusMock,
            SessionBroadcastStreamEvent: broadcastStreamEventMock,
            SessionAbortRun: abortRunMock,
            SessionDelegateRun: delegateRunMock,
            SessionClaimPendingDelegateRuns: claimPendingMock,
            SessionAckDelegateRun: ackMock,
            onNativeEvent: vi.fn((cb: (event: any) => void) => {
                nativeEventListeners.push(cb)
                return () => {
                    const idx = nativeEventListeners.indexOf(cb)
                    if (idx >= 0) nativeEventListeners.splice(idx, 1)
                }
            }),
        } as any)

        const freshService = new FakeSyncService()
        renderHook(() => useAgentStream(), {
            wrapper: createWrapper(freshService),
        })

        await waitFor(() => {
            expect(claimPendingMock).toHaveBeenCalled()
            expect(freshService.streamChatCalls.length).toBeGreaterThanOrEqual(1)
            expect(ackMock).toHaveBeenCalledWith('early-user-entry')
        })

        expect(freshService.streamChatCalls[0]?.sessionId).toBe(earlySessionId)
    })

    it('deduplicates when claim and native event deliver the same delegate request', async () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) CPA/1.0.0 Chrome/120.0.0.0 Electron/28.0.0 Safari/537.36',
            configurable: true,
        })

        const duplicateSessionId = 'interleaved-claim-sess'
        const interleavedReq = {
            sessionId: duplicateSessionId,
            text: 'Interleaved prompt',
            userEntryId: 'interleaved-user-entry',
        }

        const claimPendingMock = vi.fn().mockResolvedValue([interleavedReq])
        const ackMock = vi.fn().mockResolvedValue(undefined)

        setHostBridge({
            SessionBroadcastRunStatus: broadcastRunStatusMock,
            SessionBroadcastStreamEvent: broadcastStreamEventMock,
            SessionAbortRun: abortRunMock,
            SessionDelegateRun: delegateRunMock,
            SessionClaimPendingDelegateRuns: claimPendingMock,
            SessionAckDelegateRun: ackMock,
            onNativeEvent: vi.fn((cb: (event: any) => void) => {
                nativeEventListeners.push(cb)
                return () => {
                    const idx = nativeEventListeners.indexOf(cb)
                    if (idx >= 0) nativeEventListeners.splice(idx, 1)
                }
            }),
        } as any)

        const freshService = new FakeSyncService()
        renderHook(() => useAgentStream(), {
            wrapper: createWrapper(freshService),
        })

        // Also emit native event concurrently with the same userEntryId
        const emitNative = nativeEventListeners[0]!
        await act(async () => {
            emitNative({
                kind: 'session:delegate-run',
                data: JSON.stringify(interleavedReq),
            })
        })

        await waitFor(() => {
            expect(freshService.streamChatCalls.length).toBeGreaterThanOrEqual(1)
        })

        // Must be executed exactly once despite being delivered via both claim and native event
        expect(freshService.streamChatCalls).toHaveLength(1)
        expect(freshService.streamChatCalls[0]?.sessionId).toBe(duplicateSessionId)
    })

    it('deduplicates based on requestId even without sessionId or userEntryId', async () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) CPA/1.0.0 Chrome/120.0.0.0 Electron/28.0.0 Safari/537.36',
            configurable: true,
        })

        const reqWithId = {
            requestId: 'custom-req-id-123',
            text: 'Unique request text',
        }

        const claimPendingMock = vi.fn().mockResolvedValue([reqWithId])
        const ackMock = vi.fn().mockResolvedValue(undefined)

        setHostBridge({
            SessionBroadcastRunStatus: broadcastRunStatusMock,
            SessionBroadcastStreamEvent: broadcastStreamEventMock,
            SessionAbortRun: abortRunMock,
            SessionDelegateRun: delegateRunMock,
            SessionClaimPendingDelegateRuns: claimPendingMock,
            SessionAckDelegateRun: ackMock,
            onNativeEvent: vi.fn((cb: (event: any) => void) => {
                nativeEventListeners.push(cb)
                return () => {
                    const idx = nativeEventListeners.indexOf(cb)
                    if (idx >= 0) nativeEventListeners.splice(idx, 1)
                }
            }),
        } as any)

        const freshService = new FakeSyncService()
        renderHook(() => useAgentStream(), {
            wrapper: createWrapper(freshService),
        })

        const emitNative = nativeEventListeners[0]!
        await act(async () => {
            emitNative({
                kind: 'session:delegate-run',
                data: JSON.stringify(reqWithId),
            })
        })

        await waitFor(() => {
            expect(freshService.streamChatCalls).toHaveLength(1)
            expect(ackMock).toHaveBeenCalledWith('custom-req-id-123')
        })
    })

    it('re-claims and executes unacknowledged requests when runtime is remounted after early disposal', async () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) CPA/1.0.0 Chrome/120.0.0.0 Electron/28.0.0 Safari/537.36',
            configurable: true,
        })

        const retryReq = {
            requestId: 'unacked-req-456',
            sessionId: 'unacked-sess-456',
            text: 'Unacked prompt that must survive reload',
        }

        let pendingInMain = [retryReq]
        const claimPendingMock = vi.fn().mockImplementation(async () => [...pendingInMain])
        const ackMock = vi.fn().mockImplementation(async (id: string) => {
            pendingInMain = pendingInMain.filter((r) => r.requestId !== id && r.sessionId !== id)
        })

        setHostBridge({
            SessionBroadcastRunStatus: broadcastRunStatusMock,
            SessionBroadcastStreamEvent: broadcastStreamEventMock,
            SessionAbortRun: abortRunMock,
            SessionDelegateRun: delegateRunMock,
            SessionClaimPendingDelegateRuns: claimPendingMock,
            SessionAckDelegateRun: ackMock,
            onNativeEvent: vi.fn((cb: (event: any) => void) => {
                nativeEventListeners.push(cb)
                return () => {
                    const idx = nativeEventListeners.indexOf(cb)
                    if (idx >= 0) nativeEventListeners.splice(idx, 1)
                }
            }),
        } as any)

        // 1. Mount first instance but simulate dispose before handler can run
        const firstService = new FakeSyncService()
        const { unmount } = renderHook(() => useAgentStream(), {
            wrapper: createWrapper(firstService),
        })

        // Dispose first instance immediately (e.g. window reload)
        unmount()
        await disposeAgentRuntime(firstService)

        // Request was NOT acknowledged, so pendingInMain still holds retryReq
        expect(pendingInMain).toHaveLength(1)

        // 2. Remount fresh instance (e.g. reloaded window)
        const secondService = new FakeSyncService()
        renderHook(() => useAgentStream(), {
            wrapper: createWrapper(secondService),
        })

        await waitFor(() => {
            expect(secondService.streamChatCalls.length).toBeGreaterThanOrEqual(1)
            expect(ackMock).toHaveBeenCalledWith('unacked-req-456')
            expect(pendingInMain).toHaveLength(0)
        })

        expect(secondService.streamChatCalls[0]?.sessionId).toBe('unacked-sess-456')
    })

    it('re-sends ACK without re-executing when a previously executed request is re-delivered', async () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) CPA/1.0.0 Chrome/120.0.0.0 Electron/28.0.0 Safari/537.36',
            configurable: true,
        })

        const req = {
            requestId: 'already-executed-req',
            sessionId: 'already-executed-sess',
            text: 'Already executed prompt',
        }

        const ackMock = vi.fn().mockResolvedValue(undefined)
        setHostBridge({
            SessionBroadcastRunStatus: broadcastRunStatusMock,
            SessionBroadcastStreamEvent: broadcastStreamEventMock,
            SessionAbortRun: abortRunMock,
            SessionDelegateRun: delegateRunMock,
            SessionClaimPendingDelegateRuns: vi.fn().mockResolvedValue([]),
            SessionAckDelegateRun: ackMock,
            onNativeEvent: vi.fn((cb: (event: any) => void) => {
                nativeEventListeners.push(cb)
                return () => {
                    const idx = nativeEventListeners.indexOf(cb)
                    if (idx >= 0) nativeEventListeners.splice(idx, 1)
                }
            }),
        } as any)

        const freshService = new FakeSyncService()
        renderHook(() => useAgentStream(), {
            wrapper: createWrapper(freshService),
        })

        const emitNative = nativeEventListeners[0]!

        // First delivery: executes and ACKs
        await act(async () => {
            emitNative({
                kind: 'session:delegate-run',
                data: JSON.stringify(req),
            })
        })

        await waitFor(() => {
            expect(freshService.streamChatCalls).toHaveLength(1)
            expect(ackMock).toHaveBeenCalledWith('already-executed-req')
        })

        ackMock.mockClear()

        // Second delivery of the same request: re-sends ACK but does NOT re-execute
        await act(async () => {
            emitNative({
                kind: 'session:delegate-run',
                data: JSON.stringify(req),
            })
        })

        await waitFor(() => {
            expect(ackMock).toHaveBeenCalledWith('already-executed-req')
        })

        // Stream chat calls must still be 1 (no duplicate execution)
        expect(freshService.streamChatCalls).toHaveLength(1)
    })

    it('does not prematurely ACK in-flight request when duplicate delivery arrives while first execution is pending', async () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) CPA/1.0.0 Chrome/120.0.0.0 Electron/28.0.0 Safari/537.36',
            configurable: true,
        })

        const req = {
            requestId: 'in-flight-req',
            sessionId: 'in-flight-sess',
            text: 'In-flight test prompt',
        }

        const ackMock = vi.fn().mockResolvedValue(undefined)
        setHostBridge({
            SessionBroadcastRunStatus: broadcastRunStatusMock,
            SessionBroadcastStreamEvent: broadcastStreamEventMock,
            SessionAbortRun: abortRunMock,
            SessionDelegateRun: delegateRunMock,
            SessionClaimPendingDelegateRuns: vi.fn().mockResolvedValue([]),
            SessionAckDelegateRun: ackMock,
            onNativeEvent: vi.fn((cb: (event: any) => void) => {
                nativeEventListeners.push(cb)
                return () => {
                    const idx = nativeEventListeners.indexOf(cb)
                    if (idx >= 0) nativeEventListeners.splice(idx, 1)
                }
            }),
        } as any)

        let resolveSend: (() => void) | undefined
        const sendGate = new Promise<void>((resolve) => {
            resolveSend = resolve
        })

        let firstDeliveryStarted = false
        const blockingService = new FakeSyncService()
        // Inject blocking promise into streamChat
        const originalStreamChat = blockingService.streamChat.bind(blockingService)
        blockingService.streamChat = async function* (options: any) {
            firstDeliveryStarted = true
            await sendGate
            yield* originalStreamChat(options)
        }

        const { unmount } = renderHook(() => useAgentStream(), {
            wrapper: createWrapper(blockingService),
        })

        const emitNative = nativeEventListeners[0]!

        // 1. First delivery starts and blocks in-flight
        act(() => {
            emitNative({
                kind: 'session:delegate-run',
                data: JSON.stringify(req),
            })
        })

        await waitFor(() => {
            expect(firstDeliveryStarted).toBe(true)
        })

        // 2. Second delivery arrives while first is still in-flight
        act(() => {
            emitNative({
                kind: 'session:delegate-run',
                data: JSON.stringify(req),
            })
        })

        // Must NOT have acknowledged in-flight-req yet because first execution is still in-flight
        expect(ackMock).not.toHaveBeenCalledWith('in-flight-req')

        // 3. Complete first execution
        await act(async () => {
            resolveSend?.()
        })

        await waitFor(() => {
            expect(ackMock).toHaveBeenCalledWith('in-flight-req')
        })

        // Executed only once
        expect(blockingService.streamChatCalls).toHaveLength(1)
        unmount()
    })

    it('invokes onRunFinish and sends ACK when a steer delegation completes with the active session', async () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) CPA/1.0.0 Chrome/120.0.0.0 Electron/28.0.0 Safari/537.36',
            configurable: true,
        })

        const ackMock = vi.fn().mockResolvedValue(undefined)
        setHostBridge({
            SessionBroadcastRunStatus: broadcastRunStatusMock,
            SessionBroadcastStreamEvent: broadcastStreamEventMock,
            SessionAbortRun: abortRunMock,
            SessionDelegateRun: delegateRunMock,
            SessionClaimPendingDelegateRuns: vi.fn().mockResolvedValue([]),
            SessionAckDelegateRun: ackMock,
            onNativeEvent: vi.fn((cb: (event: any) => void) => {
                nativeEventListeners.push(cb)
                return () => {
                    const idx = nativeEventListeners.indexOf(cb)
                    if (idx >= 0) nativeEventListeners.splice(idx, 1)
                }
            }),
        } as any)

        let releaseHold: () => void = () => {}
        service.streamHold = new Promise<void>((resolve) => {
            releaseHold = resolve
        })

        const { result } = renderHook(() => useAgentStream(), {
            wrapper: createWrapper(service),
        })

        await waitFor(() => {
            expect(result.current).not.toBeNull()
        })

        // 1. Start initial host run
        let hostSessionId: string | null = null
        await act(async () => {
            hostSessionId = await result.current.send('Initial host message')
        })

        expect(hostSessionId).toBeTruthy()
        expect(result.current.isStreaming).toBe(true)

        // 2. Deliver steer delegation while session is actively running
        const steerReq = {
            requestId: 'steer-req-1',
            sessionId: hostSessionId,
            text: 'Steer prompt message',
        }

        const emitNative = nativeEventListeners[0]!
        await act(async () => {
            emitNative({
                kind: 'session:delegate-run',
                data: JSON.stringify(steerReq),
            })
        })

        // Steer should be accepted but not yet ACKed since stream is still open
        expect(ackMock).not.toHaveBeenCalledWith('steer-req-1')

        // 3. Complete stream execution
        service.streamHold = null
        releaseHold()

        // Steer request must be successfully acknowledged on stream finish
        await waitFor(() => {
            expect(ackMock).toHaveBeenCalledWith('steer-req-1')
        })
    })

    it('sends ACK and marks completed when preflight fails so request does not leak in pending queue', async () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) CPA/1.0.0 Chrome/120.0.0.0 Electron/28.0.0 Safari/537.36',
            configurable: true,
        })

        const ackMock = vi.fn().mockResolvedValue(undefined)
        setHostBridge({
            SessionBroadcastRunStatus: broadcastRunStatusMock,
            SessionBroadcastStreamEvent: broadcastStreamEventMock,
            SessionAbortRun: abortRunMock,
            SessionDelegateRun: delegateRunMock,
            SessionClaimPendingDelegateRuns: vi.fn().mockResolvedValue([]),
            SessionAckDelegateRun: ackMock,
            onNativeEvent: vi.fn((cb: (event: any) => void) => {
                nativeEventListeners.push(cb)
                return () => {
                    const idx = nativeEventListeners.indexOf(cb)
                    if (idx >= 0) nativeEventListeners.splice(idx, 1)
                }
            }),
        } as any)

        const failingService = new FakeSyncService()
        failingService.prepareImpl = async () => {
            throw new Error('Preflight validation failed')
        }

        const { unmount } = renderHook(() => useAgentStream(), {
            wrapper: createWrapper(failingService),
        })

        const emitNative = nativeEventListeners[0]!
        await act(async () => {
            emitNative({
                kind: 'session:delegate-run',
                data: JSON.stringify({
                    requestId: 'failing-preflight-req',
                    sessionId: 'fail-sess-1',
                    text: 'Failing preflight text',
                }),
            })
        })

        // Even though preflight failed, the request must be ACKed to clean up the queue in main process
        await waitFor(() => {
            expect(ackMock).toHaveBeenCalledWith('failing-preflight-req')
        })

        const preflightAckCalls = ackMock.mock.calls.filter(
            (c: any[]) => c[0] === 'failing-preflight-req',
        )
        expect(preflightAckCalls).toHaveLength(1)

        unmount()
    })

    it('does not ACK queued delegation when active session completes until queued execution finishes', async () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) CPA/1.0.0 Chrome/120.0.0.0 Electron/28.0.0 Safari/537.36',
            configurable: true,
        })

        const ackMock = vi.fn().mockResolvedValue(undefined)
        setHostBridge({
            SessionBroadcastRunStatus: broadcastRunStatusMock,
            SessionBroadcastStreamEvent: broadcastStreamEventMock,
            SessionAbortRun: abortRunMock,
            SessionDelegateRun: delegateRunMock,
            SessionClaimPendingDelegateRuns: vi.fn().mockResolvedValue([]),
            SessionAckDelegateRun: ackMock,
            onNativeEvent: vi.fn((cb: (event: any) => void) => {
                nativeEventListeners.push(cb)
                return () => {
                    const idx = nativeEventListeners.indexOf(cb)
                    if (idx >= 0) nativeEventListeners.splice(idx, 1)
                }
            }),
        } as any)

        let releaseFirstHold: () => void = () => {}
        const firstHold = new Promise<void>((resolve) => {
            releaseFirstHold = resolve
        })

        let releaseQueuedHold: () => void = () => {}
        const queuedHold = new Promise<void>((resolve) => {
            releaseQueuedHold = resolve
        })

        let executionCount = 0
        const prepareInputs: AgentPrepareInput[] = []
        const queueTestingService = new FakeSyncService()
        queueTestingService.prepareImpl = async (input) => {
            prepareInputs.push(input)
            return makePrepared()
        }
        const originalStreamChat = queueTestingService.streamChat.bind(queueTestingService)
        queueTestingService.streamChat = async function* (options: any) {
            executionCount++
            if (executionCount === 1) {
                await firstHold
            } else {
                await queuedHold
            }
            yield* originalStreamChat(options)
        }

        const { result, unmount } = renderHook(() => useAgentStream(), {
            wrapper: createWrapper(queueTestingService),
        })

        await waitFor(() => {
            expect(result.current).not.toBeNull()
        })

        // 1. Start initial host run
        let hostSessionId: string | null = null
        await act(async () => {
            hostSessionId = await result.current.send('Initial host message')
        })

        expect(hostSessionId).toBeTruthy()
        expect(result.current.isStreaming).toBe(true)

        // 2. Deliver queue delegation while session is actively running (followUpMode: queue)
        const queueReq = {
            requestId: 'queued-req-1',
            sessionId: hostSessionId,
            text: 'Queued prompt message',
            modelId: 'gemini-3.8-flash',
            reasoningEffort: 'high',
            speed: 'fast' as const,
            followUpMode: 'queue' as const,
        }

        const emitNative = nativeEventListeners[0]!
        await act(async () => {
            emitNative({
                kind: 'session:delegate-run',
                data: JSON.stringify(queueReq),
            })
        })

        // Queued request must NOT be ACKed yet
        expect(ackMock).not.toHaveBeenCalledWith('queued-req-1')
        useSessionStore.getState().setSessionRuntimeSettings(hostSessionId!, {
            modelId: 'gpt-5.6-sol',
            reasoningEffort: 'xhigh',
            speed: 'standard',
        })

        // 3. Complete first stream
        await act(async () => {
            releaseFirstHold()
        })

        // Wait for first execution to finish and queued execution to start
        await waitFor(() => {
            expect(executionCount).toBe(2)
        })
        expect(prepareInputs[1]).toMatchObject({
            modelId: 'gemini-3.8-flash',
            reasoningLevel: 'high',
            speed: 'fast',
        })

        // Queued request must STILL NOT be ACKed because its execution is in flight!
        expect(ackMock).not.toHaveBeenCalledWith('queued-req-1')

        // 4. Now complete queued stream execution
        await act(async () => {
            releaseQueuedHold()
        })

        // Now queued request must be ACKed!
        await waitFor(() => {
            expect(ackMock).toHaveBeenCalledWith('queued-req-1')
        })

        unmount()
    })

    it('does not allow abort of old flight during message edit to clear finish callbacks of new flight', async () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) CPA/1.0.0 Chrome/120.0.0.0 Electron/28.0.0 Safari/537.36',
            configurable: true,
        })

        const ackMock = vi.fn().mockResolvedValue(undefined)
        setHostBridge({
            SessionBroadcastRunStatus: broadcastRunStatusMock,
            SessionBroadcastStreamEvent: broadcastStreamEventMock,
            SessionAbortRun: abortRunMock,
            SessionDelegateRun: delegateRunMock,
            SessionClaimPendingDelegateRuns: vi.fn().mockResolvedValue([]),
            SessionAckDelegateRun: ackMock,
            onNativeEvent: vi.fn((cb: (event: any) => void) => {
                nativeEventListeners.push(cb)
                return () => {
                    const idx = nativeEventListeners.indexOf(cb)
                    if (idx >= 0) nativeEventListeners.splice(idx, 1)
                }
            }),
        } as any)

        let releaseFirstHold: () => void = () => {}
        const firstHold = new Promise<void>((resolve) => {
            releaseFirstHold = resolve
        })

        let releaseSecondHold: () => void = () => {}
        const secondHold = new Promise<void>((resolve) => {
            releaseSecondHold = resolve
        })

        let runCount = 0
        const editService = new FakeSyncService()
        const originalStreamChat = editService.streamChat.bind(editService)
        editService.streamChat = async function* (options: any) {
            runCount++
            if (runCount === 1) {
                const abortedPromise = new Promise<'aborted'>((resolve) => {
                    options.signal?.addEventListener('abort', () => resolve('aborted'), { once: true })
                })
                const result = await Promise.race([firstHold, abortedPromise])
                if (result === 'aborted') {
                    yield { type: 'aborted', runId: options.runId, sessionId: options.sessionId }
                    return
                }
            } else {
                await secondHold
            }
            yield* originalStreamChat(options)
        }

        const { result, unmount } = renderHook(() => useAgentStream(), {
            wrapper: createWrapper(editService),
        })

        await waitFor(() => {
            expect(result.current).not.toBeNull()
        })

        // 1. Initial execution
        let hostSessionId: string | null = null
        await act(async () => {
            hostSessionId = await result.current.send('Initial prompt')
        })

        const entries = useMessageStore.getState().getEntries(hostSessionId!)
        const initialUserEntry = entries.find((e) => e.kind === 'user')!

        // 2. Deliver editMessageId delegation which interrupts old flight and starts new flight
        const editReq = {
            requestId: 'edit-req-1',
            sessionId: hostSessionId,
            editMessageId: initialUserEntry.id,
            text: 'Edited prompt text',
        }

        const emitNative = nativeEventListeners[0]!
        await act(async () => {
            emitNative({
                kind: 'session:delegate-run',
                data: JSON.stringify(editReq),
            })
        })

        // Release first hold so old stream finishes cleanup
        releaseFirstHold()

        // Wait until second run is actively streaming
        await waitFor(() => {
            expect(runCount).toBe(2)
        })

        // Edit request must not be prematurely ACKed or aborted as failure
        expect(ackMock).not.toHaveBeenCalledWith('edit-req-1')

        // 3. Complete second stream execution
        await act(async () => {
            releaseSecondHold()
        })

        // Second stream finish must successfully ACK edit-req-1
        await waitFor(() => {
            expect(ackMock).toHaveBeenCalledWith('edit-req-1')
        })

        unmount()
    })

    it('acknowledges steer delegation arriving during runPreparedChat resumption when flight completes', async () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) CPA/1.0.0 Chrome/120.0.0.0 Electron/28.0.0 Safari/537.36',
            configurable: true,
        })

        const ackMock = vi.fn().mockResolvedValue(undefined)
        setHostBridge({
            SessionBroadcastRunStatus: broadcastRunStatusMock,
            SessionBroadcastStreamEvent: broadcastStreamEventMock,
            SessionAbortRun: abortRunMock,
            SessionDelegateRun: delegateRunMock,
            SessionClaimPendingDelegateRuns: vi.fn().mockResolvedValue([]),
            SessionAckDelegateRun: ackMock,
            onNativeEvent: vi.fn((cb: (event: any) => void) => {
                nativeEventListeners.push(cb)
                return () => {
                    const idx = nativeEventListeners.indexOf(cb)
                    if (idx >= 0) nativeEventListeners.splice(idx, 1)
                }
            }),
        } as any)

        let releaseResumedHold: () => void = () => {}
        const resumedHold = new Promise<void>((resolve) => {
            releaseResumedHold = resolve
        })

        const resumeService = new FakeSyncService()
        const originalStreamChat = resumeService.streamChat.bind(resumeService)
        resumeService.streamChat = async function* (options: any) {
            await resumedHold
            yield* originalStreamChat(options)
        }

        // Setup session with pending user prompt to be resumed
        const sessId = 'resumable-session-1'
        const initialEntry: UserEntry = {
            id: 'u-init',
            sessionId: sessId,
            createdAt: Date.now() - 1000,
            kind: 'user',
            content: [{ type: 'text', text: 'Resumable prompt' }],
        }
        useMessageStore.getState().replaceSessionEntries(sessId, [initialEntry])
        useSessionStore.getState().upsertRemoteSession({
            id: sessId,
            title: 'Resumable Session',
            pinned: false,
            createdAt: Date.now() - 1000,
            updatedAt: Date.now() - 1000,
        })

        const { result, unmount } = renderHook(() => useAgentStream(sessId), {
            wrapper: createWrapper(resumeService),
        })

        await waitFor(() => {
            expect(result.current).not.toBeNull()
        })

        // 1. Resume chat via resumeSession() (which triggers runPreparedChat)
        let resumedSessionId: string | null = null
        await act(async () => {
            resumedSessionId = await result.current.resumeSession(sessId)
        })

        expect(resumedSessionId).toBe(sessId)
        expect(result.current.isStreaming).toBe(true)

        // 2. Deliver steer delegation during resumed flight
        const steerReq = {
            requestId: 'steer-during-resume',
            sessionId: sessId,
            text: 'Steer during resume prompt',
        }

        const emitNative = nativeEventListeners[0]!
        await act(async () => {
            emitNative({
                kind: 'session:delegate-run',
                data: JSON.stringify(steerReq),
            })
        })

        expect(ackMock).not.toHaveBeenCalledWith('steer-during-resume')

        // 3. Complete resumed flight
        await act(async () => {
            releaseResumedHold()
        })

        // Steer arriving during runPreparedChat must be ACKed on stream finish
        await waitFor(() => {
            expect(ackMock).toHaveBeenCalledWith('steer-during-resume')
        })

        unmount()
    })

    it('calls onRunFinish and sends ACK exactly once per request', async () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) CPA/1.0.0 Chrome/120.0.0.0 Electron/28.0.0 Safari/537.36',
            configurable: true,
        })

        const ackMock = vi.fn().mockResolvedValue(undefined)
        setHostBridge({
            SessionBroadcastRunStatus: broadcastRunStatusMock,
            SessionBroadcastStreamEvent: broadcastStreamEventMock,
            SessionAbortRun: abortRunMock,
            SessionDelegateRun: delegateRunMock,
            SessionClaimPendingDelegateRuns: vi.fn().mockResolvedValue([]),
            SessionAckDelegateRun: ackMock,
            onNativeEvent: vi.fn((cb: (event: any) => void) => {
                nativeEventListeners.push(cb)
                return () => {
                    const idx = nativeEventListeners.indexOf(cb)
                    if (idx >= 0) nativeEventListeners.splice(idx, 1)
                }
            }),
        } as any)

        const finishService = new FakeSyncService()
        const { unmount } = renderHook(() => useAgentStream(), {
            wrapper: createWrapper(finishService),
        })

        const emitNative = nativeEventListeners[0]!
        await act(async () => {
            emitNative({
                kind: 'session:delegate-run',
                data: JSON.stringify({
                    requestId: 'exact-once-req',
                    sessionId: 'sess-exact-once',
                    text: 'Exact once message',
                }),
            })
        })

        await waitFor(() => {
            expect(ackMock).toHaveBeenCalledWith('exact-once-req')
        })

        // Ensure ACK was called exactly once, never twice
        const ackCallsForReq = ackMock.mock.calls.filter(
            (args: any[]) => args[0] === 'exact-once-req',
        )
        expect(ackCallsForReq).toHaveLength(1)

        unmount()
    })

    it('claims multiple delegate runs for the same session sequentially without cancelling preflights', async () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) CPA/1.0.0 Chrome/120.0.0.0 Electron/28.0.0 Safari/537.36',
            configurable: true,
        })

        const ackMock = vi.fn().mockResolvedValue(undefined)
        const req1 = {
            requestId: 'concurrent-req-1',
            sessionId: 'same-sess-claim',
            text: 'First message',
            followUpMode: 'queue' as const,
        }
        const req2 = {
            requestId: 'concurrent-req-2',
            sessionId: 'same-sess-claim',
            text: 'Second message',
            followUpMode: 'queue' as const,
        }

        setHostBridge({
            SessionBroadcastRunStatus: broadcastRunStatusMock,
            SessionBroadcastStreamEvent: broadcastStreamEventMock,
            SessionAbortRun: abortRunMock,
            SessionDelegateRun: delegateRunMock,
            SessionClaimPendingDelegateRuns: vi.fn().mockResolvedValue([req1, req2]),
            SessionAckDelegateRun: ackMock,
            onNativeEvent: vi.fn((_cb: (event: any) => void) => () => {}),
        } as any)

        let executionCount = 0
        const multiClaimService = new FakeSyncService()
        const originalStreamChat = multiClaimService.streamChat.bind(multiClaimService)
        multiClaimService.streamChat = async function* (options: any) {
            executionCount++
            yield* originalStreamChat(options)
        }

        const { unmount } = renderHook(() => useAgentStream(), {
            wrapper: createWrapper(multiClaimService),
        })

        // Both requests must complete execution without one aborting the other during preflight
        await waitFor(() => {
            expect(ackMock).toHaveBeenCalledWith('concurrent-req-1')
            expect(ackMock).toHaveBeenCalledWith('concurrent-req-2')
            expect(executionCount).toBe(2)
        })

        unmount()
    })

    it('broadcasts idle status when worktree initialization fails so web clients do not stay stuck running', async () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) CPA/1.0.0 Chrome/120.0.0.0 Electron/28.0.0 Safari/537.36',
            configurable: true,
        })

        const ackMock = vi.fn().mockResolvedValue(undefined)
        setHostBridge({
            SessionBroadcastRunStatus: broadcastRunStatusMock,
            SessionBroadcastStreamEvent: broadcastStreamEventMock,
            SessionAbortRun: abortRunMock,
            SessionDelegateRun: delegateRunMock,
            SessionClaimPendingDelegateRuns: vi.fn().mockResolvedValue([]),
            SessionAckDelegateRun: ackMock,
            onNativeEvent: vi.fn((cb: (event: any) => void) => {
                nativeEventListeners.push(cb)
                return () => {
                    const idx = nativeEventListeners.indexOf(cb)
                    if (idx >= 0) nativeEventListeners.splice(idx, 1)
                }
            }),
        } as any)

        const worktreeFailService = new FakeSyncService()
        const { result, unmount } = renderHook(() => useAgentStream(), {
            wrapper: createWrapper(worktreeFailService),
        })

        await waitFor(() => {
            expect(result.current).not.toBeNull()
        })

        // Trigger send with worktree mode that fails
        broadcastRunStatusMock.mockClear()
        await act(async () => {
            try {
                await result.current.send({
                    text: 'Worktree prompt',
                    workLocation: 'worktree',
                    projectId: 'non-existent-proj',
                })
            } catch {
                // Preflight error expected
            }
        })

        // Must broadcast idle status to clear optimistic running
        await waitFor(() => {
            expect(broadcastRunStatusMock).toHaveBeenCalledWith(
                expect.any(String),
                'idle',
                expect.any(String),
                expect.any(String),
            )
        })

        unmount()
    })

    it('queues delegate runs arriving during compaction instead of steering and executes after compaction', async () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) CPA/1.0.0 Chrome/120.0.0.0 Electron/28.0.0 Safari/537.36',
            configurable: true,
        })

        const ackMock = vi.fn().mockResolvedValue(undefined)
        setHostBridge({
            SessionBroadcastRunStatus: broadcastRunStatusMock,
            SessionBroadcastStreamEvent: broadcastStreamEventMock,
            SessionAbortRun: abortRunMock,
            SessionDelegateRun: delegateRunMock,
            SessionClaimPendingDelegateRuns: vi.fn().mockResolvedValue([]),
            SessionAckDelegateRun: ackMock,
            onNativeEvent: vi.fn((cb: (event: any) => void) => {
                nativeEventListeners.push(cb)
                return () => {
                    const idx = nativeEventListeners.indexOf(cb)
                    if (idx >= 0) nativeEventListeners.splice(idx, 1)
                }
            }),
        } as any)

        let releaseCompactHold: () => void = () => {}
        const compactHold = new Promise<void>((resolve) => {
            releaseCompactHold = resolve
        })

        const compactService = new FakeSyncService()
        const originalCompact = compactService.compact.bind(compactService)
        compactService.compact = async (input: any) => {
            await compactHold
            return originalCompact(input)
        }

        const sessId = 'compacting-session-1'
        useSessionStore.getState().upsertRemoteSession({
            id: sessId,
            title: 'Compacting Session',
            pinned: false,
            createdAt: Date.now() - 5000,
            updatedAt: Date.now() - 5000,
        })
        const initialUser: UserEntry = {
            id: 'u1',
            sessionId: sessId,
            createdAt: Date.now() - 5000,
            kind: 'user',
            content: [{ type: 'text', text: 'Old prompt' }],
        }
        useMessageStore.getState().replaceSessionEntries(sessId, [initialUser])

        const { result, unmount } = renderHook(() => useAgentStream(sessId), {
            wrapper: createWrapper(compactService),
        })

        await waitFor(() => {
            expect(result.current).not.toBeNull()
        })

        // 1. Start compaction in background
        let compactPromise: Promise<any> | null = null
        act(() => {
            compactPromise = result.current.compact(sessId)
        })

        // 2. Deliver delegate request while compaction is active
        const emitNative = nativeEventListeners[0]!
        act(() => {
            emitNative({
                kind: 'session:delegate-run',
                data: JSON.stringify({
                    requestId: 'req-during-compact',
                    sessionId: sessId,
                    text: 'Message arriving during compact',
                }),
            })
        })

        // It should not be acknowledged yet
        expect(ackMock).not.toHaveBeenCalledWith('req-during-compact')

        // 3. Complete compaction
        await act(async () => {
            releaseCompactHold()
            await compactPromise
        })

        // 4. Queued message should automatically execute and finish, then ACK
        await waitFor(() => {
            expect(ackMock).toHaveBeenCalledWith('req-during-compact')
            expect(compactService.streamChatCalls).toHaveLength(1)
        })

        unmount()
    })

    it('processes queued item dequeuing and subsequent incoming delegation through sessionActionQueue without preflight conflict', async () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) CPA/1.0.0 Chrome/120.0.0.0 Electron/28.0.0 Safari/537.36',
            configurable: true,
        })

        const ackMock = vi.fn().mockResolvedValue(undefined)
        setHostBridge({
            SessionBroadcastRunStatus: broadcastRunStatusMock,
            SessionBroadcastStreamEvent: broadcastStreamEventMock,
            SessionAbortRun: abortRunMock,
            SessionDelegateRun: delegateRunMock,
            SessionClaimPendingDelegateRuns: vi.fn().mockResolvedValue([]),
            SessionAckDelegateRun: ackMock,
            onNativeEvent: vi.fn((cb: (event: any) => void) => {
                nativeEventListeners.push(cb)
                return () => {
                    const idx = nativeEventListeners.indexOf(cb)
                    if (idx >= 0) nativeEventListeners.splice(idx, 1)
                }
            }),
        } as any)

        let releaseFirstRun: () => void = () => {}
        const firstRunHold = new Promise<void>((resolve) => {
            releaseFirstRun = resolve
        })

        let runCount = 0
        const queueRaceService = new FakeSyncService()
        const originalStreamChat = queueRaceService.streamChat.bind(queueRaceService)
        queueRaceService.streamChat = async function* (options: any) {
            runCount++
            if (runCount === 1) {
                await firstRunHold
            }
            yield* originalStreamChat(options)
        }

        const { result, unmount } = renderHook(() => useAgentStream(), {
            wrapper: createWrapper(queueRaceService),
        })

        await waitFor(() => {
            expect(result.current).not.toBeNull()
        })

        // 1. Start initial flight A
        let hostSessionId: string | null = null
        await act(async () => {
            hostSessionId = await result.current.send('Run A prompt')
        })
        expect(hostSessionId).toBeTruthy()

        const emitNative = nativeEventListeners[0]!

        // 2. Send queued delegation B while A is streaming
        act(() => {
            emitNative({
                kind: 'session:delegate-run',
                data: JSON.stringify({
                    requestId: 'req-b-queued',
                    sessionId: hostSessionId,
                    text: 'Queued message B',
                    followUpMode: 'queue' as const,
                }),
            })
        })

        // 3. Complete flight A so B dequeues and begins preflight
        await act(async () => {
            releaseFirstRun()
        })

        // 4. While B is dequeued / processing, immediately deliver incoming delegation C
        act(() => {
            emitNative({
                kind: 'session:delegate-run',
                data: JSON.stringify({
                    requestId: 'req-c-incoming',
                    sessionId: hostSessionId,
                    text: 'Incoming message C',
                    followUpMode: 'queue' as const,
                }),
            })
        })

        // Both B and C must execute cleanly and be acknowledged without C aborting B's preflight
        await waitFor(() => {
            expect(ackMock).toHaveBeenCalledWith('req-b-queued')
            expect(ackMock).toHaveBeenCalledWith('req-c-incoming')
            expect(runCount).toBe(3)
        })

        unmount()
    })

    it('does not clobber or clear existing remote running status when follow-up delegation fails in browser', async () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            configurable: true,
        })

        const testSessionId = 'active-remote-session-1'
        useSessionRunStore.getState().setRun(testSessionId, {
            sessionId: testSessionId,
            status: 'running',
            runId: 'real-remote-run-999',
            clientId: 'desktop-host-1',
            updatedAt: Date.now() - 5000,
        })

        useSessionStore.getState().upsertRemoteSession({
            id: testSessionId,
            title: 'Active Session',
            pinned: false,
            createdAt: Date.now() - 5000,
            updatedAt: Date.now() - 5000,
        })

        // Mock delegate run failure (e.g. network glitch or queue full)
        const failingDelegateMock = vi.fn().mockRejectedValue(new Error('Queue full'))
        setHostBridge({
            SessionBroadcastRunStatus: broadcastRunStatusMock,
            SessionBroadcastStreamEvent: broadcastStreamEventMock,
            SessionAbortRun: abortRunMock,
            SessionDelegateRun: failingDelegateMock,
            SessionClaimPendingDelegateRuns: vi.fn().mockResolvedValue([]),
            SessionAckDelegateRun: vi.fn().mockResolvedValue(undefined),
            onNativeEvent: vi.fn((_cb: (event: any) => void) => () => {}),
        } as any)

        const testService = new FakeSyncService()
        const { result, unmount } = renderHook(() => useAgentStream(testSessionId), {
            wrapper: createWrapper(testService),
        })

        await waitFor(() => {
            expect(result.current).not.toBeNull()
        })

        // Send follow-up prompt in browser mode
        let sendFailed = false
        await act(async () => {
            try {
                await result.current.send('Follow up message during active remote run')
            } catch {
                sendFailed = true
            }
        })

        expect(sendFailed).toBe(true)

        // Existing real remote run must NOT be cleared or clobbered
        const currentRun = useSessionRunStore.getState().activeRuns[testSessionId]
        expect(currentRun).toBeDefined()
        expect(currentRun?.status).toBe('running')
        expect(currentRun?.runId).toBe('real-remote-run-999')
        expect(currentRun?.clientId).toBe('desktop-host-1')

        unmount()
    })

    it('does not allow queued message B to abort newly started flight C when C acquired lock before B dequeued', async () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) CPA/1.0.0 Chrome/120.0.0.0 Electron/28.0.0 Safari/537.36',
            configurable: true,
        })

        const ackMock = vi.fn().mockResolvedValue(undefined)
        setHostBridge({
            SessionBroadcastRunStatus: broadcastRunStatusMock,
            SessionBroadcastStreamEvent: broadcastStreamEventMock,
            SessionAbortRun: abortRunMock,
            SessionDelegateRun: delegateRunMock,
            SessionClaimPendingDelegateRuns: vi.fn().mockResolvedValue([]),
            SessionAckDelegateRun: ackMock,
            onNativeEvent: vi.fn((cb: (event: any) => void) => {
                nativeEventListeners.push(cb)
                return () => {
                    const idx = nativeEventListeners.indexOf(cb)
                    if (idx >= 0) nativeEventListeners.splice(idx, 1)
                }
            }),
        } as any)

        let releaseHoldA: () => void = () => {}
        const holdA = new Promise<void>((resolve) => {
            releaseHoldA = resolve
        })

        let releaseHoldC: () => void = () => {}
        const holdC = new Promise<void>((resolve) => {
            releaseHoldC = resolve
        })

        let currentRun = 0
        const raceService = new FakeSyncService()
        const originalStreamChat = raceService.streamChat.bind(raceService)
        raceService.streamChat = async function* (options: any) {
            currentRun++
            if (currentRun === 1) {
                await holdA
            } else if (currentRun === 2) {
                await holdC
            }
            yield* originalStreamChat(options)
        }

        const { result, unmount } = renderHook(() => useAgentStream(), {
            wrapper: createWrapper(raceService),
        })

        await waitFor(() => {
            expect(result.current).not.toBeNull()
        })

        // 1. Start flight A
        let hostSessionId: string | null = null
        await act(async () => {
            hostSessionId = await result.current.send('Flight A prompt')
        })

        expect(hostSessionId).toBeTruthy()

        const emitNative = nativeEventListeners[0]!

        // 2. Queue message B while flight A is active
        act(() => {
            emitNative({
                kind: 'session:delegate-run',
                data: JSON.stringify({
                    requestId: 'req-b-queue',
                    sessionId: hostSessionId,
                    text: 'Queued message B',
                    followUpMode: 'queue' as const,
                }),
            })
        })

        // 3. Delegation C arrives and acquires sessionActionQueue
        // While C is queued/processing, release flight A
        act(() => {
            emitNative({
                kind: 'session:delegate-run',
                data: JSON.stringify({
                    requestId: 'req-c-incoming',
                    sessionId: hostSessionId,
                    text: 'Incoming message C',
                    followUpMode: 'queue' as const,
                }),
            })
        })

        // Release flight A so it completes and attempts to dequeue B
        await act(async () => {
            releaseHoldA()
        })

        // Flight C must start without being aborted by B
        await waitFor(() => {
            expect(currentRun).toBeGreaterThanOrEqual(2)
        })

        // Service abort must NOT have been called for flight C!
        expect(raceService.abortCalls).toHaveLength(0)

        // Complete flight C
        await act(async () => {
            releaseHoldC()
        })

        // Finally both B and C must complete and be ACKed
        await waitFor(() => {
            expect(ackMock).toHaveBeenCalledWith('req-b-queue')
            expect(ackMock).toHaveBeenCalledWith('req-c-incoming')
        })

        unmount()
    })

    it('does not allow local send C to abort pending preflight of delegation B', async () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) CPA/1.0.0 Chrome/120.0.0.0 Electron/28.0.0 Safari/537.36',
            configurable: true,
        })

        const ackMock = vi.fn().mockResolvedValue(undefined)
        setHostBridge({
            SessionBroadcastRunStatus: broadcastRunStatusMock,
            SessionBroadcastStreamEvent: broadcastStreamEventMock,
            SessionAbortRun: abortRunMock,
            SessionDelegateRun: delegateRunMock,
            SessionClaimPendingDelegateRuns: vi.fn().mockResolvedValue([]),
            SessionAckDelegateRun: ackMock,
            onNativeEvent: vi.fn((cb: (event: any) => void) => {
                nativeEventListeners.push(cb)
                return () => {
                    const idx = nativeEventListeners.indexOf(cb)
                    if (idx >= 0) nativeEventListeners.splice(idx, 1)
                }
            }),
        } as any)

        let releasePrepareB: () => void = () => {}
        const prepareGateB = new Promise<void>((resolve) => {
            releasePrepareB = resolve
        })

        let bPrepareStarted = false
        let bSignalAbortedDuringPrepare = false
        const concurrencyService = new FakeSyncService()
        const originalPrepare = concurrencyService.prepare.bind(concurrencyService)
        concurrencyService.prepare = async (input: any) => {
            if (input.sessionId === 'shared-session-concurrency') {
                bPrepareStarted = true
                input.signal?.addEventListener('abort', () => {
                    bSignalAbortedDuringPrepare = true
                })
                await prepareGateB
            }
            return originalPrepare(input)
        }

        const sessId = 'shared-session-concurrency'
        useSessionStore.getState().upsertRemoteSession({
            id: sessId,
            title: 'Shared Session',
            pinned: false,
            createdAt: Date.now() - 5000,
            updatedAt: Date.now() - 5000,
        })

        const { result, unmount } = renderHook(() => useAgentStream(sessId), {
            wrapper: createWrapper(concurrencyService),
        })

        await waitFor(() => {
            expect(result.current).not.toBeNull()
        })

        const emitNative = nativeEventListeners[0]!

        // 1. Delegation B starts and enters asynchronous preflight
        act(() => {
            emitNative({
                kind: 'session:delegate-run',
                data: JSON.stringify({
                    requestId: 'req-b-delegation',
                    sessionId: sessId,
                    text: 'Delegation B message',
                }),
            })
        })

        await waitFor(() => {
            expect(bPrepareStarted).toBe(true)
        })

        // 2. While B is still preparing, local user sends message C for the same session
        act(() => {
            void result.current.send('Local message C from user')
        })

        // B must NOT be aborted by C!
        expect(bSignalAbortedDuringPrepare).toBe(false)

        // 3. Complete B's preflight so B can establish flight and stream
        await act(async () => {
            releasePrepareB()
        })

        // B must complete its execution and be ACKed
        await waitFor(() => {
            expect(ackMock).toHaveBeenCalledWith('req-b-delegation')
        })

        expect(bSignalAbortedDuringPrepare).toBe(false)
        expect(concurrencyService.streamChatCalls.length).toBeGreaterThanOrEqual(1)

        unmount()
    })

    it('triggers SessionAbortRun exactly once during takeover and does not duplicate abort', async () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) CPA/1.0.0 Chrome/120.0.0.0 Electron/28.0.0 Safari/537.36',
            configurable: true,
        })

        const testSessionId = 'takeover-single-abort-session'
        useSessionRunStore.getState().setRun(testSessionId, {
            sessionId: testSessionId,
            status: 'running',
            runId: 'old-remote-run-xyz',
            clientId: 'remote-client',
            updatedAt: Date.now() - 5000,
        })

        useSessionStore.getState().upsertRemoteSession({
            id: testSessionId,
            title: 'Remote Session',
            pinned: false,
            createdAt: Date.now() - 5000,
            updatedAt: Date.now() - 5000,
        })

        const abortRunSpy = vi.fn().mockResolvedValue(undefined)
        setHostBridge({
            SessionBroadcastRunStatus: broadcastRunStatusMock,
            SessionBroadcastStreamEvent: broadcastStreamEventMock,
            SessionAbortRun: abortRunSpy,
            SessionDelegateRun: delegateRunMock,
            SessionClaimPendingDelegateRuns: vi.fn().mockResolvedValue([]),
            SessionAckDelegateRun: vi.fn().mockResolvedValue(undefined),
            onNativeEvent: vi.fn((_cb: (event: any) => void) => () => {}),
        } as any)

        const takeoverService = new FakeSyncService()
        const { result, unmount } = renderHook(() => useAgentStream(testSessionId), {
            wrapper: createWrapper(takeoverService),
        })

        await waitFor(() => {
            expect(result.current).not.toBeNull()
        })

        await act(async () => {
            const p1 = result.current.send('Takeover prompt 1')
            const p2 = result.current.send('Takeover prompt 2')
            await Promise.all([p1, p2])
        })

        // SessionAbortRun must be called exactly ONCE, never duplicated even across concurrent sends!
        expect(abortRunSpy).toHaveBeenCalledTimes(1)
        expect(abortRunSpy).toHaveBeenCalledWith(testSessionId)

        unmount()
    })

    it('handles concurrent takeover sends and abort echo without cancelling the local run', async () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) CPA/1.0.0 Chrome/120.0.0.0 Electron/28.0.0 Safari/537.36',
            configurable: true,
        })

        const testSessionId = 'concurrent-takeover-echo-session'
        useSessionRunStore.getState().setRun(testSessionId, {
            sessionId: testSessionId,
            status: 'running',
            runId: 'old-remote-run-echo',
            clientId: 'remote-client',
            updatedAt: Date.now() - 5000,
        })

        useSessionStore.getState().upsertRemoteSession({
            id: testSessionId,
            title: 'Remote Session',
            pinned: false,
            createdAt: Date.now() - 5000,
            updatedAt: Date.now() - 5000,
        })

        const abortRunSpy = vi.fn().mockResolvedValue(undefined)
        setHostBridge({
            SessionBroadcastRunStatus: broadcastRunStatusMock,
            SessionBroadcastStreamEvent: broadcastStreamEventMock,
            SessionAbortRun: abortRunSpy,
            SessionDelegateRun: delegateRunMock,
            SessionClaimPendingDelegateRuns: vi.fn().mockResolvedValue([]),
            SessionAckDelegateRun: vi.fn().mockResolvedValue(undefined),
            onNativeEvent: vi.fn((cb: (event: any) => void) => {
                nativeEventListeners.push(cb)
                return () => {
                    const idx = nativeEventListeners.indexOf(cb)
                    if (idx >= 0) nativeEventListeners.splice(idx, 1)
                }
            }),
        } as any)

        let releasePrepareHold: () => void = () => {}
        const prepareHold = new Promise<void>((resolve) => {
            releasePrepareHold = resolve
        })

        let prepareStarted = false
        const takeoverEchoService = new FakeSyncService()
        const originalPrepare = takeoverEchoService.prepare.bind(takeoverEchoService)
        takeoverEchoService.prepare = async (input: any) => {
            prepareStarted = true
            await prepareHold
            return originalPrepare(input)
        }

        const { result, unmount } = renderHook(() => useAgentStream(testSessionId), {
            wrapper: createWrapper(takeoverEchoService),
        })

        await waitFor(() => {
            expect(result.current).not.toBeNull()
        })

        const emitNative = nativeEventListeners[0]!

        // 1. Trigger two concurrent sends
        let p1!: Promise<string | null>
        let p2!: Promise<string | null>
        act(() => {
            p1 = result.current.send('Prompt 1')
            p2 = result.current.send('Prompt 2')
        })

        await waitFor(() => {
            expect(prepareStarted).toBe(true)
        })

        // Exactly one SessionAbortRun must have been sent
        expect(abortRunSpy).toHaveBeenCalledTimes(1)

        // 2. Abort echo arrives from remote
        act(() => {
            emitNative({
                kind: 'session:abort-run',
                data: JSON.stringify({ sessionId: testSessionId }),
            })
        })

        // 3. Unblock prepare
        await act(async () => {
            releasePrepareHold()
            await Promise.all([p1, p2])
        })

        // Local flight must be running and never aborted
        expect(takeoverEchoService.abortCalls).toHaveLength(0)
        expect(takeoverEchoService.streamChatCalls.length).toBeGreaterThanOrEqual(1)

        unmount()
    })

    it('preserves target session even if currentSessionId switches while waiting in session action queue', async () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) CPA/1.0.0 Chrome/120.0.0.0 Electron/28.0.0 Safari/537.36',
            configurable: true,
        })

        let releaseHoldA: () => void = () => {}
        const holdA = new Promise<void>((resolve) => {
            releaseHoldA = resolve
        })

        const sessionSwitchService = new FakeSyncService()
        const originalStreamChat = sessionSwitchService.streamChat.bind(sessionSwitchService)
        sessionSwitchService.streamChat = async function* (options: any) {
            if (options.sessionId === 'session-a-switch') {
                await holdA
            }
            yield* originalStreamChat(options)
        }

        const sessionA = 'session-a-switch'
        const sessionB = 'session-b-switch'

        useSessionStore.setState({
            sessions: [
                {
                    id: sessionA,
                    title: 'Session A',
                    pinned: false,
                    createdAt: Date.now() - 5000,
                    updatedAt: Date.now() - 5000,
                },
                {
                    id: sessionB,
                    title: 'Session B',
                    pinned: false,
                    createdAt: Date.now() - 4000,
                    updatedAt: Date.now() - 4000,
                },
            ],
            currentSessionId: sessionA,
        })

        const { result, unmount } = renderHook(() => useAgentStream(), {
            wrapper: createWrapper(sessionSwitchService),
        })

        await waitFor(() => {
            expect(result.current).not.toBeNull()
        })

        // 1. Send first message in Session A which holds the action lock
        act(() => {
            void result.current.send('First message in A')
        })

        // 2. Send second message in Session A while first is still locking A's action queue
        act(() => {
            void result.current.send('Second message meant for A')
        })

        // 3. User switches to Session B while second message is still waiting in A's action queue
        act(() => {
            useSessionStore.getState().setCurrentSession(sessionB)
        })

        // 4. Release first message in Session A so second message executes
        await act(async () => {
            releaseHoldA()
        })

        // Wait for streaming to finish
        await waitFor(() => {
            expect(result.current.isStreaming).toBe(false)
        })

        // Entries meant for A must strictly be in A, NEVER leaked to B!
        const entriesA = useMessageStore.getState().getEntries(sessionA)
        const entriesB = useMessageStore.getState().getEntries(sessionB)

        const userEntriesA = entriesA.filter((e) => e.kind === 'user')
        const userEntriesB = entriesB.filter((e) => e.kind === 'user')

        expect(userEntriesA).toHaveLength(2)
        expect(userEntriesB).toHaveLength(0)

        unmount()
    })

    it('transfers unconsumed steer delegation arriving during stream loop completion into queued execution without premature ACK', async () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) CPA/1.0.0 Chrome/120.0.0.0 Electron/28.0.0 Safari/537.36',
            configurable: true,
        })

        const ackMock = vi.fn().mockResolvedValue(undefined)
        setHostBridge({
            SessionBroadcastRunStatus: broadcastRunStatusMock,
            SessionBroadcastStreamEvent: broadcastStreamEventMock,
            SessionAbortRun: abortRunMock,
            SessionDelegateRun: delegateRunMock,
            SessionClaimPendingDelegateRuns: vi.fn().mockResolvedValue([]),
            SessionAckDelegateRun: ackMock,
            onNativeEvent: vi.fn((cb: (event: any) => void) => {
                nativeEventListeners.push(cb)
                return () => {
                    const idx = nativeEventListeners.indexOf(cb)
                    if (idx >= 0) nativeEventListeners.splice(idx, 1)
                }
            }),
        } as any)

        let releaseStreamChat1: () => void = () => {}
        const streamChatGate1 = new Promise<void>((resolve) => {
            releaseStreamChat1 = resolve
        })

        let runCount = 0
        const lateSteerService = new FakeSyncService()
        const originalStreamChat = lateSteerService.streamChat.bind(lateSteerService)
        lateSteerService.streamChat = async function* (options: any) {
            runCount++
            if (runCount === 1) {
                // Yield normal events
                yield { type: 'agent-start', runId: options.runId, sessionId: options.sessionId }
                // Wait on gate before finishing stream loop (simulating async teardown / model close)
                await streamChatGate1
                yield { type: 'agent-end', runId: options.runId, sessionId: options.sessionId }
                return
            }
            yield* originalStreamChat(options)
        }

        const sessId = 'unconsumed-steer-session'
        useSessionStore.getState().upsertRemoteSession({
            id: sessId,
            title: 'Late Steer Session',
            pinned: false,
            createdAt: Date.now() - 5000,
            updatedAt: Date.now() - 5000,
        })

        const { result, unmount } = renderHook(() => useAgentStream(sessId), {
            wrapper: createWrapper(lateSteerService),
        })

        await waitFor(() => {
            expect(result.current).not.toBeNull()
        })

        // 1. Start initial run 1
        act(() => {
            void result.current.send('First prompt')
        })

        await waitFor(() => {
            expect(runCount).toBe(1)
        })

        const emitNative = nativeEventListeners[0]!

        // 2. Deliver steer delegation while run 1 is paused right at teardown
        act(() => {
            emitNative({
                kind: 'session:delegate-run',
                data: JSON.stringify({
                    requestId: 'late-steer-req',
                    sessionId: sessId,
                    text: 'Late steer message during stream close',
                    followUpMode: 'steer' as const,
                }),
            })
        })

        // Steer should NOT be acknowledged yet
        expect(ackMock).not.toHaveBeenCalledWith('late-steer-req')

        // 3. Release streamChat 1 loop
        await act(async () => {
            releaseStreamChat1()
        })

        // The unconsumed steer must NOT be ACKed prematurely by run 1's end!
        // Instead, it must be transferred to next queued turn and executed in run 2!
        await waitFor(() => {
            expect(runCount).toBe(2)
        })

        // Finally, upon completion of run 2, the late steer is safely ACKed!
        await waitFor(() => {
            expect(ackMock).toHaveBeenCalledWith('late-steer-req')
        })

        unmount()
    })

    it('cleans up steer finish callbacks and sends ACK when a pending steer delegation is dequeued/withdrawn', async () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) CPA/1.0.0 Chrome/120.0.0.0 Electron/28.0.0 Safari/537.36',
            configurable: true,
        })

        const ackMock = vi.fn().mockResolvedValue(undefined)
        setHostBridge({
            SessionBroadcastRunStatus: broadcastRunStatusMock,
            SessionBroadcastStreamEvent: broadcastStreamEventMock,
            SessionAbortRun: abortRunMock,
            SessionDelegateRun: delegateRunMock,
            SessionClaimPendingDelegateRuns: vi.fn().mockResolvedValue([]),
            SessionAckDelegateRun: ackMock,
            onNativeEvent: vi.fn((cb: (event: any) => void) => {
                nativeEventListeners.push(cb)
                return () => {
                    const idx = nativeEventListeners.indexOf(cb)
                    if (idx >= 0) nativeEventListeners.splice(idx, 1)
                }
            }),
        } as any)

        let releaseHold: () => void = () => {}
        const hold = new Promise<void>((resolve) => {
            releaseHold = resolve
        })

        let runCount = 0
        const withdrawService = new FakeSyncService()
        const originalStreamChat = withdrawService.streamChat.bind(withdrawService)
        withdrawService.streamChat = async function* (options: any) {
            runCount++
            await hold
            yield* originalStreamChat(options)
        }

        const sessId = 'withdraw-steer-session'
        useSessionStore.getState().upsertRemoteSession({
            id: sessId,
            title: 'Withdraw Steer Session',
            pinned: false,
            createdAt: Date.now() - 5000,
            updatedAt: Date.now() - 5000,
        })

        const { result, unmount } = renderHook(() => useAgentStream(sessId), {
            wrapper: createWrapper(withdrawService),
        })

        await waitFor(() => {
            expect(result.current).not.toBeNull()
        })

        // 1. Start initial run
        act(() => {
            void result.current.send('First prompt')
        })

        await waitFor(() => {
            expect(runCount).toBe(1)
        })

        const emitNative = nativeEventListeners[0]!

        // 2. Deliver steer delegation
        act(() => {
            emitNative({
                kind: 'session:delegate-run',
                data: JSON.stringify({
                    requestId: 'steer-to-withdraw',
                    sessionId: sessId,
                    userEntryId: 'u-steer-withdraw',
                    text: 'Message that will be withdrawn',
                    followUpMode: 'steer' as const,
                }),
            })
        })

        await waitFor(() => {
            expect(getRuntime(withdrawService).pendingSteers.get(sessId)?.length).toBe(1)
        })

        // Steer should NOT be acknowledged yet
        expect(ackMock).not.toHaveBeenCalledWith('steer-to-withdraw')

        // 3. User withdraws/dequeues the steer message before model consumes it
        act(() => {
            const rt = getRuntime(withdrawService)
            dequeueQueuedMessage(rt, sessId, 'u-steer-withdraw')
        })

        // Steer should immediately be ACKed and marked finished upon dequeue!
        expect(ackMock).toHaveBeenCalledWith('steer-to-withdraw')

        // 4. Release first run to complete
        await act(async () => {
            releaseHold()
        })

        await waitFor(() => {
            expect(result.current.isStreaming).toBe(false)
        })

        // Run count must stay 1 (withdrawn steer was not executed as a second run)
        expect(runCount).toBe(1)

        unmount()
    })

    it('does not append duplicate message when steer delegation userEntryId already exists in store', async () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) CPA/1.0.0 Chrome/120.0.0.0 Electron/28.0.0 Safari/537.36',
            configurable: true,
        })

        const ackMock = vi.fn().mockResolvedValue(undefined)
        setHostBridge({
            SessionBroadcastRunStatus: broadcastRunStatusMock,
            SessionBroadcastStreamEvent: broadcastStreamEventMock,
            SessionAbortRun: abortRunMock,
            SessionDelegateRun: delegateRunMock,
            SessionClaimPendingDelegateRuns: vi.fn().mockResolvedValue([]),
            SessionAckDelegateRun: ackMock,
            onNativeEvent: vi.fn((cb: (event: any) => void) => {
                nativeEventListeners.push(cb)
                return () => {
                    const idx = nativeEventListeners.indexOf(cb)
                    if (idx >= 0) nativeEventListeners.splice(idx, 1)
                }
            }),
        } as any)

        let releaseHold: () => void = () => {}
        const hold = new Promise<void>((resolve) => {
            releaseHold = resolve
        })

        const dedupService = new FakeSyncService()
        const originalStreamChat = dedupService.streamChat.bind(dedupService)
        dedupService.streamChat = async function* (options: any) {
            await hold
            yield* originalStreamChat(options)
        }

        const sessId = 'steer-dedup-session'
        useSessionStore.getState().upsertRemoteSession({
            id: sessId,
            title: 'Steer Dedup Session',
            pinned: false,
            createdAt: Date.now() - 5000,
            updatedAt: Date.now() - 5000,
        })

        const { result, unmount } = renderHook(() => useAgentStream(sessId), {
            wrapper: createWrapper(dedupService),
        })

        await waitFor(() => {
            expect(result.current).not.toBeNull()
        })

        // 1. Start initial run
        act(() => {
            void result.current.send('First prompt')
        })

        await waitFor(() => {
            expect(result.current.isStreaming).toBe(true)
        })

        // 2. Pre-seed the store with user entry having ID 'u-steer-preseeded' (simulating web client hydration)
        const preseededEntry: UserEntry = {
            id: 'u-steer-preseeded',
            sessionId: sessId,
            createdAt: Date.now(),
            kind: 'user',
            content: [{ type: 'text', text: 'Pre-seeded message' }],
        }
        useMessageStore.getState().appendEntry(preseededEntry)

        const emitNative = nativeEventListeners[0]!

        // 3. Deliver steer delegation with the same userEntryId
        act(() => {
            emitNative({
                kind: 'session:delegate-run',
                data: JSON.stringify({
                    requestId: 'steer-dedup-req',
                    sessionId: sessId,
                    userEntryId: 'u-steer-preseeded',
                    text: 'Pre-seeded message',
                    followUpMode: 'steer' as const,
                }),
            })
        })

        await waitFor(() => {
            expect(getRuntime(dedupService).pendingSteers.get(sessId)?.length).toBe(1)
        })

        // Message store must NOT have duplicated entries with the same ID!
        const entries = useMessageStore.getState().getEntries(sessId)
        const matched = entries.filter((e) => e.id === 'u-steer-preseeded')
        expect(matched).toHaveLength(1)
        expect((matched[0] as any).pendingStatus).toBe('steer')

        // Release flight
        await act(async () => {
            releaseHold()
        })

        unmount()
    })

    it('preserves userEntryId on queued delegation and allows withdrawal via original ID', async () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) CPA/1.0.0 Chrome/120.0.0.0 Electron/28.0.0 Safari/537.36',
            configurable: true,
        })

        const ackMock = vi.fn().mockResolvedValue(undefined)
        setHostBridge({
            SessionBroadcastRunStatus: broadcastRunStatusMock,
            SessionBroadcastStreamEvent: broadcastStreamEventMock,
            SessionAbortRun: abortRunMock,
            SessionDelegateRun: delegateRunMock,
            SessionClaimPendingDelegateRuns: vi.fn().mockResolvedValue([]),
            SessionAckDelegateRun: ackMock,
            onNativeEvent: vi.fn((cb: (event: any) => void) => {
                nativeEventListeners.push(cb)
                return () => {
                    const idx = nativeEventListeners.indexOf(cb)
                    if (idx >= 0) nativeEventListeners.splice(idx, 1)
                }
            }),
        } as any)

        let releaseHold: () => void = () => {}
        const hold = new Promise<void>((resolve) => {
            releaseHold = resolve
        })

        const queueWithdrawService = new FakeSyncService()
        const originalStreamChat = queueWithdrawService.streamChat.bind(queueWithdrawService)
        queueWithdrawService.streamChat = async function* (options: any) {
            await hold
            yield* originalStreamChat(options)
        }

        const sessId = 'queue-withdraw-session'
        useSessionStore.getState().upsertRemoteSession({
            id: sessId,
            title: 'Queue Withdraw Session',
            pinned: false,
            createdAt: Date.now() - 5000,
            updatedAt: Date.now() - 5000,
        })

        const { result, unmount } = renderHook(() => useAgentStream(sessId), {
            wrapper: createWrapper(queueWithdrawService),
        })

        await waitFor(() => {
            expect(result.current).not.toBeNull()
        })

        // 1. Start initial run
        act(() => {
            void result.current.send('First prompt')
        })

        await waitFor(() => {
            expect(result.current.isStreaming).toBe(true)
        })

        const emitNative = nativeEventListeners[0]!

        // 2. Deliver queue delegation with explicit userEntryId
        act(() => {
            emitNative({
                kind: 'session:delegate-run',
                data: JSON.stringify({
                    requestId: 'queue-withdraw-req',
                    sessionId: sessId,
                    userEntryId: 'u-queue-withdraw-id',
                    text: 'Message in queue to be withdrawn',
                    followUpMode: 'queue' as const,
                }),
            })
        })

        await waitFor(() => {
            const rt = getRuntime(queueWithdrawService)
            expect(rt.sessionQueues.get(sessId)?.length).toBe(1)
            expect(rt.sessionQueues.get(sessId)?.[0]?.entry.id).toBe('u-queue-withdraw-id')
        })

        // 3. Withdraw via the original userEntryId
        act(() => {
            const rt = getRuntime(queueWithdrawService)
            dequeueQueuedMessage(rt, sessId, 'u-queue-withdraw-id')
        })

        // Queued request must be ACKed and settled immediately upon withdrawal!
        expect(ackMock).toHaveBeenCalledWith('queue-withdraw-req')

        // Queue in runtime must be empty
        expect(getRuntime(queueWithdrawService).sessionQueues.get(sessId)).toBeUndefined()

        // Release run 1
        await act(async () => {
            releaseHold()
        })

        await waitFor(() => {
            expect(result.current.isStreaming).toBe(false)
        })

        // Should have run only once
        expect(queueWithdrawService.streamChatCalls).toHaveLength(1)

        unmount()
    })

    it('transfers unconsumed steer without explicit sessionId into queued execution on target session A even if user switched to B', async () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) CPA/1.0.0 Chrome/120.0.0.0 Electron/28.0.0 Safari/537.36',
            configurable: true,
        })

        let releaseHoldA: () => void = () => {}
        const holdA = new Promise<void>((resolve) => {
            releaseHoldA = resolve
        })

        let runCount = 0
        const sessionDriftService = new FakeSyncService()
        const originalStreamChat = sessionDriftService.streamChat.bind(sessionDriftService)
        sessionDriftService.streamChat = async function* (options: any) {
            sessionDriftService.streamChatCalls.push(options)
            runCount++
            if (runCount === 1) {
                yield { type: 'agent-start', runId: options.runId, sessionId: options.sessionId }
                await holdA
                yield { type: 'agent-end', runId: options.runId, sessionId: options.sessionId }
                return
            }
            yield* originalStreamChat(options)
        }

        const sessionA = 'session-a-steer-drift'
        const sessionB = 'session-b-steer-drift'

        useSessionStore.setState({
            sessions: [
                {
                    id: sessionA,
                    title: 'Session A',
                    pinned: false,
                    createdAt: Date.now() - 5000,
                    updatedAt: Date.now() - 5000,
                },
                {
                    id: sessionB,
                    title: 'Session B',
                    pinned: false,
                    createdAt: Date.now() - 4000,
                    updatedAt: Date.now() - 4000,
                },
            ],
            currentSessionId: sessionA,
        })

        const { result, unmount } = renderHook(() => useAgentStream(), {
            wrapper: createWrapper(sessionDriftService),
        })

        await waitFor(() => {
            expect(result.current).not.toBeNull()
        })

        // 1. Start initial run on session A
        act(() => {
            void result.current.send('First message on A')
        })

        await waitFor(() => {
            expect(runCount).toBe(1)
        })

        const emitNative = nativeEventListeners[0]!

        // 2. Deliver steer delegation for session A (without explicit payload.sessionId in input)
        act(() => {
            emitNative({
                kind: 'session:delegate-run',
                data: JSON.stringify({
                    requestId: 'steer-drift-req',
                    sessionId: sessionA,
                    text: 'Steer message on A',
                    followUpMode: 'steer' as const,
                }),
            })
        })

        await waitFor(() => {
            expect(getRuntime(sessionDriftService).pendingSteers.get(sessionA)?.length).toBe(1)
        })

        // 3. User switches to session B
        act(() => {
            useSessionStore.getState().setCurrentSession(sessionB)
        })

        // 4. Release run on session A so steer is transferred to session A's queue and runs
        await act(async () => {
            releaseHoldA()
        })

        // Next run must be triggered on session A
        await waitFor(() => {
            expect(runCount).toBe(2)
        })

        // Verify that the second stream run was strictly executed for session A, NEVER session B!
        const call2 = sessionDriftService.streamChatCalls[1]
        expect(call2?.sessionId).toBe(sessionA)

        const entriesB = useMessageStore.getState().getEntries(sessionB)
        expect(entriesB).toHaveLength(0)

        unmount()
    })

    it('does not allow cleanup of old flight A to remove pending steer of newly started flight B during message edit', async () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) CPA/1.0.0 Chrome/120.0.0.0 Electron/28.0.0 Safari/537.36',
            configurable: true,
        })

        const ackMock = vi.fn().mockResolvedValue(undefined)
        setHostBridge({
            SessionBroadcastRunStatus: broadcastRunStatusMock,
            SessionBroadcastStreamEvent: broadcastStreamEventMock,
            SessionAbortRun: abortRunMock,
            SessionDelegateRun: delegateRunMock,
            SessionClaimPendingDelegateRuns: vi.fn().mockResolvedValue([]),
            SessionAckDelegateRun: ackMock,
            onNativeEvent: vi.fn((cb: (event: any) => void) => {
                nativeEventListeners.push(cb)
                return () => {
                    const idx = nativeEventListeners.indexOf(cb)
                    if (idx >= 0) nativeEventListeners.splice(idx, 1)
                }
            }),
        } as any)

        let releaseHoldA: () => void = () => {}
        const holdA = new Promise<void>((resolve) => {
            releaseHoldA = resolve
        })

        let releaseHoldB: () => void = () => {}
        const holdB = new Promise<void>((resolve) => {
            releaseHoldB = resolve
        })

        let flightCount = 0
        const flightOwnershipService = new FakeSyncService()
        const originalStreamChat = flightOwnershipService.streamChat.bind(flightOwnershipService)
        flightOwnershipService.streamChat = async function* (options: any) {
            flightCount++
            if (flightCount === 1) {
                // Flight A: waits on holdA then exits aborted
                const abortedPromise = new Promise<'aborted'>((resolve) => {
                    options.signal?.addEventListener('abort', () => resolve('aborted'), { once: true })
                })
                await Promise.race([holdA, abortedPromise])
                yield { type: 'aborted', runId: options.runId, sessionId: options.sessionId }
                return
            } else if (flightCount === 2) {
                // Flight B: active streaming
                await holdB
                yield* originalStreamChat(options)
            }
        }

        const sessId = 'flight-ownership-session'
        useSessionStore.getState().upsertRemoteSession({
            id: sessId,
            title: 'Flight Ownership Session',
            pinned: false,
            createdAt: Date.now() - 5000,
            updatedAt: Date.now() - 5000,
        })

        const { result, unmount } = renderHook(() => useAgentStream(sessId), {
            wrapper: createWrapper(flightOwnershipService),
        })

        await waitFor(() => {
            expect(result.current).not.toBeNull()
        })

        // 1. Start flight A
        act(() => {
            void result.current.send('Prompt 1')
        })

        await waitFor(() => {
            expect(flightCount).toBe(1)
        })

        const entries = useMessageStore.getState().getEntries(sessId)
        const initialUser = entries.find((e) => e.kind === 'user')!

        const emitNative = nativeEventListeners[0]!

        // 2. Edit message starts flight B, which interrupts flight A (flight A has not finished its finally block yet)
        act(() => {
            emitNative({
                kind: 'session:delegate-run',
                data: JSON.stringify({
                    requestId: 'edit-req-b',
                    sessionId: sessId,
                    editMessageId: initialUser.id,
                    text: 'Edited prompt starting flight B',
                }),
            })
        })

        await waitFor(() => {
            expect(flightCount).toBe(2)
        })

        // 3. While flight B is streaming and flight A is still pending its holdA cleanup, deliver steer for flight B
        act(() => {
            emitNative({
                kind: 'session:delegate-run',
                data: JSON.stringify({
                    requestId: 'steer-for-b',
                    sessionId: sessId,
                    text: 'Steer meant for flight B',
                    followUpMode: 'steer' as const,
                }),
            })
        })

        await waitFor(() => {
            const rt = getRuntime(flightOwnershipService)
            expect(rt.pendingSteers.get(sessId)?.length).toBe(1)
        })

        // 4. Now release flight A's teardown
        await act(async () => {
            releaseHoldA()
        })

        // Steer for B must still be intact in pendingSteers (not hijacked to queue by A's cleanup!)
        const rt = getRuntime(flightOwnershipService)
        expect(rt.pendingSteers.get(sessId)?.length).toBe(1)
        expect(rt.sessionQueues.get(sessId)).toBeUndefined()

        // 5. Complete flight B
        await act(async () => {
            releaseHoldB()
        })

        unmount()
    })

    it('retains multiple finish callbacks for the same userEntryId and ACKs all when withdrawn', async () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) CPA/1.0.0 Chrome/120.0.0.0 Electron/28.0.0 Safari/537.36',
            configurable: true,
        })

        const ackMock = vi.fn().mockResolvedValue(undefined)
        setHostBridge({
            SessionBroadcastRunStatus: broadcastRunStatusMock,
            SessionBroadcastStreamEvent: broadcastStreamEventMock,
            SessionAbortRun: abortRunMock,
            SessionDelegateRun: delegateRunMock,
            SessionClaimPendingDelegateRuns: vi.fn().mockResolvedValue([]),
            SessionAckDelegateRun: ackMock,
            onNativeEvent: vi.fn((cb: (event: any) => void) => {
                nativeEventListeners.push(cb)
                return () => {
                    const idx = nativeEventListeners.indexOf(cb)
                    if (idx >= 0) nativeEventListeners.splice(idx, 1)
                }
            }),
        } as any)

        let releaseHold: () => void = () => {}
        const hold = new Promise<void>((resolve) => {
            releaseHold = resolve
        })

        const multiRetryService = new FakeSyncService()
        const originalStreamChat = multiRetryService.streamChat.bind(multiRetryService)
        multiRetryService.streamChat = async function* (options: any) {
            await hold
            yield* originalStreamChat(options)
        }

        const sessId = 'multi-cb-steer-session'
        useSessionStore.getState().upsertRemoteSession({
            id: sessId,
            title: 'Multi CB Session',
            pinned: false,
            createdAt: Date.now() - 5000,
            updatedAt: Date.now() - 5000,
        })

        const { result, unmount } = renderHook(() => useAgentStream(sessId), {
            wrapper: createWrapper(multiRetryService),
        })

        await waitFor(() => {
            expect(result.current).not.toBeNull()
        })

        // 1. Start initial run
        act(() => {
            void result.current.send('First prompt')
        })

        await waitFor(() => {
            expect(result.current.isStreaming).toBe(true)
        })

        const emitNative = nativeEventListeners[0]!

        // 2. Deliver first steer delegation with userEntryId 'u-shared-steer' and requestId 'req-1'
        act(() => {
            emitNative({
                kind: 'session:delegate-run',
                data: JSON.stringify({
                    requestId: 'req-1',
                    sessionId: sessId,
                    userEntryId: 'u-shared-steer',
                    text: 'Same message content',
                    followUpMode: 'steer' as const,
                }),
            })
        })

        // 3. Deliver second steer delegation (retry) with the same userEntryId 'u-shared-steer' but different requestId 'req-2'
        act(() => {
            emitNative({
                kind: 'session:delegate-run',
                data: JSON.stringify({
                    requestId: 'req-2',
                    sessionId: sessId,
                    userEntryId: 'u-shared-steer',
                    text: 'Same message content',
                    followUpMode: 'steer' as const,
                }),
            })
        })

        await waitFor(() => {
            const rt = getRuntime(multiRetryService)
            expect(rt.pendingSteerCallbacks.get('u-shared-steer')?.length).toBe(2)
            expect(rt.pendingSteers.get(sessId)?.length).toBe(1)
        })

        // 4. User withdraws the steer message
        act(() => {
            const rt = getRuntime(multiRetryService)
            dequeueQueuedMessage(rt, sessId, 'u-shared-steer')
        })

        // Both req-1 and req-2 must be ACKed and released, neither forgotten!
        expect(ackMock).toHaveBeenCalledWith('req-1')
        expect(ackMock).toHaveBeenCalledWith('req-2')

        // Release run 1
        await act(async () => {
            releaseHold()
        })

        unmount()
    })

    it('cleans up and invalidates old pending steers when editing an earlier message', async () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) CPA/1.0.0 Chrome/120.0.0.0 Electron/28.0.0 Safari/537.36',
            configurable: true,
        })

        const ackMock = vi.fn().mockResolvedValue(undefined)
        setHostBridge({
            SessionBroadcastRunStatus: broadcastRunStatusMock,
            SessionBroadcastStreamEvent: broadcastStreamEventMock,
            SessionAbortRun: abortRunMock,
            SessionDelegateRun: delegateRunMock,
            SessionClaimPendingDelegateRuns: vi.fn().mockResolvedValue([]),
            SessionAckDelegateRun: ackMock,
            onNativeEvent: vi.fn((cb: (event: any) => void) => {
                nativeEventListeners.push(cb)
                return () => {
                    const idx = nativeEventListeners.indexOf(cb)
                    if (idx >= 0) nativeEventListeners.splice(idx, 1)
                }
            }),
        } as any)

        let releaseHoldA: () => void = () => {}
        const holdA = new Promise<void>((resolve) => {
            releaseHoldA = resolve
        })

        let runCount = 0
        let bConsumedAnySteer = false
        const editCleanService = new FakeSyncService()
        const originalStreamChat = editCleanService.streamChat.bind(editCleanService)
        editCleanService.streamChat = async function* (options: any) {
            runCount++
            if (runCount === 1) {
                const abortedPromise = new Promise<'aborted'>((resolve) => {
                    options.signal?.addEventListener('abort', () => resolve('aborted'), { once: true })
                })
                await Promise.race([holdA, abortedPromise])
                yield { type: 'aborted', runId: options.runId, sessionId: options.sessionId }
                return
            } else if (runCount === 2) {
                const consumed = options.consumeSteerEntries?.()
                if (consumed && consumed.length > 0) {
                    bConsumedAnySteer = true
                }
                yield* originalStreamChat(options)
            }
        }

        const sessId = 'edit-cleans-steer-session'
        useSessionStore.getState().upsertRemoteSession({
            id: sessId,
            title: 'Edit Cleans Steer Session',
            pinned: false,
            createdAt: Date.now() - 5000,
            updatedAt: Date.now() - 5000,
        })

        const { result, unmount } = renderHook(() => useAgentStream(sessId), {
            wrapper: createWrapper(editCleanService),
        })

        await waitFor(() => {
            expect(result.current).not.toBeNull()
        })

        // 1. Start flight A
        act(() => {
            void result.current.send('Prompt 1')
        })

        await waitFor(() => {
            expect(runCount).toBe(1)
        })

        const entries = useMessageStore.getState().getEntries(sessId)
        const initialUser = entries.find((e) => e.kind === 'user')!

        const emitNative = nativeEventListeners[0]!

        // 2. Deliver a steer delegation for flight A
        act(() => {
            emitNative({
                kind: 'session:delegate-run',
                data: JSON.stringify({
                    requestId: 'steer-for-a-to-be-cancelled',
                    sessionId: sessId,
                    text: 'Instruction for A that will be revoked by edit',
                    followUpMode: 'steer' as const,
                }),
            })
        })

        await waitFor(() => {
            const rt = getRuntime(editCleanService)
            expect(rt.pendingSteers.get(sessId)?.length).toBe(1)
        })

        // 3. User edits initial message, rewinding the history to before the steer
        act(() => {
            emitNative({
                kind: 'session:delegate-run',
                data: JSON.stringify({
                    requestId: 'edit-req-start-b',
                    sessionId: sessId,
                    editMessageId: initialUser.id,
                    text: 'Edited prompt starting flight B',
                }),
            })
        })

        // The superseded steer for flight A must immediately be cancelled, ACKed, and wiped
        await waitFor(() => {
            expect(ackMock).toHaveBeenCalledWith('steer-for-a-to-be-cancelled')
            const rt = getRuntime(editCleanService)
            expect(rt.pendingSteers.get(sessId)).toBeUndefined()
        })

        // Release flight A teardown
        await act(async () => {
            releaseHoldA()
        })

        await waitFor(() => {
            expect(runCount).toBe(2)
        })

        // Flight B must NEVER consume the revoked steer from flight A!
        expect(bConsumedAnySteer).toBe(false)

        unmount()
    })

    it('stop() cancels tasks waiting in sessionActionQueue and sends negative ACK without restarting the agent', async () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) CPA/1.0.0 Chrome/120.0.0.0 Electron/28.0.0 Safari/537.36',
            configurable: true,
        })

        const ackMock = vi.fn().mockResolvedValue(undefined)
        setHostBridge({
            SessionBroadcastRunStatus: broadcastRunStatusMock,
            SessionBroadcastStreamEvent: broadcastStreamEventMock,
            SessionAbortRun: abortRunMock,
            SessionDelegateRun: delegateRunMock,
            SessionClaimPendingDelegateRuns: vi.fn().mockResolvedValue([]),
            SessionAckDelegateRun: ackMock,
            onNativeEvent: vi.fn((cb: (event: any) => void) => {
                nativeEventListeners.push(cb)
                return () => {
                    const idx = nativeEventListeners.indexOf(cb)
                    if (idx >= 0) nativeEventListeners.splice(idx, 1)
                }
            }),
        } as any)

        let holdPrepareResolveA: () => void = () => {}
        const holdPrepareA = new Promise<void>((resolve) => {
            holdPrepareResolveA = resolve
        })

        let executedChatCount = 0
        const testService = new FakeSyncService()
        const originalPrepare = testService.prepare.bind(testService)
        testService.prepare = async (params: any) => {
            const abortedPromise = new Promise<'aborted'>((resolve) => {
                params.signal?.addEventListener('abort', () => resolve('aborted'), { once: true })
            })
            const res = await Promise.race([holdPrepareA, abortedPromise])
            if (res === 'aborted' || params.signal?.aborted) {
                const err = new Error('The operation was aborted')
                err.name = 'AbortError'
                throw err
            }
            return originalPrepare(params)
        }

        testService.streamChat = async function* (options: any) {
            executedChatCount++
            yield { type: 'agent-end', runId: options.runId, sessionId: options.sessionId }
        }

        const sessId = 'session-stop-queue-test'
        useSessionStore.getState().upsertRemoteSession({
            id: sessId,
            title: 'Stop Queue Session',
            pinned: false,
            createdAt: Date.now() - 5000,
            updatedAt: Date.now() - 5000,
        })

        const { result, unmount } = renderHook(() => useAgentStream(sessId), {
            wrapper: createWrapper(testService),
        })

        await waitFor(() => {
            expect(result.current).not.toBeNull()
        })

        // 1. Task A starts and hangs in prepare()
        act(() => {
            result.current.send('Task A prompt').catch(() => {})
        })

        await waitFor(() => {
            const rt = getRuntime(testService)
            expect(rt.pendingPreflights.size).toBe(1)
        })

        const emitNative = nativeEventListeners[0]!

        // 2. Deliver Task B via delegation while Task A is preparing. Task B queues in sessionActionQueue!
        act(() => {
            emitNative({
                kind: 'session:delegate-run',
                data: JSON.stringify({
                    requestId: 'req-task-b',
                    sessionId: sessId,
                    text: 'Task B prompt queued behind A',
                }),
            })
        })

        // 3. User calls stop() on this session
        await act(async () => {
            result.current.stop(sessId)
        })

        // Task B in sessionActionQueue must be cancelled and ACKed
        await waitFor(() => {
            expect(ackMock).toHaveBeenCalledWith('req-task-b')
        })

        // Release Task A prepare teardown if still waiting
        await act(async () => {
            holdPrepareResolveA()
        })

        // Wait a tick to ensure no further execution is triggered
        await new Promise((resolve) => setTimeout(resolve, 50))

        // Task B must NEVER have started streaming!
        expect(executedChatCount).toBe(0)

        unmount()
    })

    it('session:deleted cleans up pending items, prevents resurrection, and ACKs pending runs', async () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) CPA/1.0.0 Chrome/120.0.0.0 Electron/28.0.0 Safari/537.36',
            configurable: true,
        })

        const ackMock = vi.fn().mockResolvedValue(undefined)
        setHostBridge({
            SessionBroadcastRunStatus: broadcastRunStatusMock,
            SessionBroadcastStreamEvent: broadcastStreamEventMock,
            SessionAbortRun: abortRunMock,
            SessionDelegateRun: delegateRunMock,
            SessionClaimPendingDelegateRuns: vi.fn().mockResolvedValue([]),
            SessionAckDelegateRun: ackMock,
            onNativeEvent: vi.fn((cb: (event: any) => void) => {
                nativeEventListeners.push(cb)
                return () => {
                    const idx = nativeEventListeners.indexOf(cb)
                    if (idx >= 0) nativeEventListeners.splice(idx, 1)
                }
            }),
        } as any)

        let holdResolve: () => void = () => {}
        const hold = new Promise<void>((resolve) => {
            holdResolve = resolve
        })

        let runCount = 0
        const delService = new FakeSyncService()
        delService.streamChat = async function* (options: any) {
            runCount++
            const abortedPromise = new Promise<'aborted'>((resolve) => {
                options.signal?.addEventListener('abort', () => resolve('aborted'), { once: true })
            })
            await Promise.race([hold, abortedPromise])
            yield { type: 'aborted', runId: options.runId, sessionId: options.sessionId }
        }

        const doomedSessionId = 'doomed-session'
        useSessionStore.getState().upsertRemoteSession({
            id: doomedSessionId,
            title: 'Doomed Session',
            pinned: false,
            createdAt: Date.now() - 5000,
            updatedAt: Date.now() - 5000,
        })

        const { result, unmount } = renderHook(() => useAgentStream(doomedSessionId), {
            wrapper: createWrapper(delService),
        })

        await waitFor(() => {
            expect(result.current).not.toBeNull()
        })

        // 1. Start flight
        act(() => {
            void result.current.send('Initial prompt')
        })

        await waitFor(() => {
            expect(runCount).toBe(1)
        })

        const emitNative = nativeEventListeners[0]!

        // 2. Deliver steer and queue delegations
        act(() => {
            emitNative({
                kind: 'session:delegate-run',
                data: JSON.stringify({
                    requestId: 'steer-doomed',
                    sessionId: doomedSessionId,
                    text: 'Steer prompt',
                    followUpMode: 'steer' as const,
                }),
            })
        })

        await waitFor(() => {
            const rt = getRuntime(delService)
            expect(rt.pendingSteers.get(doomedSessionId)?.length).toBe(1)
        })

        // 3. Emit session:deleted event from host
        act(() => {
            emitNative({
                kind: 'session:deleted',
                data: JSON.stringify({ sessionId: doomedSessionId }),
            })
        })

        // Steer must be cancelled and ACKed
        await waitFor(() => {
            expect(ackMock).toHaveBeenCalledWith('steer-doomed')
        })

        const rt = getRuntime(delService)
        expect(rt.pendingSteers.get(doomedSessionId)).toBeUndefined()
        expect(rt.sessionQueues.get(doomedSessionId)).toBeUndefined()
        expect(rt.deletedSessionIds.has(doomedSessionId)).toBe(true)

        // 4. A late incoming delegate-run for this deleted session must be immediately rejected & ACKed without resurrection
        act(() => {
            emitNative({
                kind: 'session:delegate-run',
                data: JSON.stringify({
                    requestId: 'ghost-req',
                    sessionId: doomedSessionId,
                    text: 'Zombie message trying to resurrect deleted session',
                }),
            })
        })

        await waitFor(() => {
            expect(ackMock).toHaveBeenCalledWith('ghost-req')
        })

        // Session must NOT be recreated in session store
        const recreated = useSessionStore.getState().sessions.find((s) => s.id === doomedSessionId)
        expect(recreated).toBeUndefined()

        await act(async () => {
            holdResolve()
        })

        unmount()
    })

    it('browser send includes stable requestId derived from userEntryId to prevent duplicate runs across retries', async () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            configurable: true,
        })

        let capturedRequest: any = null
        const delegateMock = vi.fn().mockImplementation(async (req: any) => {
            capturedRequest = req
            return 'req-accepted'
        })

        setHostBridge({
            SessionBroadcastRunStatus: broadcastRunStatusMock,
            SessionBroadcastStreamEvent: broadcastStreamEventMock,
            SessionAbortRun: abortRunMock,
            SessionDelegateRun: delegateMock,
            SessionClaimPendingDelegateRuns: vi.fn().mockResolvedValue([]),
            SessionAckDelegateRun: vi.fn().mockResolvedValue(undefined),
            onNativeEvent: vi.fn(() => () => {}),
        } as any)

        const testService = new FakeSyncService()
        const sessId = 'browser-stable-req-session'
        useSessionStore.getState().upsertRemoteSession({
            id: sessId,
            title: 'Browser Stable Req Session',
            pinned: false,
            createdAt: Date.now() - 5000,
            updatedAt: Date.now() - 5000,
        })

        const { result, unmount } = renderHook(() => useAgentStream(sessId), {
            wrapper: createWrapper(testService),
        })

        await waitFor(() => {
            expect(result.current).not.toBeNull()
        })

        await act(async () => {
            await result.current.send('Testing stable requestId')
        })

        expect(delegateMock).toHaveBeenCalledTimes(1)
        expect(capturedRequest).not.toBeNull()
        expect(capturedRequest!.requestId).toBeDefined()
        expect(capturedRequest!.userEntryId).toBeDefined()
        expect(capturedRequest!.requestId).toBe(`req-${capturedRequest!.userEntryId}`)

        unmount()
    })

    it('remote session:abort-run cancels tasks waiting in sessionActionQueue and sends negative ACK', async () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) CPA/1.0.0 Chrome/120.0.0.0 Electron/28.0.0 Safari/537.36',
            configurable: true,
        })

        const ackMock = vi.fn().mockResolvedValue(undefined)
        setHostBridge({
            SessionBroadcastRunStatus: broadcastRunStatusMock,
            SessionBroadcastStreamEvent: broadcastStreamEventMock,
            SessionAbortRun: abortRunMock,
            SessionDelegateRun: delegateRunMock,
            SessionClaimPendingDelegateRuns: vi.fn().mockResolvedValue([]),
            SessionAckDelegateRun: ackMock,
            onNativeEvent: vi.fn((cb: (event: any) => void) => {
                nativeEventListeners.push(cb)
                return () => {
                    const idx = nativeEventListeners.indexOf(cb)
                    if (idx >= 0) nativeEventListeners.splice(idx, 1)
                }
            }),
        } as any)

        let holdPrepareResolveA: () => void = () => {}
        const holdPrepareA = new Promise<void>((resolve) => {
            holdPrepareResolveA = resolve
        })

        let executedChatCount = 0
        const testService = new FakeSyncService()
        const originalPrepare = testService.prepare.bind(testService)
        testService.prepare = async (params: any) => {
            const abortedPromise = new Promise<'aborted'>((resolve) => {
                params.signal?.addEventListener('abort', () => resolve('aborted'), { once: true })
            })
            const res = await Promise.race([holdPrepareA, abortedPromise])
            if (res === 'aborted' || params.signal?.aborted) {
                const err = new Error('The operation was aborted')
                err.name = 'AbortError'
                throw err
            }
            return originalPrepare(params)
        }

        testService.streamChat = async function* (options: any) {
            executedChatCount++
            yield { type: 'agent-end', runId: options.runId, sessionId: options.sessionId }
        }

        const sessId = 'session-remote-abort-queue-test'
        useSessionStore.getState().upsertRemoteSession({
            id: sessId,
            title: 'Remote Abort Queue Session',
            pinned: false,
            createdAt: Date.now() - 5000,
            updatedAt: Date.now() - 5000,
        })

        const { result, unmount } = renderHook(() => useAgentStream(sessId), {
            wrapper: createWrapper(testService),
        })

        await waitFor(() => {
            expect(result.current).not.toBeNull()
        })

        // 1. Task A starts and hangs in prepare()
        act(() => {
            result.current.send('Task A prompt').catch(() => {})
        })

        await waitFor(() => {
            const rt = getRuntime(testService)
            expect(rt.pendingPreflights.size).toBe(1)
        })

        const emitNative = nativeEventListeners[0]!

        // 2. Deliver Task B via delegation while Task A is preparing. Task B queues in sessionActionQueue!
        act(() => {
            emitNative({
                kind: 'session:delegate-run',
                data: JSON.stringify({
                    requestId: 'req-task-b-remote',
                    sessionId: sessId,
                    text: 'Task B prompt queued behind A',
                }),
            })
        })

        // 3. Deliver remote session:abort-run from host (e.g. user clicked stop on web client)
        await act(async () => {
            emitNative({
                kind: 'session:abort-run',
                data: JSON.stringify({ sessionId: sessId }),
            })
        })

        // Task B in sessionActionQueue must be cancelled and ACKed
        await waitFor(() => {
            expect(ackMock).toHaveBeenCalledWith('req-task-b-remote')
        })

        await act(async () => {
            holdPrepareResolveA()
        })

        await new Promise((resolve) => setTimeout(resolve, 50))
        expect(executedChatCount).toBe(0)

        unmount()
    })

    it('global stop() cancels newly queued tasks in never-stopped sessions via global epoch', async () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) CPA/1.0.0 Chrome/120.0.0.0 Electron/28.0.0 Safari/537.36',
            configurable: true,
        })

        const ackMock = vi.fn().mockResolvedValue(undefined)
        setHostBridge({
            SessionBroadcastRunStatus: broadcastRunStatusMock,
            SessionBroadcastStreamEvent: broadcastStreamEventMock,
            SessionAbortRun: abortRunMock,
            SessionDelegateRun: delegateRunMock,
            SessionClaimPendingDelegateRuns: vi.fn().mockResolvedValue([]),
            SessionAckDelegateRun: ackMock,
            onNativeEvent: vi.fn((cb: (event: any) => void) => {
                nativeEventListeners.push(cb)
                return () => {
                    const idx = nativeEventListeners.indexOf(cb)
                    if (idx >= 0) nativeEventListeners.splice(idx, 1)
                }
            }),
        } as any)

        let holdPrepareResolveA: () => void = () => {}
        const holdPrepareA = new Promise<void>((resolve) => {
            holdPrepareResolveA = resolve
        })

        let holdPrepareResolveB: () => void = () => {}
        const holdPrepareB = new Promise<void>((resolve) => {
            holdPrepareResolveB = resolve
        })

        let executedCount = 0
        const testService = new FakeSyncService()
        const originalPrepare = testService.prepare.bind(testService)
        testService.prepare = async (params: any) => {
            const abortedPromise = new Promise<'aborted'>((resolve) => {
                params.signal?.addEventListener('abort', () => resolve('aborted'), { once: true })
            })
            const hold = params.sessionId === 'session-stopped-once' ? holdPrepareA : holdPrepareB
            const res = await Promise.race([hold, abortedPromise])
            if (res === 'aborted' || params.signal?.aborted) {
                const err = new Error('The operation was aborted')
                err.name = 'AbortError'
                throw err
            }
            return originalPrepare(params)
        }

        testService.streamChat = async function* (options: any) {
            executedCount++
            yield { type: 'agent-end', runId: options.runId, sessionId: options.sessionId }
        }

        const sessionA = 'session-stopped-once'
        const sessionB = 'session-never-stopped'

        // Session A was stopped before, so its session-level epoch is 1
        bumpSessionActionEpoch(sessionA)

        useSessionStore.getState().upsertRemoteSession({
            id: sessionA,
            title: 'Session A',
            pinned: false,
            createdAt: Date.now() - 5000,
            updatedAt: Date.now() - 5000,
        })
        useSessionStore.getState().upsertRemoteSession({
            id: sessionB,
            title: 'Session B',
            pinned: false,
            createdAt: Date.now() - 5000,
            updatedAt: Date.now() - 5000,
        })

        // Unscoped hook with NO currentSessionId so stop() enters the true global branch!
        useSessionStore.getState().setCurrentSession(null)
        const { result, unmount } = renderHook(() => useAgentStream(null), {
            wrapper: createWrapper(testService),
        })

        await waitFor(() => {
            expect(result.current).not.toBeNull()
        })

        // Start preflight on Session A
        act(() => {
            result.current.send({ sessionId: sessionA, text: 'Task A1' }).catch(() => {})
        })

        // Start preflight on Session B
        act(() => {
            result.current.send({ sessionId: sessionB, text: 'Task B1' }).catch(() => {})
        })

        await waitFor(() => {
            const rt = getRuntime(testService)
            expect(rt.pendingPreflights.size).toBe(2)
        })

        const emitNative = nativeEventListeners[0]!

        // Queue Task A2 on Session A
        act(() => {
            emitNative({
                kind: 'session:delegate-run',
                data: JSON.stringify({
                    requestId: 'req-task-a2',
                    sessionId: sessionA,
                    text: 'Task A2 queued',
                }),
            })
        })

        // Queue Task B2 on Session B
        act(() => {
            emitNative({
                kind: 'session:delegate-run',
                data: JSON.stringify({
                    requestId: 'req-task-b2',
                    sessionId: sessionB,
                    text: 'Task B2 queued',
                }),
            })
        })

        // Global stop without sessionId and with currentSessionId = null
        await act(async () => {
            result.current.stop()
        })

        // Both Task A2 (previously stopped session) and Task B2 (never stopped session) must be cancelled and ACKed!
        await waitFor(() => {
            expect(ackMock).toHaveBeenCalledWith('req-task-a2')
            expect(ackMock).toHaveBeenCalledWith('req-task-b2')
        })

        await act(async () => {
            holdPrepareResolveA()
            holdPrepareResolveB()
        })

        await new Promise((resolve) => setTimeout(resolve, 50))
        expect(executedCount).toBe(0)

        unmount()
    })
})
