import {
    AlertCircle,
    ChevronLeft,
    ChevronRight,
    FileTypeIcon,
    Layers,
    useTranslation,
} from '@cpa/plugin-ui'
import type { GitDiffFile } from '../utils/gitDiff.js'

export interface SingleFileNavHeaderProps {
    file: GitDiffFile
    currentIndex: number
    totalFiles: number
    isLargeDiff?: boolean
    onPrevFile: () => void
    onNextFile: () => void
    onToggleViewMode?: () => void
}

export function SingleFileNavHeader({
    file,
    currentIndex,
    totalFiles,
    isLargeDiff = false,
    onPrevFile,
    onNextFile,
    onToggleViewMode,
}: SingleFileNavHeaderProps) {
    const { t } = useTranslation()

    const isFirst = currentIndex <= 0
    const isLast = currentIndex >= totalFiles - 1

    return (
        <div
            data-testid="single-file-nav-header"
            className="flex w-full max-w-full flex-wrap items-center justify-between gap-2 overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-2 text-[12px] select-none"
        >
            {/* Left: Navigation Controls & Current File Name */}
            <div className="flex min-w-0 items-center gap-2">
                {/* Prev / Next & Counter Badge */}
                <div className="flex shrink-0 items-center gap-0.5 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] p-0.5">
                    <button
                        type="button"
                        data-testid="single-file-prev-button"
                        onClick={onPrevFile}
                        disabled={isFirst}
                        title={t('rightSidebar.review.previousFile')}
                        className="flex size-6 items-center justify-center rounded text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed"
                    >
                        <ChevronLeft className="size-3.5" />
                    </button>

                    <span
                        data-testid="single-file-counter"
                        className="px-1.5 font-mono text-[11px] font-medium text-[var(--text-secondary)] whitespace-nowrap"
                    >
                        {t('rightSidebar.review.fileIndex', {
                            current: currentIndex + 1,
                            total: totalFiles,
                        })}
                    </span>

                    <button
                        type="button"
                        data-testid="single-file-next-button"
                        onClick={onNextFile}
                        disabled={isLast}
                        title={t('rightSidebar.review.nextFile')}
                        className="flex size-6 items-center justify-center rounded text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed"
                    >
                        <ChevronRight className="size-3.5" />
                    </button>
                </div>

                {/* File Icon & Path */}
                <div className="flex items-center gap-1.5 min-w-0 truncate">
                    <FileTypeIcon name={file.displayPath} className="size-3.5 shrink-0" />
                    <span className="font-mono text-[11.5px] font-medium text-[var(--text-primary)] truncate">
                        {file.displayPath}
                    </span>
                </div>
            </div>

            {/* Right: Large Diff Alert & View Mode Toggle */}
            <div className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">
                {isLargeDiff ? (
                    <div
                        data-testid="large-diff-badge"
                        title={t('rightSidebar.review.largeDiffNotice')}
                        className="flex min-w-0 max-w-full items-center gap-1 rounded bg-[var(--accent-orange)]/15 px-2 py-0.5 text-[11px] font-medium text-[var(--accent-orange)]"
                    >
                        <AlertCircle className="size-3 shrink-0" />
                        <span className="truncate">{t('rightSidebar.review.largeDiffNotice')}</span>
                    </div>
                ) : null}

                {onToggleViewMode ? (
                    <button
                        type="button"
                        data-testid="toggle-view-mode-all-files"
                        onClick={onToggleViewMode}
                        title={t('rightSidebar.review.allFilesMode')}
                        className="flex min-w-0 max-w-full items-center gap-1 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-2 py-1 text-[11.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]"
                    >
                        <Layers className="size-3.5 shrink-0" />
                        <span className="truncate">{t('rightSidebar.review.allFilesMode')}</span>
                    </button>
                ) : null}
            </div>
        </div>
    )
}
