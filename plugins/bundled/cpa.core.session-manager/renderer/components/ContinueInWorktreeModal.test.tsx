import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import type { Project, SessionItem } from '@cpa/plugin-api'
import { getHostServices } from '@/application/services/createHostServices'
import { ContinueInWorktreeModal } from './ContinueInWorktreeModal'

describe('ContinueInWorktreeModal', () => {
    const mockSession: SessionItem = {
        id: 'sess-test',
        title: 'Test Session',
        projectId: 'proj-1',
        branch: 'main', // Stale or initial branch
        pinned: false,
        createdAt: 1000,
        updatedAt: 2000,
    }

    const mockProjects: Project[] = [
        {
            id: 'proj-1',
            name: 'Example Project',
            path: '/workspaces/sample-project',
            pinned: false,
            createdAt: 1,
            updatedAt: 2,
        },
        {
            id: 'proj-2',
            name: 'Other Project',
            path: '/workspaces/other-project',
            pinned: false,
            createdAt: 1,
            updatedAt: 2,
        },
    ]

    beforeEach(async () => {
        getHostServices()
        await i18n.changeLanguage('en')
    })

    it('detects current repository branch (e.g. dev) instead of stale session branch', async () => {
        const onClose = vi.fn()
        const onConfirm = vi.fn()

        const mockLoadRepo = vi.fn().mockResolvedValue({
            repoRoot: '/workspaces/sample-project',
            gitDir: '/workspaces/sample-project/.git',
            commonDir: '/workspaces/sample-project/.git',
            current: 'dev',
            detached: false,
            headSha: '1234567890',
            branches: ['dev', 'main', 'feat-x'],
        })

        render(
            <ContinueInWorktreeModal
                session={mockSession}
                isOpen={true}
                onClose={onClose}
                onConfirm={onConfirm}
                projects={mockProjects}
                loadRepo={mockLoadRepo}
            />,
        )

        await waitFor(() => {
            expect(screen.getByTestId('worktree-modal-branch')).toHaveTextContent('dev')
        })

        const user = userEvent.setup()
        await user.click(screen.getByTestId('confirm-worktree-fork-btn'))

        expect(onConfirm).toHaveBeenCalledWith(null, 'dev')
    })

    it('renders modal with working branch, project, and environment options', async () => {
        const onClose = vi.fn()
        const onConfirm = vi.fn()

        render(
            <ContinueInWorktreeModal
                session={{ ...mockSession, branch: 'feature-worktree-branch' }}
                isOpen={true}
                onClose={onClose}
                onConfirm={onConfirm}
                projects={mockProjects}
            />,
        )

        expect(screen.getByRole('dialog')).toBeInTheDocument()
        expect(screen.getByTestId('worktree-modal-branch')).toHaveTextContent('feature-worktree-branch')
        expect(screen.getByTestId('env-option-none')).toBeInTheDocument()
        expect(screen.getByTestId('env-option-setup')).toBeInTheDocument()
    })

    it('allows selecting "Work without environment" (null) and confirms directly to create worktree', async () => {
        const user = userEvent.setup()
        const onClose = vi.fn()
        const onConfirm = vi.fn()

        render(
            <ContinueInWorktreeModal
                session={{ ...mockSession, environmentId: 'proj-1' }}
                isOpen={true}
                onClose={onClose}
                onConfirm={onConfirm}
                projects={mockProjects}
            />,
        )

        // Switch to none
        await user.click(screen.getByTestId('env-option-none'))

        // Confirm
        await user.click(screen.getByTestId('confirm-worktree-fork-btn'))

        expect(onConfirm).toHaveBeenCalledWith(null, 'main')
    })

    it('opens settings environments section when "Set up project" option is clicked', async () => {
        const user = userEvent.setup()
        const onClose = vi.fn()
        const onConfirm = vi.fn()

        const openSettingsSpy = vi.spyOn(getHostServices().ui, 'openSettings')

        render(
            <ContinueInWorktreeModal
                session={mockSession}
                isOpen={true}
                onClose={onClose}
                onConfirm={onConfirm}
                projects={mockProjects}
            />,
        )

        await user.click(screen.getByTestId('env-option-setup'))

        expect(onClose).toHaveBeenCalled()
        expect(openSettingsSpy).toHaveBeenCalledWith('environments', expect.objectContaining({
            projectId: 'proj-1',
            mode: 'detail',
            fromChat: true,
        }))
    })

    it('calls onClose on cancel button or close X click', async () => {
        const user = userEvent.setup()
        const onClose = vi.fn()
        const onConfirm = vi.fn()

        const { rerender } = render(
            <ContinueInWorktreeModal
                session={mockSession}
                isOpen={true}
                onClose={onClose}
                onConfirm={onConfirm}
                projects={mockProjects}
            />,
        )

        await user.click(screen.getByRole('button', { name: 'Cancel' }))
        expect(onClose).toHaveBeenCalledTimes(1)

        rerender(
            <ContinueInWorktreeModal
                session={mockSession}
                isOpen={true}
                onClose={onClose}
                onConfirm={onConfirm}
                projects={mockProjects}
            />,
        )

        await user.click(screen.getByRole('button', { name: 'Close' }))
        expect(onClose).toHaveBeenCalledTimes(2)
    })

    it('disables confirm button and shows warning if project has no path', () => {
        const onClose = vi.fn()
        const onConfirm = vi.fn()

        const sessionWithoutPath: SessionItem = {
            ...mockSession,
            projectId: 'unknown-proj',
        }

        render(
            <ContinueInWorktreeModal
                session={sessionWithoutPath}
                isOpen={true}
                onClose={onClose}
                onConfirm={onConfirm}
                projects={[]}
            />,
        )

        const confirmBtn = screen.getByTestId('confirm-worktree-fork-btn')
        expect(confirmBtn).toBeDisabled()
        expect(screen.getByText('No project path')).toBeInTheDocument()
    })

    it('shows loading spinner when isSubmitting is true', () => {
        render(
            <ContinueInWorktreeModal
                session={mockSession}
                isOpen={true}
                onClose={vi.fn()}
                onConfirm={vi.fn()}
                projects={mockProjects}
                isSubmitting={true}
            />,
        )

        expect(screen.getByText('Creating worktree...')).toBeInTheDocument()
        expect(screen.getByTestId('confirm-worktree-fork-btn')).toBeDisabled()
    })
})
