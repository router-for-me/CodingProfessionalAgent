import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createElement, useSyncExternalStore } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { setDefaultHostServices } from '@cpa/plugin-ui'
import type { AppSettings, ChatSendPayload, ModelCatalogEntry, Project, SessionItem } from '@cpa/plugin-api'
import { rendererPluginRuntime } from '@/plugins/platform/RendererPluginRuntimeHost'
import { rendererEventBus } from '@/plugins/platform/eventBus'
import manifest from '../../manifest.json'
import { composerRendererEntry } from '../index.js'
import { ComposerContainer } from './ComposerContainer.js'

let currentPathname = '/'
let currentRouterState = { location: { pathname: '/' } }
const routerListeners = new Set<() => void>()

function setPathname(nextPath: string) {
    currentPathname = nextPath
    currentRouterState = { location: { pathname: nextPath } }
    const match = nextPath.match(/^\/chat\/([^/]+)/)
    if (match) {
        currentSessionIdState = match[1]
    }
    act(() => {
        for (const l of routerListeners) l()
    })
}

const navigateMock = vi.fn(
    (opts?: { to?: string; params?: { sessionId?: string } }) => {
        if (opts?.params?.sessionId) {
            setPathname(`/chat/${opts.params.sessionId}`)
        } else if (opts?.to) {
            setPathname(opts.to)
        }
        notifySessions()
        notifyRuns()
    },
)

vi.mock('@tanstack/react-router', () => ({
    useNavigate: () => navigateMock,
    useRouterState: ({
        select,
    }: {
        select?: (state: { location: { pathname: string } }) => unknown
    } = {}) => {
        return useSyncExternalStore(
            (cb) => {
                routerListeners.add(cb)
                return () => routerListeners.delete(cb)
            },
            () => (select ? select(currentRouterState) : currentRouterState),
            () => (select ? select(currentRouterState) : currentRouterState),
        )
    },
}))

class MockAgentRuntime {
    activeRuns: Record<string, any> = {}
    abortCalls: (string | undefined)[] = []
    streamChatCalls: any[] = []
    streamHold: Promise<void> | null = null

    async send(payload: ChatSendPayload): Promise<string> {
        const sessionId = payload.sessionId || `session-${Date.now()}`

        // Interrupt prior run for this session if active
        if (this.activeRuns[sessionId] && this.activeRuns[sessionId].status !== 'idle') {
            this.abortCalls.push(this.activeRuns[sessionId].runId)
        }

        const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
        this.activeRuns[sessionId] = {
            sessionId,
            runId,
            status: 'running',
            updatedAt: Date.now(),
        }
        notifyRuns()

        if (payload.onSessionAccepted) {
            payload.onSessionAccepted(sessionId)
        }

        this.streamChatCalls.push({ ...payload, sessionId, runId })

        void (async () => {
            if (this.streamHold) {
                await this.streamHold
            }
            if (this.activeRuns[sessionId]?.runId === runId) {
                this.activeRuns[sessionId] = {
                    sessionId,
                    runId,
                    status: 'idle',
                    updatedAt: Date.now(),
                }
                notifyRuns()
            }
        })()

        return sessionId
    }

    stop(sessionId?: string): void {
        const target = sessionId ?? currentSessionIdState
        if (target && this.activeRuns[target]) {
            const runId = this.activeRuns[target].runId
            this.abortCalls.push(runId)
            delete this.activeRuns[target]
            notifyRuns()
        }
    }

    abort(sessionId?: string): void {
        this.stop(sessionId)
    }
}

const EMPTY_PROMPTS_LIST: readonly any[] = Object.freeze([])
const agentRunStateCacheMap = new Map<string, any>()

function getCachedAgentRunState(sessionId: string) {
    if (!sessionId) {
        return { isStreaming: false, activeRunId: null }
    }
    const runState = mockAgent.activeRuns[sessionId] ?? remoteRuns[sessionId]
    const isStreaming = Boolean(runState && runState.status !== 'idle')
    const activeRunId = runState?.runId ?? null
    const cached = agentRunStateCacheMap.get(sessionId)
    if (
        cached &&
        cached.isStreaming === isStreaming &&
        cached.activeRunId === activeRunId &&
        cached.runState === runState
    ) {
        return cached
    }
    const next = { isStreaming, activeRunId, runState }
    agentRunStateCacheMap.set(sessionId, next)
    return next
}

