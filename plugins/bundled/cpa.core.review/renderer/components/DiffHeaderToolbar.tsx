import { useState, useRef, useEffect } from 'react'
import {
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  Columns2,
  Rows2,
  MoreHorizontal,
  Copy,
  Sparkles,
  GitPullRequest,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  Check,
  FileText,
  Layers,
  useTranslation,
  cn,
} from '@cpa/plugin-ui'
import type { GitDiffSummary } from '../utils/gitDiff.js'

export interface DiffHeaderToolbarProps {
  summary: GitDiffSummary
  currentBranch: string | null
  baseBranch: string
  compareTarget: string
  compareMode: 'workingTree' | 'branch'
  sidebarOpen: boolean
  allExpanded: boolean
  isSplitView: boolean
  isSingleFileMode?: boolean
  isLoading?: boolean
  onToggleSidebar: () => void
  onToggleAllExpanded: () => void
  onToggleSplitView: () => void
  onToggleSingleFileMode?: () => void
  onOpenCompareModal: () => void
  onRefresh: () => void
  onCopyDiff: () => void
  onCreatePullRequest: () => void
  onAiReview: () => void
}

function DiffStyleIcon({ isSplit }: { isSplit: boolean }) {
  if (isSplit) {
    return <Rows2 className="size-3.5" />
  }
  return <Columns2 className="size-3.5" />
}

