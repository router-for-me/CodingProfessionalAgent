import i18n from '@/i18n'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setDefaultHostServices } from '@cpa/plugin-ui'
import { BranchPicker } from './BranchPicker.js'
import type { GitRepoInfo } from '../utils/gitBranches.js'

const sampleRepo: GitRepoInfo = {
    repoRoot: '/workspace/example',
    gitDir: '/workspace/example/.git',
    commonDir: '/workspace/example/.git',
    current: 'dev',
    detached: false,
    headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    branches: ['dev', 'main', 'realtime'],
}

const mockUiService = {
    pushToast: vi.fn(),
    getPendingSessionContext: vi.fn(() => ({ projectId: null, branch: null })),
    setPendingSessionContext: vi.fn(),
    isGroupCollapsed: vi.fn(() => false),
    toggleGroup: vi.fn(),
    setSidebarCollapsed: vi.fn(),
    openSettings: vi.fn(),
}

const mockServices: any = {
    ui: mockUiService,
    fileSystem: {
        stat: vi.fn(),
        readFile: vi.fn(),
        readDir: vi.fn(),
    },
    process: {
        run: vi.fn(),
    },
}

function mockDefaultRepoLoading() {
    let completeRead = () => {}
    mockServices.fileSystem.stat.mockImplementation(() => new Promise((resolve) => {
        completeRead = () => resolve({ isDir: true })
    }))
    mockServices.fileSystem.readFile.mockImplementation(async (path: string) => ({
        dataBase64: btoa(path.endsWith('/HEAD') ? 'ref: refs/heads/dev\n' : ''),
    }))
    mockServices.fileSystem.readDir.mockResolvedValue([
        { name: 'dev', isDir: false },
        { name: 'main', isDir: false },
    ])
    return async () => {
        await act(async () => completeRead())
    }
}