const testModel: ModelCatalogEntry = {
    id: 'test-model',
    label: 'Test Model',
    supportsFast: true,
    reasoningLevels: [],
    input: ['text', 'image'],
    contextWindow: 128_000,
    maxTokens: 4_096,
}

let settingsState: AppSettings
let modelsState: readonly ModelCatalogEntry[]
let sessionsState: SessionItem[]
let projectsState: Project[]
let worktreeSetupsState: Record<string, any>
let composerDraftsState: Record<string, string>
let pendingSessionContextState: any
let toastsState: string[]
let currentSessionIdState: string | null
let mockAgent: MockAgentRuntime
let remoteRuns: Record<string, any>
let mockServices: any

let settingsListeners: Set<() => void>
let sessionsListeners: Set<() => void>
let projectsListeners: Set<() => void>
let uiListeners: Set<() => void>
let runsListeners: Set<() => void>
let cachedUiSnapshot: any

function notifySettings() {
    act(() => {
        for (const l of settingsListeners) l()
    })
}
function notifySessions() {
    act(() => {
        for (const l of sessionsListeners) l()
    })
}
function notifyProjects() {
    act(() => {
        for (const l of projectsListeners) l()
    })
}
function notifyUi() {
    cachedUiSnapshot = {
        composerDraft: composerDraftsState['new-chat'] ?? '',
        composerDrafts: { ...composerDraftsState },
        pendingSessionContext: { ...pendingSessionContextState },
        toasts: [...toastsState],
    }
    act(() => {
        for (const l of uiListeners) l()
    })
}
function notifyRuns() {
    act(() => {
        for (const l of runsListeners) l()
    })
}

const EMPTY_SKILL_USAGE = Object.freeze({})

let resumableSessions = new Set<string>()
const resumableListeners = new Set<() => void>()
function notifyResumable() {
    for (const listener of resumableListeners) listener()
}

let sessionMessages: Record<string, any[]> = {}
const EMPTY_DISPLAY_MESSAGES = Object.freeze([])
const messageListeners = new Set<() => void>()
function notifyMessages() {
    for (const listener of messageListeners) listener()
}