export function DiffHeaderToolbar({
  summary,
  currentBranch,
  baseBranch,
  compareTarget,
  compareMode,
  sidebarOpen,
  allExpanded,
  isSplitView,
  isSingleFileMode = false,
  isLoading = false,
  onToggleSidebar,
  onToggleAllExpanded,
  onToggleSplitView,
  onToggleSingleFileMode,
  onOpenCompareModal,
  onRefresh,
  onCopyDiff,
  onCreatePullRequest,
  onAiReview,
}: DiffHeaderToolbarProps) {
  const { t } = useTranslation()
  const [moreMenuOpen, setMoreMenuOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const moreMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setMoreMenuOpen(false)
      }
    }
    if (moreMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [moreMenuOpen])

  const handleCopyDiff = () => {
    onCopyDiff()
    setCopied(true)
    setTimeout(() => {
      setCopied(false)
      setMoreMenuOpen(false)
    }, 1200)
  }

  const compareSubtitle =
    compareMode === 'workingTree'
      ? `${t('rightSidebar.review.workingTree')} → ${currentBranch || 'HEAD'}`
      : `${compareTarget} → ${baseBranch}`

  const hasDiff = summary.totalAdditions > 0 || summary.totalDeletions > 0

  return (
    <div
      data-testid="diff-header-toolbar"
      className="@container flex h-12 shrink-0 items-center justify-between border-b border-[var(--border-subtle)] bg-[var(--bg-app)] px-3 select-none"
    >
      {/* Left: Branch / Compare Dropdown Button */}
      <button
        type="button"
        data-testid="branch-compare-trigger"
        onClick={onOpenCompareModal}
        className="flex min-w-0 items-center gap-2 rounded-lg px-2.5 py-1 text-left transition-colors hover:bg-[var(--bg-sidebar-hover)] border border-transparent hover:border-[var(--border-subtle)]"
      >
        <div className="flex shrink-0 items-center gap-1">
          <span className="text-[13px] font-semibold text-[var(--text-primary)]">
            {compareMode === 'branch'
              ? t('rightSidebar.review.branch')
              : t('rightSidebar.review.workingTree')}
          </span>
          <ChevronDown className="size-3.5 text-[var(--text-muted)]" />
        </div>

        <span className="font-mono text-[11.5px] text-[var(--text-muted)] truncate max-w-[200px]">
          {compareSubtitle}
        </span>

        {/* Diff Stats Badge */}
        {hasDiff ? (
          <div className="flex shrink-0 items-center gap-1.5 font-mono text-[11.5px] font-semibold">
            {summary.totalAdditions > 0 ? (
              <span className="text-[var(--accent-green)]">+{summary.totalAdditions}</span>
            ) : null}
            {summary.totalDeletions > 0 ? (
              <span className="text-[#f87171]">-{summary.totalDeletions}</span>
            ) : null}
          </div>
        ) : (
          <span className="shrink-0 text-[11.5px] text-[var(--text-muted)]">
            {t('rightSidebar.review.noDiff')}
          </span>
        )}
      </button>

      {/* Right Toolbar Action Icons */}
      <div className="flex items-center gap-1 shrink-0">
        {/* Refresh button */}
        <button
          type="button"
          onClick={onRefresh}
          title={t('rightSidebar.review.refresh')}
          className="flex size-7.5 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]"
        >
          <RefreshCw className={cn('size-3.5', isLoading && 'animate-spin')} />
        </button>

        {/* Toggle All Expand / Collapse */}
        <button
          type="button"
          data-testid="toggle-all-expanded-button"
          onClick={onToggleAllExpanded}
          title={allExpanded ? t('rightSidebar.review.collapseAll') : t('rightSidebar.review.expandAll')}
          className="flex size-7.5 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]"
        >
          {allExpanded ? (
            <ChevronsDownUp className="size-3.5" />
          ) : (
            <ChevronsUpDown className="size-3.5" />
          )}
        </button>

        {/* Toggle Unified / Split Diff View Style */}
        <button
          type="button"
          data-testid="diff-view-style-toggle"
          onClick={onToggleSplitView}
          title={isSplitView ? t('rightSidebar.review.unifiedView') : t('rightSidebar.review.splitView')}
          className={cn(
            'flex size-7.5 items-center justify-center rounded-md transition-colors',
            isSplitView
              ? 'bg-white/[0.08] text-[var(--text-primary)]'
              : 'text-[var(--text-muted)] hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
          )}
        >
          <DiffStyleIcon isSplit={isSplitView} />
        </button>

        {/* Toggle Single File / All Files View Mode */}
        {onToggleSingleFileMode && summary.files.length > 0 ? (
          <button
            type="button"
            data-testid="diff-view-mode-toggle"
            onClick={onToggleSingleFileMode}
            title={
              isSingleFileMode
                ? t('rightSidebar.review.allFilesMode')
                : t('rightSidebar.review.singleFileMode')
            }
            className={cn(
              'flex size-7.5 items-center justify-center rounded-md transition-colors',
              isSingleFileMode
                ? 'bg-white/[0.08] text-[var(--text-primary)]'
                : 'text-[var(--text-muted)] hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
            )}
          >
            {isSingleFileMode ? (
              <FileText className="size-3.5" />
            ) : (
              <Layers className="size-3.5" />
            )}
          </button>
        ) : null}

        {/* Toggle File Tree Sidebar */}
        <button
          type="button"
          onClick={onToggleSidebar}
          title={t('rightSidebar.review.toggleSidebar')}
          className={cn(
            'flex size-7.5 items-center justify-center rounded-md transition-colors',
            sidebarOpen
              ? 'bg-white/[0.08] text-[var(--text-primary)]'
              : 'text-[var(--text-muted)] hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
          )}
        >
          {sidebarOpen ? (
            <PanelRightClose className="size-3.5" />
          ) : (
            <PanelRightOpen className="size-3.5" />
          )}
        </button>

        {/* More Menu */}
        <div className="relative" ref={moreMenuRef}>
          <button
            type="button"
            data-testid="diff-toolbar-more-button"
            onClick={() => setMoreMenuOpen((v) => !v)}
            title={t('common.more', 'More')}
            className="flex size-7.5 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]"
          >
            <MoreHorizontal className="size-4" />
          </button>

          {moreMenuOpen ? (
            <>
              <div
                className="fixed inset-0 z-40"
                onClick={() => setMoreMenuOpen(false)}
              />
              <div className="absolute right-0 top-full z-50 mt-1 w-48 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-1 shadow-xl">
                <button
                  type="button"
                  data-testid="diff-toolbar-copy-diff-button"
                  onClick={handleCopyDiff}
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]"
                >
                  {copied ? (
                    <Check className="size-3.5 text-green-400" />
                  ) : (
                    <Copy className="size-3.5" />
                  )}
                  <span>{t('rightSidebar.review.copyDiff')}</span>
                </button>

                {onToggleSingleFileMode && summary.files.length > 0 ? (
                  <button
                    type="button"
                    data-testid="diff-toolbar-toggle-view-mode-menu"
                    onClick={() => {
                      setMoreMenuOpen(false)
                      onToggleSingleFileMode()
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]"
                  >
                    {isSingleFileMode ? (
                      <Layers className="size-3.5" />
                    ) : (
                      <FileText className="size-3.5" />
                    )}
                    <span>
                      {isSingleFileMode
                        ? t('rightSidebar.review.allFilesMode')
                        : t('rightSidebar.review.singleFileMode')}
                    </span>
                  </button>
                ) : null}

                <button
                  type="button"
                  data-testid="diff-toolbar-ai-review-button"
                  onClick={() => {
                    setMoreMenuOpen(false)
                    onAiReview()
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]"
                >
                  <Sparkles className="size-3.5 text-[var(--accent-purple)]" />
                  <span>{t('rightSidebar.review.aiReview')}</span>
                </button>
              </div>
            </>
          ) : null}
        </div>

        {/* Create Pull Request Button */}
        <button
          type="button"
          data-testid="create-pr-button"
          onClick={onCreatePullRequest}
          title={t('rightSidebar.review.createPr')}
          className={cn(
            'ml-1 inline-flex size-7.5 @xl:size-auto @xl:h-7.5 items-center justify-center @xl:gap-1.5 rounded-lg bg-[var(--bg-elevated)] @xl:px-2.5 text-[12px] font-medium text-[var(--text-primary)]',
            'border border-[var(--border-subtle)] hover:bg-[var(--bg-sidebar-hover)] transition-colors',
          )}
        >
          <GitPullRequest className="size-3.5 text-[var(--accent-green)] shrink-0" />
          <span className="hidden @xl:inline">{t('rightSidebar.review.createPr')}</span>
        </button>
      </div>
    </div>
  )
}
