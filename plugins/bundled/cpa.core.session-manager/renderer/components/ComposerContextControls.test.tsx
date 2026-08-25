import i18n from '@/i18n'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setDefaultHostServices } from '@cpa/plugin-ui'
import type { Project } from '@cpa/plugin-api'
import {
    ProjectPickerControl,
    WorkLocationPickerControl,
    BranchPickerControl,
    EnvironmentPickerControl,
} from './ComposerContextControls.js'
import type { GitRepoInfo } from '../utils/gitBranches.js'

const mockProjects: Project[] = [
    {
        id: 'proj-alpha',
        name: 'Project Alpha',
        path: '/workspace/alpha',
        paths: ['/workspace/alpha'],
        pinned: false,
        createdAt: 1000,
        updatedAt: 1000,
    },
]

const sampleRepo: GitRepoInfo = {
    repoRoot: '/workspace/alpha',
    gitDir: '/workspace/alpha/.git',
    commonDir: '/workspace/alpha/.git',
    current: 'main',
    detached: false,
    headSha: '1111111111111111111111111111111111111111',
    branches: ['main', 'feature/new-ui'],
}

const EMPTY_SESSIONS: any[] = Object.freeze([])

describe('ComposerContextControls in new session', () => {
    let pendingContext: any
    let mockUiService: any
    let mockSessionService: any
    let mockServices: any

    beforeEach(async () => {
    await i18n.changeLanguage('en')
        pendingContext = { projectId: null, branch: null, workLocation: 'local', environmentId: null }
        mockUiService = {
            pushToast: vi.fn(),
            getPendingSessionContext: vi.fn(() => pendingContext),
            setPendingSessionContext: vi.fn((ctx: any) => {
                pendingContext = { ...pendingContext, ...ctx }
            }),
            openSettings: vi.fn(),
        }
        mockSessionService = {
            getCurrentSessionId: vi.fn(() => null),
            getSnapshot: vi.fn(() => EMPTY_SESSIONS),
            setProject: vi.fn(),
            setBranch: vi.fn(),
            update: vi.fn(),
            setWorktree: vi.fn(),
        }
        mockServices = {
            ui: mockUiService,
            sessions: mockSessionService,
            projects: {
                getSnapshot: () => mockProjects,
                subscribe: () => () => {},
            },
            fileSystem: {
                stat: vi.fn(),
                readFile: vi.fn(),
                readFileIfExists: vi.fn(),
                readDir: vi.fn(),
            },
            process: {
                run: vi.fn(),
            },
        }
        setDefaultHostServices(mockServices)
    })

    it('ProjectPickerControl allows switching project during new session', async () => {
        const user = userEvent.setup()
        const onChange = vi.fn()

        render(
            <ProjectPickerControl
                sessionId={null}
                disabled={false}
                projectId={null}
                onChange={onChange}
            />,
        )

        const projectBtn = screen.getByRole('button', { name: /Select project|selectProject/i })
        expect(projectBtn).toBeInTheDocument()
        await user.click(projectBtn)

        const option = screen.getByRole('option', { name: /Project Alpha/i })
        await user.click(option)

        expect(onChange).toHaveBeenCalledWith('proj-alpha')
    })

    it('WorkLocationPickerControl allows switching between local and worktree during new session', async () => {
        const user = userEvent.setup()
        const onChange = vi.fn()

        render(
            <WorkLocationPickerControl
                sessionId={null}
                disabled={false}
                workLocation="local"
                onChange={onChange}
            />,
        )

        const locationBtn = screen.getByRole('button', { name: /Work location/i })
        expect(locationBtn).toHaveTextContent(/Local/i)

        await user.click(locationBtn)
        const worktreeItem = screen.getByRole('menuitem', { name: /New local worktree/i })
        await user.click(worktreeItem)

        expect(onChange).toHaveBeenCalledWith('worktree')
    })

    it('BranchPickerControl is interactive and allows selecting branches during new session', async () => {
        const user = userEvent.setup()
        const onChange = vi.fn()

        render(
            <BranchPickerControl
                sessionId={null}
                disabled={false}
                projectId="proj-alpha"
                branch="main"
                onChange={onChange}
            />,
        )

        const branchBtn = screen.getByRole('button', { name: /Select branch|main/i })
        expect(branchBtn).toBeInTheDocument()
        expect(branchBtn).not.toBeDisabled()

        await user.click(branchBtn)
        expect(screen.getByRole('listbox', { name: /Git branches|Branch/i })).toBeInTheDocument()
    })

    it('EnvironmentPickerControl is hidden in local mode and interactive in worktree mode', async () => {
        const user = userEvent.setup()
        const onChange = vi.fn()

        // In local mode, returns null
        const { unmount } = render(
            <EnvironmentPickerControl
                sessionId={null}
                disabled={false}
                workLocation="local"
                projectId="proj-alpha"
                onChange={onChange}
            />,
        )
        expect(screen.queryByRole('button', { name: /Environment/i })).not.toBeInTheDocument()
        unmount()

        // In worktree mode, renders interactive environment picker
        render(
            <EnvironmentPickerControl
                sessionId={null}
                disabled={false}
                workLocation="worktree"
                projectId="proj-alpha"
                onChange={onChange}
            />,
        )

        const envBtn = screen.getByRole('button', { name: /Environment/i })
        expect(envBtn).toBeInTheDocument()
        expect(envBtn).not.toBeDisabled()

        await user.click(envBtn)
        expect(screen.getByRole('menu', { name: /Environment/i })).toBeInTheDocument()
        const noEnvItem = screen.getByRole('menuitem', { name: /Work without environment/i })
        await user.click(noEnvItem)

        expect(onChange).toHaveBeenCalledWith(null)
    })
})
