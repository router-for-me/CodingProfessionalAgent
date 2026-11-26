import i18n from '@/i18n'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useMessageStore } from '@/stores/messageStore'
import { useProjectStore } from '@/stores/projectStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useSessionRunStore } from '@/stores/sessionRunStore'
import { useUiStore } from '@/stores/uiStore'
import { rendererPluginRuntime } from '@/plugins/platform/RendererPluginRuntimeHost'
import type { ConversationEntry } from '@/features/agent-runtime/session/types'
import type { Session } from '@/types/models'
import { getHostServices } from '@/application/services/createHostServices'
import {
    SidebarSessionList,
    getSessionFirstPromptTime,
    sortByFirstPromptDesc,
} from './SidebarSessionList'

const { navigateMock } = vi.hoisted(() => ({
    navigateMock: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
    Link: ({
        children,
        className,
        params,
        to,
    }: {
        children: React.ReactNode
        className?: string
        params?: { sessionId?: string }
        to: string
    }) => (
        <a className={className} href={params?.sessionId ? `/chat/${params.sessionId}` : to}>
            {children}
        </a>
    ),
    useNavigate: () => navigateMock,
    useRouterState: ({
        select,
    }: {
        select: (state: { location: { pathname: string } }) => unknown
    }) => select({ location: { pathname: '/' } }),
}))

