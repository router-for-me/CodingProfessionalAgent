import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { HostServicesProvider } from '@cpa/plugin-ui'
import { WorktreeSetupCard, type WorktreeSessionSetup } from './WorktreeSetupCard.js'

describe('WorktreeSetupCard', () => {
    beforeEach(async () => {
        await i18n.changeLanguage('en')
    })

    it('renders in-progress state with steps', () => {
        const setup: WorktreeSessionSetup = {
            status: 'running',
            stepWorkspace: 'done',
            stepCheckout: 'done',
            stepEnvironment: 'running',
            environmentId: 'proj-1',
            details: '+ cd /repo\n+ npm install\n',
            expandedDetails: true,
        }

        render(<WorktreeSetupCard setup={setup} />)

        expect(screen.getByText('Setting up worktree')).toBeInTheDocument()
        expect(screen.getByText('Workspace prepared')).toBeInTheDocument()
        expect(screen.getByText('Files checked out')).toBeInTheDocument()
        expect(screen.getByText('Setting up environment')).toBeInTheDocument()
        expect(screen.getByText(/\+ cd \/repo/)).toBeInTheDocument()
    })

    it('renders error state with action buttons and handles clicks', () => {
        const onRetry = vi.fn()
        const onContinueAnyway = vi.fn()
        const onAutoFix = vi.fn()
        const mockOpenSettings = vi.fn()

        const setup: WorktreeSessionSetup = {
            status: 'error',
            stepWorkspace: 'done',
            stepCheckout: 'done',
            stepEnvironment: 'error',
            environmentId: 'proj-1',
            details: 'Setup script exited with code 1',
            expandedDetails: true,
        }

        render(
            <HostServicesProvider
                services={{
                    ui: {
                        openSettings: mockOpenSettings,
                    },
                } as any}
            >
                <WorktreeSetupCard
                    setup={setup}
                    onRetry={onRetry}
                    onContinueAnyway={onContinueAnyway}
                    onAutoFix={onAutoFix}
                />
            </HostServicesProvider>,
        )

        expect(screen.getByText('Worktree setup failed')).toBeInTheDocument()
        expect(screen.getByText('Workspace prepared')).toBeInTheDocument()
        expect(screen.getByText('Files checked out')).toBeInTheDocument()
        expect(screen.getByText('Environment setup failed')).toBeInTheDocument()

        const retryBtn = screen.getByRole('button', { name: /Retry/i })
        fireEvent.click(retryBtn)
        expect(onRetry).toHaveBeenCalledTimes(1)

        const continueBtn = screen.getByRole('button', { name: /Continue anyway|Continue Anyway/i })
        fireEvent.click(continueBtn)
        expect(onContinueAnyway).toHaveBeenCalledTimes(1)

        const autoFixBtn = screen.getByRole('button', { name: /Auto fix|Auto Fix/i })
        fireEvent.click(autoFixBtn)
        expect(onAutoFix).toHaveBeenCalledTimes(1)
    })

    it('does not render environment step row when no environment is configured', () => {
        const setup: WorktreeSessionSetup = {
            status: 'done',
            stepWorkspace: 'done',
            stepCheckout: 'done',
            stepEnvironment: 'done',
            expandedDetails: false,
        }

        render(<WorktreeSetupCard setup={setup} />)

        expect(screen.getByText(/ready/i)).toBeInTheDocument()
        expect(screen.getByText('Workspace prepared')).toBeInTheDocument()
        expect(screen.getByText('Files checked out')).toBeInTheDocument()
        expect(screen.queryByText('Environment ready')).not.toBeInTheDocument()
        expect(screen.queryByText('Setting up environment')).not.toBeInTheDocument()
    })
})
