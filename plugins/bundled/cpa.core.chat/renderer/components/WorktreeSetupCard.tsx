import { useState } from 'react'
import {
    CheckCircle2,
    ChevronDown,
    ChevronUp,
    GitFork,
    Loader2,
    RotateCw,
    XCircle,
    cn,
    useHostServices,
    useTranslation,
} from '@cpa/plugin-ui'

export type WorktreeSetupStepStatus = 'pending' | 'running' | 'done' | 'error'

export interface WorktreeSessionSetup {
    status: 'pending' | 'running' | 'done' | 'error'
    path?: string
    branch?: string
    error?: string
    details?: string
    expandedDetails?: boolean
    stepWorkspace?: WorktreeSetupStepStatus
    stepCheckout?: WorktreeSetupStepStatus
    stepEnvironment?: WorktreeSetupStepStatus
    environmentId?: string
    environmentName?: string
    sourceTreePath?: string
    worktreePath?: string
    steps?: Array<{
        name: string
        status: WorktreeSetupStepStatus
        command?: string
        error?: string
    }>
    [key: string]: unknown
}

export interface WorktreeSetupCardProps {
    setup: WorktreeSessionSetup
    onRetry?: () => void
    onContinueAnyway?: () => void
    onAutoFix?: () => void
    onToggleDetails?: () => void
    className?: string
}

function renderStepIcon(status?: WorktreeSetupStepStatus) {
    switch (status) {
        case 'done':
            return <CheckCircle2 className="size-4 shrink-0 text-sky-400" aria-hidden />
        case 'running':
            return <Loader2 className="size-4 shrink-0 animate-spin text-sky-400" aria-hidden />
        case 'error':
            return <XCircle className="size-4 shrink-0 text-red-500" aria-hidden />
        case 'pending':
        default:
            return (
                <div
                    className="size-4 shrink-0 rounded-full border border-[var(--border-subtle)] opacity-40"
                    aria-hidden
                />
            )
    }
}

/**
 * Visual status and terminal execution card for Git worktree & environment initialization.
 * Matches CPA worktree setup card layout 1:1.
 */