describe('SidebarSessionList sorting by first prompt time', () => {
    beforeEach(async () => {
    await i18n.changeLanguage('en')
        navigateMock.mockReset()
        getHostServices()
        useSessionStore.setState({ sessions: [], currentSessionId: null })
        useProjectStore.setState({ projects: [] })
        useMessageStore.setState({ entriesBySession: {} })
    })

    describe('getSessionFirstPromptTime helper', () => {
        it('returns first user entry createdAt when entries are present in memory', () => {
            const session: Session = {
                id: 'sess-1',
                title: 'Test Session',
                pinned: false,
                createdAt: 1000,
                updatedAt: 5000,
                firstPromptAt: 2000,
            }
            const entries: ConversationEntry[] = [
                {
                    id: 'e1',
                    sessionId: 'sess-1',
                    createdAt: 1500,
                    kind: 'user',
                    content: [{ type: 'text', text: 'Hello' }],
                },
                {
                    id: 'e2',
                    sessionId: 'sess-1',
                    createdAt: 3000,
                    kind: 'assistant',
                    status: 'done',
                    stopReason: 'stop',
                    content: [{ type: 'text', text: 'Hi' }],
                },
            ]

            expect(getSessionFirstPromptTime(session, entries)).toBe(1500)
        })

        it('returns session.firstPromptAt when entries are not yet loaded in memory', () => {
            const session: Session = {
                id: 'sess-1',
                title: 'Test Session',
                pinned: false,
                createdAt: 1000,
                updatedAt: 5000,
                firstPromptAt: 2500,
            }

            expect(getSessionFirstPromptTime(session, undefined)).toBe(2500)
            expect(getSessionFirstPromptTime(session, [])).toBe(2500)
        })

        it('falls back to session.createdAt when neither user entry nor firstPromptAt is available', () => {
            const session: Session = {
                id: 'sess-1',
                title: 'Blank Session',
                pinned: false,
                createdAt: 1200,
                updatedAt: 1200,
            }

            expect(getSessionFirstPromptTime(session, undefined)).toBe(1200)
        })
    })

    describe('sortByFirstPromptDesc helper', () => {
        it('sorts sessions by first prompt sent time descending rather than updatedAt', () => {
            const sessionA: Session = {
                id: 'sess-a',
                title: 'Session A (Old first prompt, high updatedAt)',
                pinned: false,
                createdAt: 1000,
                updatedAt: 9000,
                firstPromptAt: 1050,
            }

            const sessionB: Session = {
                id: 'sess-b',
                title: 'Session B (Newer first prompt)',
                pinned: false,
                createdAt: 2000,
                updatedAt: 2150,
                firstPromptAt: 2100,
            }

            const sessionC: Session = {
                id: 'sess-c',
                title: 'Session C (Brand new empty)',
                pinned: false,
                createdAt: 3000,
                updatedAt: 3000,
            }

            const sorted = sortByFirstPromptDesc([sessionA, sessionB, sessionC])
            expect(sorted.map((s) => s.id)).toEqual(['sess-c', 'sess-b', 'sess-a'])
        })

        it('uses live entriesBySession when available to compute accurate prompt times', () => {
            const sessionA: Session = {
                id: 'sess-a',
                title: 'Session A',
                pinned: false,
                createdAt: 1000,
                updatedAt: 8000,
            }
            const sessionB: Session = {
                id: 'sess-b',
                title: 'Session B',
                pinned: false,
                createdAt: 1000,
                updatedAt: 4000,
            }

            const entriesBySession: Record<string, ConversationEntry[]> = {
                'sess-a': [
                    {
                        id: 'e-a1',
                        sessionId: 'sess-a',
                        createdAt: 1100,
                        kind: 'user',
                        content: [{ type: 'text', text: 'Prompt A' }],
                    },
                ],
                'sess-b': [
                    {
                        id: 'e-b1',
                        sessionId: 'sess-b',
                        createdAt: 2500,
                        kind: 'user',
                        content: [{ type: 'text', text: 'Prompt B' }],
                    },
                ],
            }

            const sorted = sortByFirstPromptDesc([sessionA, sessionB], entriesBySession)
            expect(sorted.map((s) => s.id)).toEqual(['sess-b', 'sess-a'])
        })
    })

    describe('SidebarSessionList component rendering', () => {
        it('renders project session rows sorted by first prompt sent time', () => {
            useProjectStore.setState({
                projects: [
                    {
                        id: 'proj-1',
                        name: 'Project Alpha',
                        pinned: false,
                        createdAt: 1000,
                        updatedAt: 1000,
                    },
                ],
            })

            useSessionStore.setState({
                sessions: [
                    {
                        id: 'sess-1',
                        projectId: 'proj-1',
                        title: 'Issue 5199 Triage and Analysis',
                        pinned: false,
                        firstPromptAt: 1000,
                        createdAt: 1000,
                        updatedAt: 9999,
                    },
                    {
                        id: 'sess-2',
                        projectId: 'proj-1',
                        title: 'New Feature Discussion',
                        pinned: false,
                        firstPromptAt: 5000,
                        createdAt: 5000,
                        updatedAt: 6000,
                    },
                ],
            })

            render(<SidebarSessionList />)

            const rows = screen.getAllByRole('link')
            expect(rows[0]).toHaveTextContent('New Feature Discussion')
            expect(rows[1]).toHaveTextContent('Issue 5199 Triage and Analysis')
        })

        it('retains last used worktree and environment settings when clicking the SquarePen new chat button on a project', () => {
            useProjectStore.setState({
                projects: [
                    {
                        id: 'proj-worktree',
                        name: 'Worktree Project',
                        pinned: false,
                        createdAt: 1000,
                        updatedAt: 1000,
                    },
                ],
            })

            useSessionStore.setState({
                sessions: [
                    {
                        id: 'sess-wt-1',
                        projectId: 'proj-worktree',
                        title: 'Worktree Session',
                        pinned: false,
                        workLocation: 'worktree',
                        environmentId: 'env-backend-node',
                        createdAt: 1000,
                        updatedAt: 2000,
                    },
                ],
                currentSessionId: 'sess-wt-1',
            })

            useUiStore.setState({
                pendingSessionContext: { projectId: null, branch: null },
            })

            render(<SidebarSessionList />)

            const newChatBtn = screen.getByRole('button', {
                name: 'New chat in Worktree Project',
            })
            fireEvent.click(newChatBtn)

            expect(useSessionStore.getState().currentSessionId).toBeNull()
            expect(useUiStore.getState().pendingSessionContext).toEqual({
                projectId: 'proj-worktree',
                branch: null,
                workLocation: 'worktree',
                environmentId: 'env-backend-node',
            })
        })

        it('retains local work location when latest session in project is local even if historical worktree session exists', () => {
            useProjectStore.setState({
                projects: [
                    {
                        id: 'proj-mixed',
                        name: 'Mixed Project',
                        pinned: false,
                        createdAt: 1000,
                        updatedAt: 1000,
                    },
                ],
            })

            useSessionStore.setState({
                sessions: [
                    {
                        id: 'sess-mixed-local',
                        projectId: 'proj-mixed',
                        title: 'Latest Local Session',
                        pinned: false,
                        workLocation: 'local',
                        environmentId: null,
                        createdAt: 3000,
                        updatedAt: 4000,
                    },
                    {
                        id: 'sess-mixed-wt',
                        projectId: 'proj-mixed',
                        title: 'Old Worktree Session',
                        pinned: false,
                        workLocation: 'worktree',
                        environmentId: 'env-backend-node',
                        createdAt: 1000,
                        updatedAt: 2000,
                    },
                ],
                currentSessionId: 'sess-mixed-local',
            })

            useUiStore.setState({
                pendingSessionContext: { projectId: null, branch: null },
            })

            render(<SidebarSessionList />)

            const newChatBtn = screen.getByRole('button', {
                name: 'New chat in Mixed Project',
            })
            fireEvent.click(newChatBtn)

            expect(useSessionStore.getState().currentSessionId).toBeNull()
            expect(useUiStore.getState().pendingSessionContext).toEqual({
                projectId: 'proj-mixed',
                branch: null,
                workLocation: 'local',
                environmentId: null,
            })
        })

        it('requests composer focus and navigates to home when clicking the SquarePen new chat button', () => {
            useProjectStore.setState({
                projects: [
                    {
                        id: 'proj-focus',
                        name: 'Focus Project',
                        pinned: false,
                        createdAt: 1000,
                        updatedAt: 1000,
                    },
                ],
            })
            const listener = vi.fn()
            const unsubscribe = rendererPluginRuntime.eventBus.on('composer:focus', listener)

            render(<SidebarSessionList />)
            fireEvent.click(screen.getByRole('button', {
                name: 'New chat in Focus Project',
            }))

            expect(listener).toHaveBeenCalledTimes(1)
            expect(navigateMock).toHaveBeenCalledWith({ to: '/' })
            unsubscribe()
        })

        it('limits displayed sessions to 10 by default, expands by 10 on clicking show more until all are shown, and resets on collapse', () => {
            useProjectStore.setState({
                projects: [
                    {
                        id: 'proj-large',
                        name: 'CLIProxyAPI',
                        pinned: false,
                        createdAt: 1000,
                        updatedAt: 1000,
                    },
                ],
            })

            const sampleSessions: Session[] = Array.from({ length: 25 }, (_, i) => ({
                id: `sess-${i + 1}`,
                projectId: 'proj-large',
                title: `Session ${i + 1}`,
                pinned: false,
                createdAt: 1000 + i * 10,
                firstPromptAt: 1000 + i * 10,
                updatedAt: 1000 + i * 10,
            }))

            useSessionStore.setState({
                sessions: sampleSessions,
            })
            useUiStore.setState({
                collapsedGroups: {},
            })

            render(<SidebarSessionList />)

            // Initially, only 10 session links should be rendered
            let links = screen.getAllByRole('link')
            expect(links).toHaveLength(10)

            // The "Show more" button should be present
            const showMoreBtn = screen.getByRole('button', { name: 'Show more' })
            expect(showMoreBtn).toBeInTheDocument()

            // Click "Show more" -> should now show 20 sessions
            fireEvent.click(showMoreBtn)
            links = screen.getAllByRole('link')
            expect(links).toHaveLength(20)
            expect(screen.getByRole('button', { name: 'Show more' })).toBeInTheDocument()

            // Click "Show more" again -> should now show all 25 sessions
            fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
            links = screen.getAllByRole('link')
            expect(links).toHaveLength(25)

            // Button should disappear now that all sessions are visible
            expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument()

            // Click project header (CLIProxyAPI) to collapse the project group
            const projectToggleBtn = screen.getByRole('button', { name: 'CLIProxyAPI' })
            fireEvent.click(projectToggleBtn)

            // All session rows should be hidden
            expect(screen.queryAllByRole('link')).toHaveLength(0)

            // Click project header again to expand
            fireEvent.click(projectToggleBtn)

            // Visible count should reset back to 10
            links = screen.getAllByRole('link')
            expect(links).toHaveLength(10)
            expect(screen.getByRole('button', { name: 'Show more' })).toBeInTheDocument()
        })

        it('does not render show more button when project has 10 or fewer sessions', () => {
            useProjectStore.setState({
                projects: [
                    {
                        id: 'proj-small',
                        name: 'Small Project',
                        pinned: false,
                        createdAt: 1000,
                        updatedAt: 1000,
                    },
                ],
            })

            const sampleSessions: Session[] = Array.from({ length: 10 }, (_, i) => ({
                id: `small-sess-${i + 1}`,
                projectId: 'proj-small',
                title: `Small Session ${i + 1}`,
                pinned: false,
                createdAt: 1000 + i * 10,
                firstPromptAt: 1000 + i * 10,
                updatedAt: 1000 + i * 10,
            }))

            useSessionStore.setState({
                sessions: sampleSessions,
            })
            useUiStore.setState({
                collapsedGroups: {},
            })

            render(<SidebarSessionList />)

            expect(screen.getAllByRole('link')).toHaveLength(10)
            expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument()
        })

        it('displays inferred path folder or translated fallback for orphan project with UUID rather than raw UUID', () => {
            useProjectStore.setState({
                projects: [],
            })

            const uuidProjId = 'f1867135-ec44-496b-a4c7-180092d8380d'
            useSessionStore.setState({
                sessions: [
                    {
                        id: 'sess-orphan-1',
                        projectId: uuidProjId,
                        title: 'Orphan Session 1',
                        pinned: false,
                        createdAt: 1000,
                        updatedAt: 1000,
                        worktreePath: '/Users/test/workspace/MyCoolProject',
                    },
                ],
            })
            useUiStore.setState({
                collapsedGroups: {},
            })

            const { rerender } = render(<SidebarSessionList />)

            // Should show inferred folder name "MyCoolProject" instead of the UUID
            expect(screen.getByRole('button', { name: 'MyCoolProject' })).toBeInTheDocument()
            expect(screen.queryByText(uuidProjId)).not.toBeInTheDocument()

            // When no path is present, should show translated fallback instead of raw UUID
            useSessionStore.setState({
                sessions: [
                    {
                        id: 'sess-orphan-2',
                        projectId: uuidProjId,
                        title: 'Orphan Session 2',
                        pinned: false,
                        createdAt: 1000,
                        updatedAt: 1000,
                    },
                ],
            })

            rerender(<SidebarSessionList />)
            expect(screen.getByRole('button', { name: 'Unknown Project' })).toBeInTheDocument()
            expect(screen.queryByText(uuidProjId)).not.toBeInTheDocument()
        })
    })

    describe('archive all completed chats in a project', () => {
        const openProjectMenu = (projectName: string) => {
            const projectToggleBtn = screen.getByRole('button', { name: projectName })
            fireEvent.contextMenu(projectToggleBtn)
        }

        it('archives non-running sessions including pinned ones and skips running sessions', async () => {
            useProjectStore.setState({
                projects: [
                    {
                        id: 'proj-archive',
                        name: 'Archive Project',
                        pinned: false,
                        createdAt: 1000,
                        updatedAt: 1000,
                    },
                ],
            })
            useSessionStore.setState({
                sessions: [
                    {
                        id: 'sess-plain',
                        projectId: 'proj-archive',
                        title: 'Plain Session',
                        pinned: false,
                        createdAt: 1000,
                        updatedAt: 1000,
                    },
                    {
                        id: 'sess-pinned',
                        projectId: 'proj-archive',
                        title: 'Pinned Session',
                        pinned: true,
                        createdAt: 1100,
                        updatedAt: 1100,
                    },
                    {
                        id: 'sess-running',
                        projectId: 'proj-archive',
                        title: 'Running Session',
                        pinned: false,
                        createdAt: 1200,
                        updatedAt: 1200,
                    },
                ],
                currentSessionId: null,
            })
            useUiStore.setState({ collapsedGroups: {} })
            useSessionRunStore.setState({
                activeRuns: {
                    'sess-running': {
                        sessionId: 'sess-running',
                        runId: 'run-1',
                        clientId: 'c1',
                        status: 'running',
                        updatedAt: Date.now(),
                    },
                },
            })

            render(<SidebarSessionList />)
            openProjectMenu('Archive Project')

            const archiveItem = await screen.findByRole('menuitem', {
                name: 'Archive all completed chats',
            })
            fireEvent.click(archiveItem)

            await vi.waitFor(() => {
                const state = useSessionStore.getState()
                const plain = state.sessions.find((s) => s.id === 'sess-plain')
                const pinned = state.sessions.find((s) => s.id === 'sess-pinned')
                const running = state.sessions.find((s) => s.id === 'sess-running')
                expect(plain?.archivedAt).toBeDefined()
                expect(pinned?.archivedAt).toBeDefined()
                expect(running?.archivedAt).toBeUndefined()
            })

            useSessionRunStore.setState({ activeRuns: {} })
        })

        it('navigates to a remaining session when the currently viewed session is archived', async () => {
            window.location.hash = '#/chat/sess-viewed'
            useProjectStore.setState({
                projects: [
                    {
                        id: 'proj-nav',
                        name: 'Nav Project',
                        pinned: false,
                        createdAt: 1000,
                        updatedAt: 1000,
                    },
                ],
            })
            useSessionStore.setState({
                sessions: [
                    {
                        id: 'sess-viewed',
                        projectId: 'proj-nav',
                        title: 'Viewed Session',
                        pinned: false,
                        createdAt: 1000,
                        updatedAt: 1000,
                    },
                    {
                        id: 'sess-other-project',
                        projectId: 'proj-other',
                        title: 'Other Project Session',
                        pinned: false,
                        createdAt: 1100,
                        updatedAt: 1100,
                    },
                ],
                currentSessionId: 'sess-viewed',
            })
            useUiStore.setState({ collapsedGroups: {} })

            const navigationService = getHostServices().navigation
            const navigateSpy = vi
                .spyOn(navigationService, 'navigate')
                .mockResolvedValue(undefined)

            try {
                render(<SidebarSessionList />)
                openProjectMenu('Nav Project')

                const archiveItem = await screen.findByRole('menuitem', {
                    name: 'Archive all completed chats',
                })
                fireEvent.click(archiveItem)

                await vi.waitFor(() => {
                    const state = useSessionStore.getState()
                    expect(state.sessions.find((s) => s.id === 'sess-viewed')?.archivedAt).toBeDefined()
                    expect(navigateSpy).toHaveBeenCalledWith({
                        to: '/chat/$sessionId',
                        params: { sessionId: 'sess-other-project' },
                    })
                })
                expect(useSessionStore.getState().currentSessionId).toBe('sess-other-project')
            } finally {
                navigateSpy.mockRestore()
                window.location.hash = ''
            }
        })

        it('does not navigate when the user already left the archived session while archiving was in flight', async () => {
            window.location.hash = '#/chat/sess-inflight'
            useProjectStore.setState({
                projects: [
                    {
                        id: 'proj-inflight',
                        name: 'Inflight Project',
                        pinned: false,
                        createdAt: 1000,
                        updatedAt: 1000,
                    },
                ],
            })
            useSessionStore.setState({
                sessions: [
                    {
                        id: 'sess-inflight',
                        projectId: 'proj-inflight',
                        title: 'Inflight Session',
                        pinned: false,
                        createdAt: 1000,
                        updatedAt: 1000,
                    },
                    {
                        id: 'sess-elsewhere',
                        projectId: 'proj-inflight',
                        title: 'Elsewhere Session',
                        pinned: false,
                        createdAt: 1100,
                        updatedAt: 1100,
                    },
                    {
                        id: 'sess-untouched',
                        projectId: 'proj-other',
                        title: 'Untouched Session',
                        pinned: false,
                        createdAt: 1200,
                        updatedAt: 1200,
                    },
                ],
                currentSessionId: 'sess-inflight',
            })
            useUiStore.setState({ collapsedGroups: {} })

            const navigationService = getHostServices().navigation
            const navigateSpy = vi
                .spyOn(navigationService, 'navigate')
                .mockResolvedValue(undefined)

            try {
                render(<SidebarSessionList />)
                openProjectMenu('Inflight Project')

                const archiveItem = await screen.findByRole('menuitem', {
                    name: 'Archive all completed chats',
                })
                fireEvent.click(archiveItem)

                // Simulate the user navigating to another session while the
                // batch archive is still in flight.
                window.location.hash = '#/chat/sess-untouched'
                useSessionStore.getState().setCurrentSession('sess-untouched')

                await vi.waitFor(() => {
                    const state = useSessionStore.getState()
                    expect(state.sessions.find((s) => s.id === 'sess-inflight')?.archivedAt).toBeDefined()
                })

                // Give the post-archive navigation logic a chance to run.
                await new Promise((resolve) => setTimeout(resolve, 50))
                expect(navigateSpy).not.toHaveBeenCalled()
                expect(useSessionStore.getState().currentSessionId).toBe('sess-untouched')
            } finally {
                navigateSpy.mockRestore()
                window.location.hash = ''
            }
        })

        it('navigates to home when every session was archived', async () => {
            window.location.hash = '#/chat/sess-only'
            useProjectStore.setState({
                projects: [
                    {
                        id: 'proj-empty',
                        name: 'Empty Project',
                        pinned: false,
                        createdAt: 1000,
                        updatedAt: 1000,
                    },
                ],
            })
            useSessionStore.setState({
                sessions: [
                    {
                        id: 'sess-only',
                        projectId: 'proj-empty',
                        title: 'Only Session',
                        pinned: false,
                        createdAt: 1000,
                        updatedAt: 1000,
                    },
                ],
                currentSessionId: 'sess-only',
            })
            useUiStore.setState({ collapsedGroups: {} })

            const navigationService = getHostServices().navigation
            const navigateSpy = vi
                .spyOn(navigationService, 'navigate')
                .mockResolvedValue(undefined)

            try {
                render(<SidebarSessionList />)
                openProjectMenu('Empty Project')

                const archiveItem = await screen.findByRole('menuitem', {
                    name: 'Archive all completed chats',
                })
                fireEvent.click(archiveItem)

                await vi.waitFor(() => {
                    const state = useSessionStore.getState()
                    expect(state.sessions.find((s) => s.id === 'sess-only')?.archivedAt).toBeDefined()
                    expect(navigateSpy).toHaveBeenCalledWith('/')
                })
                expect(useSessionStore.getState().currentSessionId).toBeNull()
            } finally {
                navigateSpy.mockRestore()
                window.location.hash = ''
            }
        })

        it('does not archive anything when all project sessions are running', async () => {
            useProjectStore.setState({
                projects: [
                    {
                        id: 'proj-busy',
                        name: 'Busy Project',
                        pinned: false,
                        createdAt: 1000,
                        updatedAt: 1000,
                    },
                ],
            })
            useSessionStore.setState({
                sessions: [
                    {
                        id: 'sess-busy',
                        projectId: 'proj-busy',
                        title: 'Busy Session',
                        pinned: false,
                        createdAt: 1000,
                        updatedAt: 1000,
                    },
                ],
                currentSessionId: null,
            })
            useUiStore.setState({ collapsedGroups: {} })
            useSessionRunStore.setState({
                activeRuns: {
                    'sess-busy': {
                        sessionId: 'sess-busy',
                        runId: 'run-busy',
                        clientId: 'c1',
                        status: 'running',
                        updatedAt: Date.now(),
                    },
                },
            })

            render(<SidebarSessionList />)
            openProjectMenu('Busy Project')

            const archiveItem = await screen.findByRole('menuitem', {
                name: 'Archive all completed chats',
            })
            fireEvent.click(archiveItem)

            // Give the async handler a chance to run; the running session must stay active.
            await new Promise((resolve) => setTimeout(resolve, 50))
            const state = useSessionStore.getState()
            expect(state.sessions.find((s) => s.id === 'sess-busy')?.archivedAt).toBeUndefined()

            useSessionRunStore.setState({ activeRuns: {} })
        })
    })
})
