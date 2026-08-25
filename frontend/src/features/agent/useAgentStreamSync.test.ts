import { act, renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
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
import {
    AgentServiceProvider,
    __resetAgentStreamForTests,
    disposeAgentRuntime,
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
        requestApproval: false,
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

        expect(delegateRunMock).toHaveBeenCalledWith({
            sessionId,
            text: 'Delegated prompt from browser',
            images: undefined,
            projectId: 'test-project',
            branch: 'feature-branch',
            editMessageId: undefined,
            userEntryId: entries[0]?.id,
            userEntryCreatedAt: entries[0]?.createdAt,
        })

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

        expect(delegateRunMock).toHaveBeenCalledWith({
            sessionId: existingSessionId,
            text: 'Follow-up message in browser',
            images: undefined,
            projectId: 'proj-abc',
            branch: null,
            editMessageId: undefined,
            userEntryId: entries[0]?.id,
            userEntryCreatedAt: entries[0]?.createdAt,
        })
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
})