function resetServices() {
    settingsListeners = new Set()
    sessionsListeners = new Set()
    projectsListeners = new Set()
    uiListeners = new Set()
    runsListeners = new Set()

    mockAgent = new MockAgentRuntime()
    remoteRuns = {}
    sessionMessages = {}
    messageListeners.clear()

    settingsState = {
        theme: 'dark',
        locale: 'zh-CN',
        modelId: 'test-model',
        reasoningLevel: 'off',
        speed: 'standard',
        requestApproval: false,
        compactionThresholdPercent: 80,
        fastContextCompaction: true,
        showInMenuBar: true,
        showBottomPanel: true,
        terminalPosition: 'bottom',
        cliProxyApi: { baseUrl: '', apiKey: '' },
    }
    modelsState = [testModel]
    sessionsState = []
    projectsState = []
    worktreeSetupsState = {}
    composerDraftsState = {}
    pendingSessionContextState = { projectId: null, branch: null }
    toastsState = []
    currentSessionIdState = null

    cachedUiSnapshot = {
        composerDraft: '',
        composerDrafts: {},
        pendingSessionContext: { projectId: null, branch: null },
        toasts: [],
    }

    mockServices = {
        settings: {
            getSnapshot: () => settingsState,
            subscribe: (listener: () => void) => {
                settingsListeners.add(listener)
                return () => settingsListeners.delete(listener)
            },
            setModelId: vi.fn((id: string) => {
                settingsState = { ...settingsState, modelId: id }
                notifySettings()
            }),
            setReasoningLevel: vi.fn((level: string) => {
                settingsState = { ...settingsState, reasoningLevel: level }
                notifySettings()
            }),
            setSpeed: vi.fn((spd: any) => {
                settingsState = { ...settingsState, speed: spd }
                notifySettings()
            }),
            setRequestApproval: vi.fn((val: boolean) => {
                settingsState = { ...settingsState, requestApproval: val }
                notifySettings()
            }),
        },
        models: {
            getModels: () => modelsState,
            getStatus: () => 'ready',
            getError: () => null,
            subscribe: (listener: () => void) => () => {},
        },
        sessions: {
            getSnapshot: () => sessionsState,
            subscribe: (listener: () => void) => {
                sessionsListeners.add(listener)
                return () => sessionsListeners.delete(listener)
            },
            getCurrentSessionId: () => {
                const match = currentPathname.match(/^\/chat\/([^/]+)/)
                return match?.[1] ?? currentSessionIdState
            },
            setCurrentSessionId: (id: string | null) => {
                currentSessionIdState = id
                if (id) {
                    currentPathname = `/chat/${id}`
                } else {
                    currentPathname = '/'
                }
                notifySessions()
            },
            getActiveRun: (sessionId: string) => mockAgent.activeRuns[sessionId] ?? remoteRuns[sessionId],
            subscribeRuns: (listener: () => void) => {
                runsListeners.add(listener)
                return () => runsListeners.delete(listener)
            },
            setProject: vi.fn((sessionId: string, projId: string | null) => {
                const s = sessionsState.find((item) => item.id === sessionId)
                if (s) s.projectId = projId ?? undefined
                notifySessions()
            }),
            setBranch: vi.fn((sessionId: string, br: string | null) => {
                const s = sessionsState.find((item) => item.id === sessionId)
                if (s) s.branch = br ?? undefined
                notifySessions()
            }),
            setSessionRuntimeSettings: vi.fn(
                (
                    sessionId: string,
                    patch: { modelId?: string; reasoningEffort?: string; speed?: any },
                ) => {
                    const session = sessionsState.find((s) => s.id === sessionId)
                    if (session) {
                        if (patch.modelId !== undefined) session.modelId = patch.modelId
                        if (patch.reasoningEffort !== undefined)
                            session.reasoningEffort = patch.reasoningEffort
                        if (patch.speed !== undefined) session.speed = patch.speed
                    }
                    notifySessions()
                },
            ),
            update: vi.fn(async (sessionId: string, patch: any) => {
                const session = sessionsState.find((s) => s.id === sessionId)
                if (session) {
                    Object.assign(session, patch)
                }
                notifySessions()
            }),
            setWorktree: vi.fn(async (sessionId: string, setup: any) => {
                const session = sessionsState.find((s) => s.id === sessionId)
                if (session) {
                    session.worktreeSetup = {
                        ...(session.worktreeSetup as any),
                        ...setup,
                    }
                }
                notifySessions()
            }),
        },
        projects: {
            getSnapshot: () => projectsState,
            subscribe: (listener: () => void) => {
                projectsListeners.add(listener)
                return () => projectsListeners.delete(listener)
            },
            save: vi.fn(async (p: Project) => {
                projectsState.push(p)
                notifyProjects()
            }),
        },
        ui: {
            getSnapshot: () => cachedUiSnapshot,
            subscribe: (listener: () => void) => {
                uiListeners.add(listener)
                return () => uiListeners.delete(listener)
            },
            getPendingSessionContext: () => pendingSessionContextState,
            setPendingSessionContext: vi.fn((ctx: any) => {
                pendingSessionContextState = { ...pendingSessionContextState, ...ctx }
                notifyUi()
            }),
            getComposerDraft: (key: string) => composerDraftsState[key],
            setComposerDraft: vi.fn((key: string, draft: string) => {
                composerDraftsState[key] = draft
                notifyUi()
            }),
            pushToast: vi.fn((msg: string) => {
                toastsState.push(msg)
                notifyUi()
            }),
        },
        chatMessages: {
            getWorktreeSetup: (sessionId: string) => worktreeSetupsState[sessionId],
            getEntries: () => [],
            getAgentRunState: (sessionId: string) => getCachedAgentRunState(sessionId),
            subscribeAgentRunState: (_sessionId: string, listener: () => void) => {
                runsListeners.add(listener)
                return () => runsListeners.delete(listener)
            },
            getSupportsImages: () => true,
            subscribeSupportsImages: (_sessionId: string | null, _listener: () => void) => {
                return () => {}
            },
            getPrompts: () => EMPTY_PROMPTS_LIST,
            subscribePrompts: () => () => {},
            send: vi.fn(async (payload: ChatSendPayload) => {
                if (payload.sessionId && remoteRuns[payload.sessionId]) {
                    abortRunMock(payload.sessionId)
                    delete remoteRuns[payload.sessionId]
                    notifyRuns()
                }
                const sId = await mockAgent.send(payload)
                if (!sessionsState.some((s) => s.id === sId)) {
                    sessionsState.push({
                        id: sId,
                        title: payload.text.slice(0, 20),
                        pinned: false,
                        createdAt: Date.now(),
                        updatedAt: Date.now(),
                    })
                    notifySessions()
                }
                return sId
            }),
            stop: vi.fn((sessionId?: string | null) => {
                const target = sessionId ?? mockServices.sessions.getCurrentSessionId()
                if (target && remoteRuns[target]) {
                    abortRunMock(target)
                    delete remoteRuns[target]
                    notifyRuns()
                    return
                }
                mockAgent.stop(target ?? undefined)
            }),
            abort: vi.fn((sessionId?: string | null) => {
                mockServices.chatMessages.stop(sessionId)
            }),
            resumeSession: vi.fn(async (sessionId: string) => {
                return sessionId
            }),
            isSessionResumable: vi.fn((sessionId: string) => {
                return resumableSessions.has(sessionId)
            }),
            subscribeSessionResumable: vi.fn((_sessionId: string, listener: () => void) => {
                resumableListeners.add(listener)
                return () => resumableListeners.delete(listener)
            }),
            getDisplayMessages: vi.fn((sessionId: string) => {
                return sessionMessages[sessionId] ?? EMPTY_DISPLAY_MESSAGES
            }),
            subscribeMessages: vi.fn((_sessionId: string, listener: () => void) => {
                messageListeners.add(listener)
                return () => messageListeners.delete(listener)
            }),
        },
        navigation: {
            navigate: vi.fn(async (to: any) => {
                const path = typeof to === 'string' ? to : to.to
                if (path) {
                    currentPathname = path
                    notifySessions()
                }
            }),
        },
        skillUsage: {
            fetchUsageCounts: vi.fn(async () => ({})),
            recordUsage: vi.fn(),
            getSnapshot: () => EMPTY_SKILL_USAGE,
            subscribe: () => () => {},
        },
    }
    setDefaultHostServices(mockServices)
}