describe('BranchPicker', () => {
    beforeEach(async () => {
    await i18n.changeLanguage('en')
        vi.resetAllMocks()
        setDefaultHostServices(mockServices)
    })

    it('does not reload Git metadata after default loading or unrelated renders', async () => {
        const finishLoad = mockDefaultRepoLoading()
        const onChange = vi.fn()
        const { rerender } = render(
            <BranchPicker
                value={null}
                onChange={onChange}
                projectPaths={['/workspace/example']}
            />,
        )

        expect(mockServices.fileSystem.stat).toHaveBeenCalledTimes(1)
        await finishLoad()
        expect(screen.getByRole('button', { name: /Select branch/i })).toHaveTextContent('dev')
        expect(onChange).toHaveBeenCalledWith('dev')
        expect(mockServices.fileSystem.stat).toHaveBeenCalledTimes(1)

        rerender(
            <BranchPicker
                value="dev"
                onChange={() => undefined}
                projectName="Updated project name"
                projectPaths={['/workspace/example']}
            />,
        )
        expect(mockServices.fileSystem.stat).toHaveBeenCalledTimes(1)
    })

    it('refreshes the default repository when opened but not on search input', async () => {
        const finishLoad = mockDefaultRepoLoading()
        const user = userEvent.setup()
        render(
            <BranchPicker
                value="dev"
                onChange={() => undefined}
                projectPaths={['/workspace/example']}
            />,
        )
        await finishLoad()
        expect(mockServices.fileSystem.stat).toHaveBeenCalledTimes(1)

        await user.click(screen.getByRole('button', { name: /Select branch/i }))
        expect(mockServices.fileSystem.stat).toHaveBeenCalledTimes(2)
        await finishLoad()
        await user.type(screen.getByPlaceholderText(/Search.*branches/i), 'main')
        expect(screen.getByRole('option', { name: 'main' })).toBeInTheDocument()
        expect(mockServices.fileSystem.stat).toHaveBeenCalledTimes(2)
    })

    it('reloads the default repository when project paths change', async () => {
        const finishLoad = mockDefaultRepoLoading()
        const onChange = vi.fn()
        const { rerender } = render(
            <BranchPicker value="dev" onChange={onChange} projectPaths={['/workspace/example']} />,
        )
        await finishLoad()
        expect(mockServices.fileSystem.stat).toHaveBeenCalledTimes(1)

        rerender(
            <BranchPicker value="dev" onChange={onChange} projectPaths={['/workspace/other']} />,
        )
        expect(mockServices.fileSystem.stat).toHaveBeenCalledTimes(2)
        expect(mockServices.fileSystem.stat).toHaveBeenLastCalledWith('/workspace/other/.git')
        await finishLoad()
        expect(mockServices.fileSystem.stat).toHaveBeenCalledTimes(2)
    })

    it('shows the repository current branch and lists real branches', async () => {
        const user = userEvent.setup()
        const onChange = vi.fn()
        const loadRepo = vi.fn(async () => sampleRepo)

        render(
            <BranchPicker
                value={null}
                onChange={onChange}
                projectName="CLIProxyAPI"
                projectPaths={['/workspace/example']}
                loadRepo={loadRepo}
            />,
        )

        await waitFor(() => {
            expect(onChange).toHaveBeenCalledWith('dev')
        })
        expect(screen.getByRole('button', { name: /Select branch|dev/i })).toHaveTextContent('dev')

        await user.click(screen.getByRole('button', { name: /Select branch|dev/i }))
        expect(screen.getByPlaceholderText(/Search.*branch/i)).toBeInTheDocument()
        expect(screen.getByRole('option', { name: 'dev' })).toBeInTheDocument()
        expect(screen.getByRole('option', { name: 'main' })).toBeInTheDocument()
        expect(screen.getByRole('option', { name: 'realtime' })).toBeInTheDocument()
    })

    it('filters branches with the search box', async () => {
        const user = userEvent.setup()

        render(
            <BranchPicker
                value="dev"
                onChange={() => undefined}
                projectName="CLIProxyAPI"
                projectPaths={['/workspace/example']}
                loadRepo={async () => sampleRepo}
            />,
        )

        await user.click(screen.getByRole('button', { name: /Select branch|dev/i }))
        await user.type(screen.getByPlaceholderText(/Search.*branch/i), 'real')

        expect(screen.getByRole('option', { name: 'realtime' })).toBeInTheDocument()
        expect(screen.queryByRole('option', { name: 'main' })).not.toBeInTheDocument()
    })

    it('creates and checks out a new branch from the search query', async () => {
        const user = userEvent.setup()
        const onChange = vi.fn()
        const checkoutBranch = vi.fn(async () => undefined)

        render(
            <BranchPicker
                value="dev"
                onChange={onChange}
                projectName="CLIProxyAPI"
                projectPaths={['/workspace/example']}
                loadRepo={async () => sampleRepo}
                checkoutBranch={checkoutBranch}
            />,
        )

        await user.click(screen.getByRole('button', { name: /Select branch|dev/i }))
        await user.type(screen.getByPlaceholderText(/Search.*branch/i), 'fix-4595')
        const createBtn = screen.getByRole('button', { name: /Create and check out fix-4595/i })
        await user.click(createBtn)

        await waitFor(() => {
            expect(checkoutBranch).toHaveBeenCalledWith(sampleRepo, 'fix-4595', {
                create: true,
            })
        })
        expect(onChange).toHaveBeenCalledWith('fix-4595')
    })

    it('switches an existing branch with git and keeps the picker open on failure', async () => {
        const user = userEvent.setup()
        const onChange = vi.fn()
        const checkoutBranch = vi.fn(async () => {
            throw new Error('Your local changes would be overwritten')
        })

        render(
            <BranchPicker
                value="dev"
                onChange={onChange}
                projectName="CLIProxyAPI"
                projectPaths={['/workspace/example']}
                loadRepo={async () => sampleRepo}
                checkoutBranch={checkoutBranch}
            />,
        )

        await user.click(screen.getByRole('button', { name: /Select branch|dev/i }))
        await user.click(screen.getByRole('option', { name: 'main' }))

        await waitFor(() => {
            expect(checkoutBranch).toHaveBeenCalledWith(sampleRepo, 'main', {
                create: false,
            })
        })
        expect(onChange).not.toHaveBeenCalled()
        expect(screen.getByPlaceholderText(/Search.*branch/i)).toBeInTheDocument()
        expect(mockUiService.pushToast).toHaveBeenCalledWith(
            expect.stringContaining('Your local changes would be overwritten'),
            'error',
        )
    })

    it('does not invoke git when the selected branch is already current', async () => {
        const user = userEvent.setup()
        const onChange = vi.fn()
        const checkoutBranch = vi.fn(async () => undefined)

        render(
            <BranchPicker
                value="dev"
                onChange={onChange}
                projectName="CLIProxyAPI"
                projectPaths={['/workspace/example']}
                loadRepo={async () => sampleRepo}
                checkoutBranch={checkoutBranch}
            />,
        )

        await user.click(screen.getByRole('button', { name: /Select branch|dev/i }))
        await user.click(screen.getByRole('option', { name: 'dev' }))

        expect(checkoutBranch).not.toHaveBeenCalled()
        expect(onChange).toHaveBeenCalledWith('dev')
    })

    it('uses leading-normal instead of leading-none on trigger button', () => {
        render(
            <BranchPicker
                value="dev"
                onChange={() => undefined}
                projectName="CLIProxyAPI"
                projectPaths={['/workspace/example']}
                loadRepo={async () => sampleRepo}
            />,
        )
        const trigger = screen.getByRole('button', { name: /Select branch|dev/i })
        expect(trigger.className).toContain('leading-normal')
        expect(trigger.className).not.toContain('leading-none')
    })

    it('shows divider and create new branch menu item at end of branch list, and creates new branch from modal', async () => {
        const user = userEvent.setup()
        const onChange = vi.fn()
        const checkoutBranch = vi.fn(async () => undefined)

        render(
            <BranchPicker
                value="dev"
                onChange={onChange}
                projectName="CLIProxyAPI"
                projectPaths={['/workspace/example']}
                loadRepo={async () => sampleRepo}
                checkoutBranch={checkoutBranch}
            />,
        )

        // Open branch dropdown
        await user.click(screen.getByRole('button', { name: /Select branch|dev/i }))

        // Should see the "Create and check out new branch..." option
        const createOption = screen.getByRole('option', { name: /Create and check out new branch\.\.\./i })
        expect(createOption).toBeInTheDocument()

        // Click to open modal
        await user.click(createOption)

        // Modal should appear
        const modal = screen.getByRole('dialog')
        expect(modal).toBeInTheDocument()
        expect(screen.getByText('Create and checkout branch')).toBeInTheDocument()
        expect(screen.getByText('Branch name')).toBeInTheDocument()

        const branchInput = screen.getByPlaceholderText(/Enter a new branch name/i)
        const submitBtn = screen.getByRole('button', { name: /Create and check out$/i })

        // Initially empty, submit should be disabled
        expect(submitBtn).toBeDisabled()

        // Type a branch name ending with '/' -> should show error and be disabled
        await user.type(branchInput, 'feat/test/')
        expect(screen.getByText(/Branch name cannot end with/i)).toBeInTheDocument()
        expect(submitBtn).toBeDisabled()

        // Fix branch name by typing a valid segment
        await user.type(branchInput, 'sub-feature')
        expect(screen.queryByText(/Branch name cannot end with/i)).not.toBeInTheDocument()
        expect(submitBtn).toBeEnabled()

        // Submit via button click
        await user.click(submitBtn)

        // Should have called checkoutBranch with create: true and baseBranch: 'dev'
        await waitFor(() => {
            expect(checkoutBranch).toHaveBeenCalledWith(sampleRepo, 'feat/test/sub-feature', {
                create: true,
                baseBranch: 'dev',
            })
        })
        expect(onChange).toHaveBeenCalledWith('feat/test/sub-feature')

        // Modal should be closed
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('validates branch ending with slash, duplicate branch, and closes modal on cancel in zh-CN', async () => {
        await i18n.changeLanguage('zh-CN')
        const user = userEvent.setup()
        const onChange = vi.fn()
        const checkoutBranch = vi.fn(async () => undefined)

        render(
            <BranchPicker
                value="main"
                onChange={onChange}
                projectName="CLIProxyAPI"
                projectPaths={['/workspace/example']}
                loadRepo={async () => sampleRepo}
                checkoutBranch={checkoutBranch}
            />,
        )

        // Open menu
        await user.click(screen.getByRole('button', { name: /选择分支|main/i }))

        // Check Chinese menu item
        const createMenuItem = screen.getByRole('option', { name: /创建并检出新分支\.\.\./i })
        expect(createMenuItem).toBeInTheDocument()
        await user.click(createMenuItem)

        // Check Chinese modal
        expect(screen.getByText('创建并检出分支')).toBeInTheDocument()
        expect(screen.getByText('分支名称')).toBeInTheDocument()

        const branchInput = screen.getByPlaceholderText(/输入新分支名称/i)
        const submitBtn = screen.getByRole('button', { name: '创建并检出' })
        const closeBtn = screen.getByRole('button', { name: '关闭' })

        // Type existing branch 'dev'
        await user.type(branchInput, 'dev')
        expect(screen.getByText('该分支已存在')).toBeInTheDocument()
        expect(submitBtn).toBeDisabled()

        // Clear and type name ending with slash
        await user.clear(branchInput)
        await user.type(branchInput, 'new-branch/')
        expect(screen.getByText('分支名不能以“/”结尾。')).toBeInTheDocument()
        expect(submitBtn).toBeDisabled()

        // Click Close
        await user.click(closeBtn)
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        expect(checkoutBranch).not.toHaveBeenCalled()
    })

    it('prefills branch name with branchPrefix when opened from BranchPicker', async () => {
        const user = userEvent.setup()
        const onChange = vi.fn()
        const checkoutBranch = vi.fn(async () => undefined)

        render(
            <BranchPicker
                value="main"
                onChange={onChange}
                projectName="CLIProxyAPI"
                projectPaths={['/workspace/example']}
                loadRepo={async () => sampleRepo}
                checkoutBranch={checkoutBranch}
                branchPrefix="codex/"
            />,
        )

        // Open menu and click create branch
        await user.click(screen.getByRole('button', { name: /Select branch|main/i }))
        await user.click(screen.getByRole('option', { name: /Create and check out new branch\.\.\./i }))

        // Modal input should be prefilled with "codex/"
        const branchInput = screen.getByPlaceholderText(/Enter a new branch name/i) as HTMLInputElement
        expect(branchInput.value).toBe('codex/')
        expect(screen.getByText(/Branch name cannot end with/i)).toBeInTheDocument()
    })
})
