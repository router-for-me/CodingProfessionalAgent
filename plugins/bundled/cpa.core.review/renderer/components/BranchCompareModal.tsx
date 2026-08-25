import { useState } from 'react'
import {
  ArrowLeftRight,
  GitBranch,
  GitCompare,
  X,
  CustomSelect,
  useTranslation,
  cn,
} from '@cpa/plugin-ui'

export interface BranchCompareModalProps {
  isOpen: boolean
  onClose: () => void
  currentBranch: string | null
  defaultBranch: string | null
  branches: string[]
  baseBranch: string
  compareTarget: string
  compareMode: 'workingTree' | 'branch'
  onApply: (params: {
    baseBranch: string
    compareTarget: string
    compareMode: 'workingTree' | 'branch'
  }) => void
}

export function BranchCompareModal({
  isOpen,
  onClose,
  currentBranch,
  defaultBranch,
  branches,
  baseBranch: initialBase,
  compareTarget: initialCompare,
  compareMode: initialMode,
  onApply,
}: BranchCompareModalProps) {
  const { t } = useTranslation()
  const [mode, setMode] = useState<'workingTree' | 'branch'>(initialMode)
  const [base, setBase] = useState(initialBase || defaultBranch || 'main')
  const [compare, setCompare] = useState(initialCompare || currentBranch || 'dev')

  if (!isOpen) return null

  // Format branch list as options for CustomSelect
  const branchOptions = branches.map((b) => ({
    value: b,
    label: b,
  }))

  if (branchOptions.length === 0) {
    branchOptions.push({ value: 'main', label: 'main' })
  }

  // Ensure current base and compare exist in options
  if (!branchOptions.some((o) => o.value === base)) {
    branchOptions.unshift({ value: base, label: base })
  }
  if (!branchOptions.some((o) => o.value === compare)) {
    branchOptions.unshift({ value: compare, label: compare })
  }

  const handleSwap = () => {
    const temp = base
    setBase(compare)
    setCompare(temp)
  }

  const handleSave = () => {
    onApply({
      baseBranch: base,
      compareTarget: compare,
      compareMode: mode,
    })
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
      <div
        data-testid="branch-compare-modal"
        className="w-full max-w-[420px] rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-5 shadow-2xl space-y-4 select-none"
      >
        {/* Modal Header */}
        <div className="flex items-center justify-between border-b border-[var(--border-subtle)] pb-3">
          <div className="flex items-center gap-2">
            <GitCompare className="size-4 text-[var(--accent-green)]" />
            <h3 className="text-[14px] font-semibold text-[var(--text-primary)]">
              {t('rightSidebar.review.compare')}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-[var(--text-muted)] hover:bg-white/10 hover:text-[var(--text-primary)]"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Mode selector: Working Tree vs Branch Comparison */}
        <div className="flex rounded-lg bg-[var(--bg-app)] p-1 border border-[var(--border-subtle)]">
          <button
            type="button"
            onClick={() => setMode('workingTree')}
            className={cn(
              'flex-1 rounded-md py-1.5 text-center text-[12px] font-medium transition-colors',
              mode === 'workingTree'
                ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)] shadow-xs'
                : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]',
            )}
          >
            {t('rightSidebar.review.workingTree')}
          </button>
          <button
            type="button"
            onClick={() => setMode('branch')}
            className={cn(
              'flex-1 rounded-md py-1.5 text-center text-[12px] font-medium transition-colors',
              mode === 'branch'
                ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)] shadow-xs'
                : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]',
            )}
          >
            {t('rightSidebar.review.branch')}
          </button>
        </div>

        {/* Compare Selectors */}
        {mode === 'branch' ? (
          <div className="space-y-3 pt-1">
            <div className="space-y-1">
              <label className="text-[11.5px] font-medium text-[var(--text-muted)]">
                {t('rightSidebar.review.compareBranch')} (Head)
              </label>
              <CustomSelect
                value={compare}
                options={branchOptions}
                onChange={setCompare}
                ariaLabel={t('rightSidebar.review.compareBranch')}
                icon={GitBranch}
                fullWidth
              />
            </div>

            <div className="flex justify-center">
              <button
                type="button"
                onClick={handleSwap}
                title="Swap"
                className="flex size-7 items-center justify-center rounded-full border border-[var(--border-subtle)] bg-[var(--bg-app)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-sidebar-hover)]"
              >
                <ArrowLeftRight className="size-3.5" />
              </button>
            </div>

            <div className="space-y-1">
              <label className="text-[11.5px] font-medium text-[var(--text-muted)]">
                {t('rightSidebar.review.baseBranch')} (Base)
              </label>
              <CustomSelect
                value={base}
                options={branchOptions}
                onChange={setBase}
                ariaLabel={t('rightSidebar.review.baseBranch')}
                icon={GitBranch}
                fullWidth
              />
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] p-3 text-[12px] text-[var(--text-secondary)]">
            <div className="flex items-center gap-2 font-medium text-[var(--text-primary)]">
              <GitBranch className="size-3.5 text-[var(--accent-green)]" />
              <span>
                {currentBranch ? `HEAD (${currentBranch})` : 'HEAD'}
              </span>
            </div>
            <p className="mt-1 text-[11.5px] text-[var(--text-muted)] leading-relaxed">
              {t('rightSidebar.review.desc')}
            </p>
          </div>
        )}

        {/* Footer Actions */}
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--border-subtle)]">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-[12px] font-medium text-[var(--text-muted)] hover:bg-white/10 hover:text-[var(--text-primary)]"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="rounded-lg bg-[var(--text-primary)] px-4 py-1.5 text-[12px] font-medium text-[var(--bg-app)] hover:opacity-90 transition-opacity"
          >
            {t('common.apply')}
          </button>
        </div>
      </div>
    </div>
  )
}