let abortRunMock: ReturnType<typeof vi.fn>
let broadcastRunStatusMock: ReturnType<typeof vi.fn>

describe('ComposerContainer Integration', () => {
    beforeEach(async () => {
        await i18n.changeLanguage('en')
        resumableSessions = new Set<string>()
        resumableListeners.clear()
        setPathname('/')
        navigateMock.mockReset()
        navigateMock.mockImplementation(
            (opts?: { to?: string; params?: { sessionId?: string } }) => {
                if (opts?.params?.sessionId) {
                    setPathname(`/chat/${opts.params.sessionId}`)
                } else if (opts?.to) {
                    setPathname(opts.to)
                }
                notifySessions()
                notifyRuns()
            },
        )
        resetServices()

        abortRunMock = vi.fn().mockResolvedValue(undefined)
        broadcastRunStatusMock = vi.fn().mockResolvedValue(undefined)

        await rendererPluginRuntime.registerPlugin({ manifest, ...composerRendererEntry } as any)
        await rendererPluginRuntime.activatePlugin('cpa.core.composer')
    })

    afterEach(async () => {
        await rendererPluginRuntime.reset()
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
    })

    it('clears an accepted worktree draft before opening another new session', async () => {
        projectsState = [
            {
                id: 'worktree-project',
                name: 'Worktree project',
                path: '/projects/worktree-project',
                pinned: false,
                createdAt: 1,
                updatedAt: 1,
            },
        ]
        pendingSessionContextState = {
            projectId: 'worktree-project',
            branch: 'main',
            workLocation: 'worktree',
            environmentId: null,
        }
        notifyProjects()
        notifyUi()

        const { rerender } = render(<ComposerContainer />)

        const textarea = screen.getByTestId('composer-input')
        await userEvent.type(textarea, 'Create a worktree session')
        fireEvent.keyDown(textarea, { key: 'Enter' })

        await waitFor(() => {
            expect(sessionsState).toHaveLength(1)
        })
        const sessionId = sessionsState[0]!.id

        expect(navigateMock).toHaveBeenCalledWith({
            to: '/chat/$sessionId',
            params: { sessionId },
        })
        expect(textarea).toHaveAttribute('data-value', '')

        setPathname('/')
        act(() => {
            mockServices.sessions.setCurrentSessionId(null)
        })
        rerender(<ComposerContainer />)

        const nextSessionTextarea = screen.getByTestId('composer-input')
        expect(nextSessionTextarea).toHaveAttribute('data-value', '')
        await userEvent.type(nextSessionTextarea, 'Next session draft')
        expect(nextSessionTextarea).toHaveAttribute('data-value', 'Next session draft')
    })

    it('Host mode stop triggers local abort without calling SessionAbortRun', async () => {
        const user = userEvent.setup()
        let releaseHold: () => void = () => {}
        mockAgent.streamHold = new Promise<void>((resolve) => {
            releaseHold = resolve
        })

        render(<ComposerContainer />)

        const textarea = screen.getByTestId('composer-input')
        await user.type(textarea, 'Host mode message')
        await user.keyboard('{Enter}')

        await waitFor(() => {
            console.log('streamChatCalls:', mockAgent.streamChatCalls)
            expect(mockAgent.streamChatCalls.length).toBe(1)
        })

        // Wait for streaming to become active
        const stopBtn = await screen.findByRole('button', { name: 'Stop' })
        expect(stopBtn).toBeInTheDocument()

        // Clicking stop in host mode triggers local abort
        await user.click(stopBtn)

        expect(mockAgent.abortCalls.length).toBeGreaterThan(0)
        expect(abortRunMock).not.toHaveBeenCalled()

        releaseHold()
    })

    it('stops active streaming session when composer:stop event is emitted', async () => {
        const user = userEvent.setup()
        let releaseHold: () => void = () => {}
        mockAgent.streamHold = new Promise<void>((resolve) => {
            releaseHold = resolve
        })

        const sessionId = 'test-esc-stop'
        setPathname(`/chat/${sessionId}`)
        sessionsState = [
            {
                id: sessionId,
                title: 'Test ESC Stop',
                pinned: false,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            },
        ]
        notifySessions()

        render(<ComposerContainer />)

        const textarea = screen.getByTestId('composer-input')
        await user.type(textarea, 'Running message')
        await user.keyboard('{Enter}')

        const stopBtn = await screen.findByRole('button', { name: 'Stop' })
        expect(stopBtn).toBeInTheDocument()

        // Emit composer:stop event (as triggered by ESC shortcut)
        rendererEventBus.emit('composer:stop')

        await waitFor(() => {
            expect(mockServices.chatMessages.stop).toHaveBeenCalledWith(sessionId)
        })

        releaseHold()
    })

    it('shows resume button after stopping session and resumes when clicked', async () => {
        const user = userEvent.setup()
        let releaseHold: () => void = () => {}
        mockAgent.streamHold = new Promise<void>((resolve) => {
            releaseHold = resolve
        })

        const sessionId = 'resumable-session-1'
        setPathname(`/chat/${sessionId}`)
        sessionsState = [
            {
                id: sessionId,
                title: 'Test Resumable',
                pinned: false,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            },
        ]
        notifySessions()

        render(<ComposerContainer />)

        const textarea = screen.getByTestId('composer-input')
        await user.type(textarea, 'Start something')
        await user.keyboard('{Enter}')

        // Wait for streaming stop button
        const stopBtn = await screen.findByRole('button', { name: 'Stop' })
        expect(stopBtn).toBeInTheDocument()

        // Stop session
        await user.click(stopBtn)
        releaseHold()

        // After stopping the session and run ends, input is empty, resume button should appear
        const resumeBtn = await screen.findByRole('button', { name: 'Resume' })
        expect(resumeBtn).toBeInTheDocument()

        // Clicking resume triggers resumeSession
        await user.click(resumeBtn)
        expect(mockServices.chatMessages.resumeSession).toHaveBeenCalledWith(sessionId)
    })

    it('shows default disabled send button instead of resume button when current turn is completed', async () => {
        const sessionId = 'completed-turn-session'
        setPathname(`/chat/${sessionId}`)
        sessionsState = [
            {
                id: sessionId,
                title: 'Test Completed Turn',
                pinned: false,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            },
        ]
        notifySessions()

        sessionMessages[sessionId] = [
            { kind: 'message', role: 'user', content: 'hello' },
            { kind: 'message', role: 'assistant', status: 'done', content: 'hi there' },
        ]
        notifyMessages()

        resumableSessions.add(sessionId)
        notifyResumable()

        render(<ComposerContainer />)

        // Resume button must NOT appear; default disabled Send button must appear
        expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument()
        const sendBtn = screen.getByRole('button', { name: 'Send' })
        expect(sendBtn).toBeInTheDocument()
        expect(sendBtn).toBeDisabled()
    })

    it('Mirror mode stop triggers SessionAbortRun', async () => {
        const remoteSessionId = 'mirror-session-test'
        setPathname(`/chat/${remoteSessionId}`)

        sessionsState = [
            {
                id: remoteSessionId,
                title: 'Remote Session',
                pinned: false,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            },
        ]
        currentSessionIdState = remoteSessionId

        // Active run set remotely (not in mockAgent.activeRuns)
        remoteRuns[remoteSessionId] = {
            sessionId: remoteSessionId,
            runId: 'remote-run-abc',
            status: 'running',
            clientId: 'remote-host-client',
            updatedAt: Date.now(),
        }
        notifySessions()
        notifyRuns()

        render(<ComposerContainer />)

        // Since remote is running, Stop button should be shown
        const stopBtn = screen.getByRole('button', { name: 'Stop' })
        expect(stopBtn).toBeInTheDocument()

        // Clicking stop in mirror mode calls SessionAbortRun
        await userEvent.click(stopBtn)

        expect(abortRunMock).toHaveBeenCalledWith(remoteSessionId)
        expect(mockAgent.abortCalls).toHaveLength(0)
    })

    it('sending during Mirror mode triggers SessionAbortRun and sends the new prompt', async () => {
        const remoteSessionId = 'mirror-session-send-test'
        setPathname(`/chat/${remoteSessionId}`)

        sessionsState = [
            {
                id: remoteSessionId,
                title: 'Remote Session',
                pinned: false,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            },
        ]
        currentSessionIdState = remoteSessionId

        remoteRuns[remoteSessionId] = {
            sessionId: remoteSessionId,
            runId: 'remote-run-xyz',
            status: 'running',
            clientId: 'remote-host-client',
            updatedAt: Date.now(),
        }
        notifySessions()
        notifyRuns()

        render(<ComposerContainer />)

        const textarea = screen.getByTestId('composer-input')
        await userEvent.type(textarea, 'takeover message')
        fireEvent.keyDown(textarea, { key: 'Enter' })

        expect(abortRunMock).toHaveBeenCalledWith(remoteSessionId)

        await waitFor(() => {
            expect(mockAgent.streamChatCalls.length).toBe(1)
            const lastCall = mockAgent.streamChatCalls[0]!
            expect(lastCall.text).toBe('takeover message')
        })
    })

    it('sending during Host streaming interrupts and sends the new prompt successfully', async () => {
        const user = userEvent.setup()
        let releaseHold: () => void = () => {}
        mockAgent.streamHold = new Promise<void>((resolve) => {
            releaseHold = resolve
        })

        render(<ComposerContainer />)

        const textarea = screen.getByTestId('composer-input')
        await user.type(textarea, 'first message')
        fireEvent.keyDown(textarea, { key: 'Enter' })

        // Wait for first run to begin streaming
        await screen.findByRole('button', { name: 'Stop' })
        expect(mockAgent.abortCalls).toHaveLength(0)

        // Type second prompt while streaming is active
        await user.type(textarea, 'second prompt')
        fireEvent.keyDown(textarea, { key: 'Enter' })

        // First run should be aborted
        await waitFor(() => {
            expect(mockAgent.abortCalls.length).toBeGreaterThan(0)
        })

        mockAgent.streamHold = null
        releaseHold()

        await waitFor(() => {
            expect(mockAgent.streamChatCalls.length).toBe(2)
            expect(mockAgent.streamChatCalls[1]?.text).toBe('second prompt')
        })
    })

    it('Composer input is not locked during active runs', async () => {
        const remoteSessionId = 'mirror-session-input-test'
        setPathname(`/chat/${remoteSessionId}`)

        sessionsState = [
            {
                id: remoteSessionId,
                title: 'Remote Session',
                pinned: false,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            },
        ]
        currentSessionIdState = remoteSessionId

        remoteRuns[remoteSessionId] = {
            sessionId: remoteSessionId,
            runId: 'remote-run-123',
            status: 'running',
            clientId: 'remote-host',
            updatedAt: Date.now(),
        }
        notifySessions()
        notifyRuns()

        render(<ComposerContainer />)

        const textarea = screen.getByTestId('composer-input')
        expect(textarea).not.toHaveAttribute('aria-disabled', 'true')
        expect(textarea).toHaveAttribute('contenteditable', 'true')

        await userEvent.type(textarea, 'typing while active')
        expect(textarea).toHaveAttribute('data-value', 'typing while active')
    })

    it('Composer in Session 2 is completely unlocked and can send concurrently while Session 1 is executing', async () => {
        let release1!: () => void
        const hold1 = new Promise<void>((resolve) => {
            release1 = resolve
        })

        const s1 = 'session-running-1'
        const s2 = 'session-idle-2'

        sessionsState = [
            {
                id: s1,
                title: 'Session 1',
                pinned: false,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            },
            {
                id: s2,
                title: 'Session 2',
                pinned: false,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            },
        ]
        currentSessionIdState = s1
        setPathname(`/chat/${s1}`)

        mockAgent.streamHold = hold1

        const { rerender } = render(<ComposerContainer />)

        // Session 1: send prompt
        const textarea = screen.getByTestId('composer-input')
        await userEvent.type(textarea, 'session 1 prompt')
        fireEvent.keyDown(textarea, { key: 'Enter' })

        // Session 1 is now streaming: Stop button is shown
        await screen.findByRole('button', { name: 'Stop' })

        // Switch route to Session 2
        setPathname(`/chat/${s2}`)
        currentSessionIdState = s2
        notifySessions()

        rerender(<ComposerContainer />)

        // In Session 2, Stop button is NOT shown, Send button IS shown, controls are not locked
        expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument()
        const sendBtn = screen.getByRole('button', { name: 'Send' })
        expect(sendBtn).toBeInTheDocument()

        const checkbox = screen.getByRole('checkbox')
        expect(checkbox).not.toBeDisabled()

        // Send prompt in Session 2
        const textarea2 = screen.getByTestId('composer-input')
        await userEvent.type(textarea2, 'session 2 concurrent prompt')
        fireEvent.keyDown(textarea2, { key: 'Enter' })

        await waitFor(() => {
            expect(mockAgent.streamChatCalls.length).toBe(2)
            expect(mockAgent.streamChatCalls[0]?.sessionId).toBe(s1)
            expect(mockAgent.streamChatCalls[1]?.sessionId).toBe(s2)
        })

        // Session 1 was not aborted by Session 2 send
        expect(mockAgent.abortCalls).toHaveLength(0)

        mockAgent.streamHold = null
        release1()
    })

    it('Composer in a new session (home /) is completely unlocked, shows send button, and does not inherit active running state from background session', async () => {
        const s1 = 'session-running-bg'
        sessionsState = [
            { id: s1, title: 'Session 1 BG', pinned: false, createdAt: 1, updatedAt: 1 },
        ]
        setPathname(`/chat/${s1}`)
        currentSessionIdState = s1

        let release1: () => void = () => {}
        const hold1 = new Promise<void>((resolve) => {
            release1 = resolve
        })
        mockAgent.streamHold = hold1

        const { rerender } = render(<ComposerContainer />)

        // Session 1: send prompt
        const textarea = screen.getByTestId('composer-input')
        await userEvent.type(textarea, 'background task running')
        fireEvent.keyDown(textarea, { key: 'Enter' })

        // Session 1 is now streaming: Stop button is shown
        await screen.findByRole('button', { name: 'Stop' })

        // Now open a brand new session: navigate to '/' with null session
        setPathname('/')
        currentSessionIdState = null
        notifySessions()

        rerender(<ComposerContainer />)

        // In new session, Stop button is NOT shown, Send button IS shown
        expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument()
        const sendBtn = screen.getByRole('button', { name: 'Send' })
        expect(sendBtn).toBeInTheDocument()

        // Composer input is editable and not disabled
        const nextTextarea = screen.getByTestId('composer-input')
        expect(nextTextarea).not.toHaveAttribute('aria-disabled', 'true')
        expect(nextTextarea).toHaveAttribute('contenteditable', 'true')

        // Context controls and toolbar controls are not locked
        const checkbox = screen.getByRole('checkbox')
        expect(checkbox).not.toBeDisabled()

        mockAgent.streamHold = null
        release1()
    })

    it('returns null when route is not home or chat', () => {
        setPathname('/scheduled')
        const { container } = render(<ComposerContainer />)
        expect(container.firstChild).toBeNull()
    })
})
