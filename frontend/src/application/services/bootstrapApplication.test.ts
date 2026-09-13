import { afterEach, describe, expect, it, vi } from 'vitest'
import { rendererRegistry } from '@/plugins/platform/rendererRegistry'
import { rendererPluginRuntime } from '@/plugins/platform/RendererPluginRuntimeHost'
import { bootstrapApplication, resyncFromMain } from './bootstrapApplication'
import { setHostBridge } from './hostTransport'
import { __resetPersistenceForTests } from './persistenceService'
import { useSessionRunStore } from '@/stores/sessionRunStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useMessageStore } from '@/stores/messageStore'
import { useProjectStore } from '@/stores/projectStore'
import { useUiStore } from '@/stores/uiStore'
import type { Session } from '@/types/models'

describe('bootstrapApplication', () => {
    afterEach(async () => {
        setHostBridge(null);
        __resetPersistenceForTests()
        useProjectStore.setState({ projects: [] })
        await rendererPluginRuntime.reset()
        rendererRegistry.clear()
        vi.restoreAllMocks()
    })

    it('registers and activates core plugins and initializes persistence', async () => {
        setHostBridge({
            StorageGet: vi.fn().mockResolvedValue(null),
            StorageSet: vi.fn().mockResolvedValue(undefined),
            ClipboardSetText: vi.fn().mockResolvedValue(undefined),
            PluginsScan: vi.fn().mockResolvedValue([]),
        } as any)

        await bootstrapApplication()

        expect(rendererPluginRuntime.isPluginActive('cpa.core.session-manager')).toBe(true)
        expect(rendererPluginRuntime.isPluginActive('cpa.core.chat')).toBe(true)
        expect(rendererPluginRuntime.isPluginActive('cpa.core.composer')).toBe(true)
        expect(rendererPluginRuntime.isPluginActive('cpa.core.terminal')).toBe(true)
        expect(rendererPluginRuntime.isPluginActive('cpa.core.subagent')).toBe(true)
        expect(rendererPluginRuntime.isPluginActive('cpa.core.settings')).toBe(true)
        expect(rendererPluginRuntime.isPluginActive('cpa.core.protocol-codex')).toBe(true)
        expect(rendererPluginRuntime.isPluginActive('cpa.core.usage-stats')).toBe(true)
        expect(rendererPluginRuntime.isPluginActive('cpa.core.tools')).toBe(true)
        expect(rendererPluginRuntime.isPluginActive('cpa.core.resources')).toBe(true)
        expect(rendererPluginRuntime.getPluginSummary('cpa.core.tools').status).toBe('active')
        expect(rendererPluginRuntime.getPluginSummary('cpa.core.resources').status).toBe('active')
        expect(rendererRegistry.getProtocolProvider('codex-responses-ws')).toBeDefined()
        expect(rendererRegistry.getSlotContributions('layout.sidebar.nav.top')).toHaveLength(1)
        expect(rendererRegistry.getSlotContributions('layout.sidebar.content')).toHaveLength(1)
        expect(rendererRegistry.getComposerControls('toolbar-right')).toHaveLength(2)
        expect(rendererRegistry.getSlotContributions('chat.message.header')).toHaveLength(1)
        expect(rendererRegistry.getSlotContributions('layout.bottom_panel.content')).toHaveLength(1)
        expect(rendererRegistry.getSlotContributions('layout.right_panel.content')).toHaveLength(1)
        expect(rendererRegistry.getSettingsSections()).toHaveLength(14)
        expect(rendererRegistry.getSettingsSections().some((s) => s.id === 'subagents')).toBe(true)
    })

    it('scans and activates external catalog packages during startup', async () => {
        const externalManifest = {
            id: 'external.disk.plugin',
            name: 'External Disk Plugin',
            version: '1.0.0',
            apiVersion: '1.0.0',
            engines: { cpa: '>=1.0.0' },
            entries: { renderer: './index.ts' },
            dependencies: {},
            capabilities: [],
            contributes: {},
        }
        const externalEntry = {
            runtime: 'renderer' as const,
            activate: () => {},
        }
        await rendererPluginRuntime.registerPlugin(externalManifest, externalEntry, { source: { kind: 'project-config', spec: 'external.disk.plugin@1.0.0' } })

        setHostBridge({
            StorageGet: vi.fn().mockResolvedValue(null),
            StorageSet: vi.fn().mockResolvedValue(undefined),
            ClipboardSetText: vi.fn().mockResolvedValue(undefined),
        } as any)

        await bootstrapApplication()

        expect(rendererPluginRuntime.isPluginActive('external.disk.plugin')).toBe(true)
    })

    it('hydrates initial active runs and processes native session events', async () => {
        let nativeEventHandler: ((event: any) => void) | null = null
        const onNativeEventMock = vi.fn((cb: (event: any) => void) => {
            nativeEventHandler = cb
            return () => {}
        })

        const activeRunsMock = [
            {
                sessionId: 'sess-init-1',
                runId: 'run-init-1',
                clientId: 'client-desktop',
                status: 'running' as const,
                updatedAt: Date.now(),
            },
        ]

        setHostBridge({
            StorageGet: vi.fn().mockResolvedValue(null),
            StorageSet: vi.fn().mockResolvedValue(undefined),
            ClipboardSetText: vi.fn().mockResolvedValue(undefined),
            PluginsScan: vi.fn().mockResolvedValue([]),
            SessionGetActiveRuns: vi.fn().mockResolvedValue(activeRunsMock),
            SessionGet: vi.fn().mockResolvedValue({
                entries: [
                    {
                        id: 'msg-remote-1',
                        sessionId: 'sess-init-1',
                        createdAt: 100,
                        kind: 'user',
                        version: 1,
                        content: [{ type: 'text', text: 'hello from disk' }],
                    },
                ],
            }),
            onNativeEvent: onNativeEventMock,
        } as any)

        await bootstrapApplication()

        // Verify initial hydration
        expect(useSessionRunStore.getState().activeRuns['sess-init-1']?.status).toBe('running')

        // Verify onNativeEvent registered
        expect(onNativeEventMock).toHaveBeenCalled()
        expect(nativeEventHandler).not.toBeNull()

        // 1. session:run-status event
        nativeEventHandler!({
            operationId: 'op-1',
            sequence: 1,
            kind: 'session:run-status',
            data: JSON.stringify({
                sessionId: 'sess-2',
                runId: 'run-2',
                clientId: 'client-web',
                status: 'thinking',
                updatedAt: Date.now(),
            }),
        })
        expect(useSessionRunStore.getState().activeRuns['sess-2']?.status).toBe('thinking')

        // 2. session:meta-updated event
        nativeEventHandler!({
            operationId: 'op-2',
            sequence: 2,
            kind: 'session:meta-updated',
            data: JSON.stringify({
                id: 'sess-remote-created',
                title: 'Remote Session Title',
                pinned: true,
                createdAt: 1000,
                updatedAt: 1000,
            }),
        })
        expect(
            useSessionStore.getState().sessions.find((s) => s.id === 'sess-remote-created')?.title,
        ).toBe('Remote Session Title')

        // 3. session:deleted event
        nativeEventHandler!({
            operationId: 'op-3',
            sequence: 3,
            kind: 'session:deleted',
            data: JSON.stringify({ sessionId: 'sess-remote-created' }),
        })
        expect(
            useSessionStore.getState().sessions.find((s) => s.id === 'sess-remote-created'),
        ).toBeUndefined()

        // 4. session:entries-updated event for current non-running session
        useSessionStore.getState().setCurrentSession('sess-init-1')
        useSessionRunStore.getState().clearRun('sess-init-1')

        await nativeEventHandler!({
            operationId: 'op-4',
            sequence: 4,
            kind: 'session:entries-updated',
            data: JSON.stringify({ sessionId: 'sess-init-1' }),
        })

        // Ensure session entries were loaded into messageStore
        const loadedEntries = useMessageStore.getState().getEntries('sess-init-1')
        expect(loadedEntries).toHaveLength(1)
        expect((loadedEntries[0] as any).content[0].text).toBe('hello from disk')

        // 5. projects:updated event
        const syncedProjects = [
            {
                id: 'project-remote-1',
                name: 'Remote Project',
                path: '/workspace/remote-project',
                pinned: false,
                createdAt: 100,
                updatedAt: 100,
            },
        ]
        nativeEventHandler!({
            operationId: 'projects-5',
            sequence: 5,
            kind: 'projects:updated',
            data: JSON.stringify(syncedProjects),
        })
        expect(useProjectStore.getState().projects).toEqual(syncedProjects)

        const hydratedProjects = useProjectStore.getState().projects
        nativeEventHandler!({
            operationId: 'projects-6',
            sequence: 6,
            kind: 'projects:updated',
            data: JSON.stringify(syncedProjects),
        })
        expect(useProjectStore.getState().projects).toBe(hydratedProjects)
    })

    it('attaches onNativeEvent listener before fetching initial active runs', async () => {
        const callOrder: string[] = []

        setHostBridge({
            StorageGet: vi.fn().mockResolvedValue(null),
            StorageSet: vi.fn().mockResolvedValue(undefined),
            ClipboardSetText: vi.fn().mockResolvedValue(undefined),
            PluginsScan: vi.fn().mockResolvedValue([]),
            SessionGetActiveRuns: vi.fn(async () => {
                callOrder.push('SessionGetActiveRuns')
                return []
            }),
            onNativeEvent: vi.fn(() => {
                callOrder.push('onNativeEvent')
                return () => {}
            }),
        } as any)

        await bootstrapApplication()

        expect(callOrder).toEqual(['onNativeEvent', 'SessionGetActiveRuns'])
    })

    it('registers onReconnect callback and triggers resyncFromMain when bridge reconnects', async () => {
        let reconnectHandler: (() => void) | null = null
        const onReconnectMock = vi.fn((cb: () => void) => {
            reconnectHandler = cb
            return () => {}
        })

        const sessionsMock = [
            {
                id: 'sess-recon-1',
                title: 'Reconnected Session 1',
                pinned: false,
                createdAt: 100,
                updatedAt: 100,
            },
        ]

        const runsMock = [
            {
                sessionId: 'sess-recon-1',
                runId: 'run-recon-1',
                clientId: 'client-1',
                status: 'running' as const,
                updatedAt: 200,
            },
        ]
        const projectsMock = [
            {
                id: 'project-recon-1',
                name: 'Reconnected Project',
                path: '/workspace/reconnected-project',
                pinned: false,
                createdAt: 100,
                updatedAt: 100,
            },
        ]
        let projectsReadCount = 0

        setHostBridge({
            KVStoreGet: vi.fn(async (key: string) => {
                if (key === 'projects') {
                    projectsReadCount += 1
                    return projectsReadCount === 1 ? [] : projectsMock
                }
                return null
            }),
            KVStoreSet: vi.fn().mockResolvedValue(undefined),
            ClipboardSetText: vi.fn().mockResolvedValue(undefined),
            PluginsScan: vi.fn().mockResolvedValue([]),
            SessionListSessions: vi.fn().mockResolvedValue(sessionsMock),
            SessionGetActiveRuns: vi.fn().mockResolvedValue(runsMock),
            onReconnect: onReconnectMock,
        } as any)

        await bootstrapApplication()

        expect(onReconnectMock).toHaveBeenCalled()
        expect(reconnectHandler).not.toBeNull()

        // Trigger reconnect callback
        reconnectHandler!()

        // Wait for async resyncFromMain
        await vi.waitFor(() => {
            expect(useSessionStore.getState().sessions.some((s) => s.id === 'sess-recon-1')).toBe(true)
            expect(useSessionRunStore.getState().activeRuns['sess-recon-1']?.status).toBe('running')
            expect(useProjectStore.getState().projects).toEqual(projectsMock)
        })
    })

    it('resyncFromMain safely updates remote sessions without calling SessionDelete on bridge', async () => {
        const sessionDeleteMock = vi.fn().mockResolvedValue(undefined)
        const sessionsMock = [
            {
                id: 'resync-s1',
                title: 'Resynced Session 1 (Updated)',
                pinned: true,
                createdAt: 100,
                updatedAt: 250,
            },
            {
                id: 'resync-s-new',
                title: 'New Remote Session',
                pinned: false,
                createdAt: 200,
                updatedAt: 200,
            },
        ]
        const runsMock = [
            {
                sessionId: 'resync-s1',
                runId: 'run-resync-1',
                clientId: 'client-web',
                status: 'tool' as const,
                updatedAt: 300,
            },
        ]

        setHostBridge({
            SessionListSessions: vi.fn().mockResolvedValue(sessionsMock),
            SessionGetActiveRuns: vi.fn().mockResolvedValue(runsMock),
            SessionDelete: sessionDeleteMock,
        } as any)

        useSessionStore.setState({
            sessions: [
                {
                    id: 'resync-s1',
                    title: 'Resynced Session 1',
                    pinned: true,
                    createdAt: 100,
                    updatedAt: 200,
                },
                {
                    id: 'resync-s-obsolete',
                    title: 'Obsolete Session',
                    pinned: false,
                    createdAt: 50,
                    updatedAt: 50,
                },
            ],
            currentSessionId: 'resync-s1',
        })

        await resyncFromMain()

        const currentSessions = useSessionStore.getState().sessions
        expect(currentSessions).toHaveLength(2)
        expect(currentSessions.some((s) => s.id === 'resync-s1' && s.title === 'Resynced Session 1 (Updated)')).toBe(true)
        expect(currentSessions.some((s) => s.id === 'resync-s-new')).toBe(true)
        expect(currentSessions.some((s) => s.id === 'resync-s-obsolete')).toBe(false)
        expect(sessionDeleteMock).not.toHaveBeenCalled()
        expect(useSessionRunStore.getState().activeRuns['resync-s1']?.status).toBe('tool')
    })

    it('resyncFromMain synchronizes empty SessionListSessions response from authoritative bridge', async () => {
        const initialSessions = [
            {
                id: 'keep-1',
                title: 'Keep 1',
                pinned: false,
                createdAt: 10,
                updatedAt: 10,
            },
        ]
        useSessionStore.setState({ sessions: initialSessions, currentSessionId: 'keep-1' })

        setHostBridge({
            SessionListSessions: vi.fn().mockResolvedValue([]),
            SessionGetActiveRuns: vi.fn().mockResolvedValue([]),
        } as any)

        await resyncFromMain()

        expect(useSessionStore.getState().sessions).toEqual([])
    })

    it('invalidates disk cache for non-current session on session:entries-updated', async () => {
        let nativeEventHandler: ((event: any) => void) | null = null
        const onNativeEventMock = vi.fn((cb: (event: any) => void) => {
            nativeEventHandler = cb
            return () => {}
        })

        let getCallCount = 0
        setHostBridge({
            StorageGet: vi.fn().mockResolvedValue(null),
            StorageSet: vi.fn().mockResolvedValue(undefined),
            ClipboardSetText: vi.fn().mockResolvedValue(undefined),
            PluginsScan: vi.fn().mockResolvedValue([]),
            SessionGetActiveRuns: vi.fn().mockResolvedValue([]),
            SessionGet: vi.fn(async (id: string) => {
                getCallCount += 1
                return {
                    id,
                    version: 2,
                    entries: [
                        {
                            id: `msg-disk-${getCallCount}`,
                            sessionId: id,
                            createdAt: Date.now(),
                            kind: 'user',
                            version: 1,
                            content: [{ type: 'text', text: `disk version ${getCallCount}` }],
                        },
                    ],
                }
            }),
            onNativeEvent: onNativeEventMock,
        } as any)

        await bootstrapApplication()

        useSessionStore.setState({
            sessions: [
                { id: 'sess-active', title: 'Active', pinned: false, createdAt: 1, updatedAt: 1 },
                { id: 'sess-inactive', title: 'Inactive', pinned: false, createdAt: 2, updatedAt: 2 },
            ],
            currentSessionId: 'sess-active',
        })

        // Flush async cleanup from session state switch
        await Promise.resolve()
        await Promise.resolve()
        getCallCount = 0

        // Event arrives for non-current session
        await nativeEventHandler!({
            operationId: 'op-entries-1',
            sequence: 1,
            kind: 'session:entries-updated',
            data: JSON.stringify({ sessionId: 'sess-inactive' }),
        })

        // Ensure session was NOT reloaded immediately since it's inactive
        expect(getCallCount).toBe(0)

        // Now user switches to inactive session and ensures it is loaded
        const { ensureSessionLoaded } = await import('./persistenceService')
        const entries = await ensureSessionLoaded('sess-inactive')

        expect(getCallCount).toBe(1)
        expect(entries).toHaveLength(1)
        expect((entries[0] as any).id).toBe('msg-disk-1')
    })

    it('reloads session from disk on session:entries-updated even if isRunning when memory entries are empty', async () => {
        let nativeEventHandler: ((event: any) => void) | null = null
        const onNativeEventMock = vi.fn((cb: (event: any) => void) => {
            nativeEventHandler = cb
            return () => {}
        })

        let getCallCount = 0
        setHostBridge({
            StorageGet: vi.fn().mockResolvedValue(null),
            StorageSet: vi.fn().mockResolvedValue(undefined),
            ClipboardSetText: vi.fn().mockResolvedValue(undefined),
            PluginsScan: vi.fn().mockResolvedValue([]),
            SessionGetActiveRuns: vi.fn().mockResolvedValue([]),
            SessionGet: vi.fn(async (id: string) => {
                getCallCount += 1
                return {
                    id,
                    version: 2,
                    entries: [
                        {
                            id: 'msg-initial-user',
                            sessionId: id,
                            createdAt: Date.now(),
                            kind: 'user',
                            version: 1,
                            content: [{ type: 'text', text: 'Initial prompt from disk' }],
                        },
                    ],
                }
            }),
            onNativeEvent: onNativeEventMock,
        } as any)

        await bootstrapApplication()

        useSessionStore.setState({
            sessions: [
                { id: 'sess-running-empty', title: 'Running Session', pinned: false, createdAt: 1, updatedAt: 1 },
            ],
            currentSessionId: 'sess-running-empty',
        })
        useSessionRunStore.getState().setRun('sess-running-empty', {
            sessionId: 'sess-running-empty',
            runId: 'run-1',
            status: 'running',
            clientId: 'remote-client',
            updatedAt: Date.now(),
        })
        useMessageStore.setState({ entriesBySession: { 'sess-running-empty': [] } })

        getCallCount = 0

        // Event arrives for current running session with empty memory entries
        await nativeEventHandler!({
            operationId: 'op-entries-running',
            sequence: 1,
            kind: 'session:entries-updated',
            data: JSON.stringify({ sessionId: 'sess-running-empty' }),
        })

        // Because memory entries were empty, hydrateEmptySessionFromDisk is called
        expect(getCallCount).toBe(1)
        expect(useMessageStore.getState().getEntries('sess-running-empty')).toHaveLength(1)
        expect(useMessageStore.getState().getEntries('sess-running-empty')[0]?.id).toBe('msg-initial-user')
    })

    it('does not reload session from disk on session:entries-updated when session is running and memory has entries', async () => {
        let nativeEventHandler: ((event: any) => void) | null = null
        const onNativeEventMock = vi.fn((cb: (event: any) => void) => {
            nativeEventHandler = cb
            return () => {}
        })

        let getCallCount = 0
        setHostBridge({
            StorageGet: vi.fn().mockResolvedValue(null),
            StorageSet: vi.fn().mockResolvedValue(undefined),
            ClipboardSetText: vi.fn().mockResolvedValue(undefined),
            PluginsScan: vi.fn().mockResolvedValue([]),
            SessionGetActiveRuns: vi.fn().mockResolvedValue([]),
            SessionGet: vi.fn(async (id: string) => {
                getCallCount += 1
                return {
                    id,
                    version: 2,
                    entries: [
                        {
                            id: 'msg-old-disk',
                            sessionId: id,
                            createdAt: Date.now(),
                            kind: 'user',
                            version: 1,
                            content: [{ type: 'text', text: 'Old disk entry' }],
                        },
                    ],
                }
            }),
            onNativeEvent: onNativeEventMock,
        } as any)

        await bootstrapApplication()

        useSessionStore.setState({
            sessions: [
                { id: 'sess-running-active', title: 'Running Session', pinned: false, createdAt: 1, updatedAt: 1 },
            ],
            currentSessionId: 'sess-running-active',
        })
        useSessionRunStore.getState().setRun('sess-running-active', {
            sessionId: 'sess-running-active',
            runId: 'run-1',
            status: 'running',
            clientId: 'remote-client',
            updatedAt: Date.now(),
        })
        useMessageStore.setState({
            entriesBySession: {
                'sess-running-active': [
                    {
                        id: 'msg-streaming-live',
                        sessionId: 'sess-running-active',
                        createdAt: Date.now(),
                        kind: 'assistant',
                        version: 1,
                        status: 'streaming',
                        stopReason: 'pending',
                        content: [{ type: 'text', text: 'Streaming token...' }],
                    },
                ],
            },
        })

        getCallCount = 0

        // Event arrives for current running session with non-empty memory entries
        await nativeEventHandler!({
            operationId: 'op-entries-running-active',
            sequence: 1,
            kind: 'session:entries-updated',
            data: JSON.stringify({ sessionId: 'sess-running-active' }),
        })

        // Because memory entries were not empty and session is running, disk is not reloaded
        expect(getCallCount).toBe(0)
        expect(useMessageStore.getState().getEntries('sess-running-active')).toHaveLength(1)
        expect(useMessageStore.getState().getEntries('sess-running-active')[0]?.id).toBe('msg-streaming-live')
    })

    it('syncs resume prompt state on startup and via session:resume-prompt-state event', async () => {
        let nativeEventHandler: ((event: any) => void) | null = null
        const onNativeEventMock = vi.fn((cb: (event: any) => void) => {
            nativeEventHandler = cb
            return () => {}
        })

        const getResumePromptStateMock = vi.fn().mockResolvedValue({
            isOpen: true,
            totalCount: 2,
            countdown: 28,
            unfinishedSessionIds: ['s1'],
            unfinishedSubAgentIds: ['sa1'],
        })

        setHostBridge({
            StorageGet: vi.fn().mockResolvedValue(null),
            StorageSet: vi.fn().mockResolvedValue(undefined),
            ClipboardSetText: vi.fn().mockResolvedValue(undefined),
            PluginsScan: vi.fn().mockResolvedValue([]),
            SessionGetActiveRuns: vi.fn().mockResolvedValue([]),
            SessionGetResumePromptState: getResumePromptStateMock,
            onNativeEvent: onNativeEventMock,
        } as any)

        await bootstrapApplication()

        expect(getResumePromptStateMock).toHaveBeenCalled()
        const { useResumePromptStore } = await import('@/stores/resumePromptStore')
        expect(useResumePromptStore.getState().isOpen).toBe(true)
        expect(useResumePromptStore.getState().countdown).toBe(28)
        expect(useResumePromptStore.getState().totalCount).toBe(2)

        // Broadcast event updates countdown
        await nativeEventHandler!({
            operationId: 'op-resume-state',
            sequence: 2,
            kind: 'session:resume-prompt-state',
            data: JSON.stringify({
                isOpen: true,
                totalCount: 2,
                countdown: 27,
                unfinishedSessionIds: ['s1'],
                unfinishedSubAgentIds: ['sa1'],
            }),
        })

        expect(useResumePromptStore.getState().countdown).toBe(27)

        // Close event
        await nativeEventHandler!({
            operationId: 'op-resume-state-close',
            sequence: 3,
            kind: 'session:resume-prompt-state',
            data: JSON.stringify({
                isOpen: false,
                totalCount: 0,
                countdown: 0,
                unfinishedSessionIds: [],
                unfinishedSubAgentIds: [],
            }),
        })

        expect(useResumePromptStore.getState().isOpen).toBe(false)
    })

    it('updates active UI right sidebar when receiving remote session:meta-updated for current session', async () => {
        let nativeEventHandler: ((event: any) => void) | null = null
        setHostBridge({
            StorageGet: vi.fn().mockResolvedValue(null),
            StorageSet: vi.fn().mockResolvedValue(undefined),
            ClipboardSetText: vi.fn().mockResolvedValue(undefined),
            PluginsScan: vi.fn().mockResolvedValue([]),
            SessionGetActiveRuns: vi.fn().mockResolvedValue([]),
            onNativeEvent: vi.fn((cb: (event: any) => void) => {
                nativeEventHandler = cb
                return () => {}
            }),
        } as any)

        await bootstrapApplication()

        const sessionId = 'sync-sidebar-sess'
        useSessionStore.setState({
            sessions: [{ id: sessionId, title: 'Sync Sess', pinned: false, createdAt: 1, updatedAt: 1 }],
            currentSessionId: sessionId,
        })
        useUiStore.setState({
            rightSidebarCollapsed: false,
            rightPanelActiveTab: null,
            rightPanelTabParams: {},
        })

        const updatedSession: Session = {
            id: sessionId,
            title: 'Sync Sess',
            pinned: false,
            createdAt: 1,
            updatedAt: 2,
            rightSidebar: {
                collapsed: true,
                activeTab: 'file-manager',
                openTabs: ['file-manager'],
                tabParams: { 'file-manager': { activeFilePath: 'remote.ts' } },
            },
        }

        await nativeEventHandler!({
            operationId: 'op-sidebar-sync',
            sequence: 1,
            kind: 'session:meta-updated',
            data: JSON.stringify(updatedSession),
        })

        expect(useUiStore.getState().rightSidebarCollapsed).toBe(true)
        expect(useUiStore.getState().rightPanelActiveTab).toBe('file-manager')
        expect(useUiStore.getState().rightPanelTabParams['file-manager']).toEqual({ activeFilePath: 'remote.ts' })
    })

    it('does not update active UI right sidebar when receiving remote session:meta-updated for a non-current session', async () => {
        let nativeEventHandler: ((event: any) => void) | null = null
        setHostBridge({
            StorageGet: vi.fn().mockResolvedValue(null),
            StorageSet: vi.fn().mockResolvedValue(undefined),
            ClipboardSetText: vi.fn().mockResolvedValue(undefined),
            PluginsScan: vi.fn().mockResolvedValue([]),
            SessionGetActiveRuns: vi.fn().mockResolvedValue([]),
            onNativeEvent: vi.fn((cb: (event: any) => void) => {
                nativeEventHandler = cb
                return () => {}
            }),
        } as any)

        await bootstrapApplication()

        useSessionStore.setState({
            sessions: [
                { id: 'sess-current', title: 'Current', pinned: false, createdAt: 1, updatedAt: 1 },
                { id: 'sess-other', title: 'Other', pinned: false, createdAt: 2, updatedAt: 2 },
            ],
            currentSessionId: 'sess-current',
        })
        useUiStore.setState({
            rightSidebarCollapsed: false,
            rightPanelActiveTab: 'review',
            rightPanelTabParams: {},
        })

        const updatedOtherSession: Session = {
            id: 'sess-other',
            title: 'Other',
            pinned: false,
            createdAt: 2,
            updatedAt: 3,
            rightSidebar: {
                collapsed: true,
                activeTab: 'file-manager',
                openTabs: ['file-manager'],
                tabParams: { 'file-manager': { activeFilePath: 'other.ts' } },
            },
        }

        await nativeEventHandler!({
            operationId: 'op-sidebar-sync-other',
            sequence: 1,
            kind: 'session:meta-updated',
            data: JSON.stringify(updatedOtherSession),
        })

        // Current session UI should remain unchanged
        expect(useUiStore.getState().rightSidebarCollapsed).toBe(false)
        expect(useUiStore.getState().rightPanelActiveTab).toBe('review')
        // But sessionStore should have updated the other session's rightSidebar
        expect(
            useSessionStore.getState().sessions.find((s) => s.id === 'sess-other')?.rightSidebar,
        ).toEqual(updatedOtherSession.rightSidebar)
    })

    it('preserves current UI right sidebar state when receiving remote session:meta-updated without rightSidebar (e.g. title rename or unread update)', async () => {
        let nativeEventHandler: ((event: any) => void) | null = null
        setHostBridge({
            StorageGet: vi.fn().mockResolvedValue(null),
            StorageSet: vi.fn().mockResolvedValue(undefined),
            ClipboardSetText: vi.fn().mockResolvedValue(undefined),
            PluginsScan: vi.fn().mockResolvedValue([]),
            SessionGetActiveRuns: vi.fn().mockResolvedValue([]),
            onNativeEvent: vi.fn((cb: (event: any) => void) => {
                nativeEventHandler = cb
                return () => {}
            }),
        } as any)

        await bootstrapApplication()

        const sessionId = 'preserve-sidebar-sess'
        useSessionStore.setState({
            sessions: [
                {
                    id: sessionId,
                    title: 'Original Title',
                    pinned: false,
                    createdAt: 1,
                    updatedAt: 1,
                    rightSidebar: {
                        collapsed: false,
                        activeTab: 'review',
                        openTabs: ['review'],
                        tabParams: { review: { mode: 'branchCompare' } },
                    },
                },
            ],
            currentSessionId: sessionId,
        })
        useUiStore.setState({
            rightSidebarCollapsed: false,
            rightSidebarWidth: 380,
            rightPanelActiveTab: 'review',
            rightPanelOpenTabs: ['review'],
            rightPanelTabParams: { review: { mode: 'branchCompare' } },
        })

        // Remote event without rightSidebar (e.g. rename or unread update)
        const renameOnlySession: Session = {
            id: sessionId,
            title: 'Renamed Remote Title',
            pinned: true,
            unread: true,
            createdAt: 1,
            updatedAt: 2,
        }

        await nativeEventHandler!({
            operationId: 'op-rename-only',
            sequence: 1,
            kind: 'session:meta-updated',
            data: JSON.stringify(renameOnlySession),
        })

        // UI store state should NOT be reset to null/defaults
        expect(useUiStore.getState().rightSidebarCollapsed).toBe(false)
        expect(useUiStore.getState().rightSidebarWidth).toBe(380)
        expect(useUiStore.getState().rightPanelActiveTab).toBe('review')
        expect(useUiStore.getState().rightPanelOpenTabs).toEqual(['review'])
        expect(useUiStore.getState().rightPanelTabParams.review).toEqual({ mode: 'branchCompare' })

        // Session store should have updated metadata while preserving rightSidebar
        // Because sessionId is the currently viewed session, unread remains undefined (actively viewed)
        const updated = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
        expect(updated?.title).toBe('Renamed Remote Title')
        expect(updated?.pinned).toBe(true)
        expect(updated?.unread).toBeUndefined()
        expect(updated?.rightSidebar).toEqual({
            collapsed: false,
            activeTab: 'review',
            openTabs: ['review'],
            tabParams: { review: { mode: 'branchCompare' } },
        })
    })

    it('updates unread to true when receiving remote session:meta-updated for a non-current session', async () => {
        let nativeEventHandler: ((event: any) => void) | null = null
        setHostBridge({
            StorageGet: vi.fn().mockResolvedValue(null),
            StorageSet: vi.fn().mockResolvedValue(undefined),
            ClipboardSetText: vi.fn().mockResolvedValue(undefined),
            PluginsScan: vi.fn().mockResolvedValue([]),
            SessionGetActiveRuns: vi.fn().mockResolvedValue([]),
            onNativeEvent: vi.fn((cb: (event: any) => void) => {
                nativeEventHandler = cb
                return () => {}
            }),
        } as any)

        await bootstrapApplication()

        const initialSession: Session = {
            id: 'sess-bg',
            title: 'Background Session',
            pinned: false,
            createdAt: 1,
            updatedAt: 1,
        }

        useSessionStore.setState({
            sessions: [initialSession],
            currentSessionId: 'sess-other',
        })

        await nativeEventHandler!({
            operationId: 'op-meta-bg',
            sequence: 1,
            kind: 'session:meta-updated',
            data: JSON.stringify({
                id: 'sess-bg',
                title: 'Background Session',
                pinned: false,
                unread: true,
                createdAt: 1,
                updatedAt: 2,
            }),
        })

        const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-bg')
        expect(updated?.unread).toBe(true)
    })

    it('performs cross-runtime production handshake via host bridge plugin methods', async () => {
        const getPreparedStateSpy = vi.fn().mockResolvedValue({
            revision: 'rev-handshake-123',
            generation: 1,
            graph: null,
        })
        const commitGenerationSpy = vi.fn().mockResolvedValue({ ok: true })
        const rollbackGenerationSpy = vi.fn().mockResolvedValue({ ok: true })

        setHostBridge({
            StorageGet: vi.fn().mockResolvedValue(null),
            StorageSet: vi.fn().mockResolvedValue(undefined),
            ClipboardSetText: vi.fn().mockResolvedValue(undefined),
            PluginsGetPreparedState: getPreparedStateSpy,
            PluginsCommitGeneration: commitGenerationSpy,
            PluginsRollbackGeneration: rollbackGenerationSpy,
        } as any)

        await bootstrapApplication()

        expect(getPreparedStateSpy).toHaveBeenCalledTimes(1)
        expect(commitGenerationSpy).toHaveBeenCalledWith('rev-handshake-123', 1)
        expect(rollbackGenerationSpy).not.toHaveBeenCalled()
    })

    it('fails bootstrapApplication and rolls back when main commit generation fails', async () => {
        const getPreparedStateSpy = vi.fn().mockResolvedValue({
            revision: 'rev-fail-456',
            generation: 1,
            graph: null,
        })
        const commitGenerationSpy = vi.fn().mockRejectedValue(new Error('Main process crash during commit'))
        const rollbackGenerationSpy = vi.fn().mockResolvedValue({ ok: true })

        setHostBridge({
            StorageGet: vi.fn().mockResolvedValue(null),
            StorageSet: vi.fn().mockResolvedValue(undefined),
            ClipboardSetText: vi.fn().mockResolvedValue(undefined),
            PluginsGetPreparedState: getPreparedStateSpy,
            PluginsCommitGeneration: commitGenerationSpy,
            PluginsRollbackGeneration: rollbackGenerationSpy,
        } as any)

        await expect(bootstrapApplication()).rejects.toThrow('Main process crash during commit')
    })

    it('handles renderer reload safely when Main is already in active phase without calling PluginsCommitGeneration', async () => {
        const getPreparedStateSpy = vi.fn().mockResolvedValue({
            phase: 'active',
            revision: 'rev-reload-789',
            generation: 1,
            graph: null,
        })
        const commitGenerationSpy = vi.fn().mockResolvedValue({ ok: true })
        const rollbackGenerationSpy = vi.fn().mockResolvedValue({ ok: true })

        setHostBridge({
            StorageGet: vi.fn().mockResolvedValue(null),
            StorageSet: vi.fn().mockResolvedValue(undefined),
            ClipboardSetText: vi.fn().mockResolvedValue(undefined),
            PluginsGetPreparedState: getPreparedStateSpy,
            PluginsCommitGeneration: commitGenerationSpy,
            PluginsRollbackGeneration: rollbackGenerationSpy,
        } as any)

        await bootstrapApplication()

        expect(getPreparedStateSpy).toHaveBeenCalledTimes(1)
        // Must NOT call commit when Main is already active
        expect(commitGenerationSpy).not.toHaveBeenCalled()
        expect(rollbackGenerationSpy).not.toHaveBeenCalled()
    })

    it('updates window.location.hash on notification:navigate-session native event', async () => {
        let nativeEventHandler: ((event: any) => void) | null = null
        const onNativeEventMock = vi.fn((cb: (event: any) => void) => {
            nativeEventHandler = cb
            return () => {}
        })

        setHostBridge({
            StorageGet: vi.fn().mockResolvedValue(null),
            StorageSet: vi.fn().mockResolvedValue(undefined),
            ClipboardSetText: vi.fn().mockResolvedValue(undefined),
            PluginsScan: vi.fn().mockResolvedValue([]),
            onNativeEvent: onNativeEventMock,
        } as any)

        await bootstrapApplication()
        expect(nativeEventHandler).toBeTruthy()

        window.location.hash = '#/'
        await nativeEventHandler!({
            operationId: 'op-nav-1',
            sequence: 1,
            kind: 'notification:navigate-session',
            data: JSON.stringify({ sessionId: 'session-target-123' }),
        })

        expect(window.location.hash).toBe('#/chat/session-target-123')
    })
})