export function WorktreeSetupCard({
    setup,
    onRetry,
    onContinueAnyway,
    onAutoFix,
    onToggleDetails,
    className,
}: WorktreeSetupCardProps) {
    const { t } = useTranslation()
    const services = useHostServices()
    const [internalExpanded, setInternalExpanded] = useState(true)

    const isExpanded = setup.expandedDetails !== undefined ? setup.expandedDetails : internalExpanded
    const toggleExpanded = () => {
        if (onToggleDetails) {
            onToggleDetails()
        } else {
            setInternalExpanded((prev) => !prev)
        }
    }

    const isError = setup.status === 'error'

    const title =
        setup.status === 'done'
            ? t('worktree.setupComplete', 'Workspace ready')
            : isError
              ? t('worktree.setupFailed', 'Workspace setup failed')
              : t('worktree.settingUp', 'Setting up workspace…')

    const stepWorkspaceText =
        setup.stepWorkspace === 'done'
            ? t('worktree.workspaceReady', 'Workspace prepared')
            : setup.stepWorkspace === 'error'
              ? t('worktree.workspaceFailed', 'Failed to prepare workspace')
              : t('worktree.preparingWorkspace', 'Preparing workspace')

    const stepCheckoutText =
        setup.stepCheckout === 'done'
            ? t('worktree.checkoutReady', 'Files checked out')
            : setup.stepCheckout === 'error'
              ? t('worktree.checkoutFailed', 'Failed to check out files')
              : t('worktree.checkingOut', 'Checking out files')

    const stepEnvironmentText =
        setup.stepEnvironment === 'done'
            ? t('worktree.environmentReady', 'Environment configured')
            : setup.stepEnvironment === 'error'
              ? t('worktree.environmentFailed', 'Failed to set up environment')
              : t('worktree.settingEnvironment', 'Setting up environment')

    const hasEnvironment = Boolean(setup.environmentId || setup.environmentName)

    const handleEditEnvironment = () => {
        services?.ui?.openSettings?.('environments')
    }

    return (
        <div
            data-testid="worktree-setup-card"
            className={cn('my-4 w-full select-none', className)}
        >
            {/* Header: Title with Branch Icon */}
            <div className="flex items-center gap-2 pb-2 text-[13px] font-normal text-[var(--text-secondary)]">
                <GitFork className="size-3.5 shrink-0 opacity-70" aria-hidden />
                <span className="text-[var(--text-primary)] font-normal">{title}</span>
            </div>

            {/* Inner box with steps, controls and terminal logs */}
            <div className="w-full rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-4 shadow-sm">
                {/* Steps List */}
                <div className="space-y-2 text-[13px]">
                    <div className="flex items-center gap-2.5">
                        {renderStepIcon(setup.stepWorkspace)}
                        <span
                            className={cn(
                                setup.stepWorkspace === 'error'
                                    ? 'text-red-400'
                                    : setup.stepWorkspace === 'done' || setup.stepWorkspace === 'running'
                                      ? 'text-sky-400'
                                      : 'text-[var(--text-muted)]',
                            )}
                        >
                            {stepWorkspaceText}
                        </span>
                    </div>

                    <div className="flex items-center gap-2.5">
                        {renderStepIcon(setup.stepCheckout)}
                        <span
                            className={cn(
                                setup.stepCheckout === 'error'
                                    ? 'text-red-400'
                                    : setup.stepCheckout === 'done' || setup.stepCheckout === 'running'
                                      ? 'text-sky-400'
                                      : 'text-[var(--text-muted)]',
                            )}
                        >
                            {stepCheckoutText}
                        </span>
                    </div>

                    {hasEnvironment ? (
                        <div className="flex items-center gap-2.5">
                            {renderStepIcon(setup.stepEnvironment)}
                            <span
                                className={cn(
                                    setup.stepEnvironment === 'error'
                                        ? 'text-red-400'
                                        : setup.stepEnvironment === 'done' || setup.stepEnvironment === 'running'
                                          ? 'text-sky-400'
                                          : 'text-[var(--text-muted)]',
                                )}
                            >
                                {stepEnvironmentText}
                            </span>
                        </div>
                    ) : null}
                </div>

                {/* Control bar: Collapse toggle + Action buttons */}
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 pt-2">
                    <button
                        type="button"
                        onClick={toggleExpanded}
                        className="inline-flex items-center gap-1 text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors cursor-pointer select-none"
                    >
                        {isExpanded ? (
                            <>
                                <ChevronDown className="size-3.5" aria-hidden />
                                <span>{t('worktree.collapseDetails', 'Collapse details')}</span>
                            </>
                        ) : (
                            <>
                                <ChevronUp className="size-3.5" aria-hidden />
                                <span>{t('worktree.expandDetails', 'Expand details')}</span>
                            </>
                        )}
                    </button>

                    <div className="flex items-center gap-2">
                        {isError && hasEnvironment ? (
                            <button
                                type="button"
                                onClick={handleEditEnvironment}
                                className="inline-flex items-center rounded-md px-3 py-1 text-[12px] font-normal bg-[#21262d] text-neutral-200 hover:bg-[#30363d] border border-[#30363d] transition-colors cursor-pointer"
                            >
                                <span>{t('worktree.editEnvironment', 'Edit environment')}</span>
                            </button>
                        ) : null}

                        {isError && onAutoFix ? (
                            <button
                                type="button"
                                onClick={onAutoFix}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-app)] px-2.5 py-1 text-[12px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-sidebar-hover)] transition-colors cursor-pointer"
                            >
                                <RotateCw className="size-3 text-sky-400" aria-hidden />
                                <span>{t('worktree.autoFix', 'Auto fix')}</span>
                            </button>
                        ) : null}

                        {isError && onContinueAnyway ? (
                            <button
                                type="button"
                                onClick={onContinueAnyway}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-app)] px-2.5 py-1 text-[12px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-sidebar-hover)] transition-colors cursor-pointer"
                            >
                                <span>{t('worktree.continueAnyway', 'Continue anyway')}</span>
                            </button>
                        ) : null}

                        {isError && onRetry ? (
                            <button
                                type="button"
                                onClick={onRetry}
                                className="inline-flex items-center gap-1.5 rounded-lg bg-sky-500 hover:bg-sky-600 px-3 py-1 text-[12px] font-medium text-white transition-colors cursor-pointer"
                            >
                                <RotateCw className="size-3" aria-hidden />
                                <span>{t('worktree.retry', 'Retry')}</span>
                            </button>
                        ) : null}
                    </div>
                </div>

                {/* Expanded Terminal Output / Error Detail */}
                {isExpanded && (setup.details || setup.error) ? (
                    <div className="mt-3 overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[#0c0c0c] p-3">
                        {setup.error ? (
                            <div className="mb-2 text-[12px] text-red-400 font-mono">
                                {setup.error}
                            </div>
                        ) : null}
                        {setup.details ? (
                            <pre className="max-h-60 overflow-y-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-neutral-300">
                                {setup.details}
                            </pre>
                        ) : null}
                    </div>
                ) : null}
            </div>
        </div>
    )
}
