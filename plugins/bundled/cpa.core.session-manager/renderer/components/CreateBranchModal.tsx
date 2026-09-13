import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, X, cn, useSettings, useTranslation } from '@cpa/plugin-ui'
import { isValidGitBranchName } from '../utils/gitBranches.js'

export interface CreateBranchModalProps {
    isOpen: boolean
    onClose: () => void
    onConfirm: (branchName: string) => Promise<void> | void
    existingBranches?: readonly string[]
    initialValue?: string
    branchPrefix?: string
}

/**
 * Modal dialog for creating and checking out a new Git branch.
 */
export function CreateBranchModal({
    isOpen,
    onClose,
    onConfirm,
    existingBranches = [],
    initialValue = '',
    branchPrefix: customBranchPrefix,
}: CreateBranchModalProps) {
    const { t } = useTranslation()
    const settings = useSettings()
    const titleId = useId()
    const inputId = useId()
    const inputRef = useRef<HTMLInputElement>(null)

    const defaultPrefix = typeof settings?.git?.branchPrefix === 'string'
        ? settings.git.branchPrefix
        : ''
    const effectivePrefix = customBranchPrefix !== undefined ? customBranchPrefix : defaultPrefix

    const computeInitialValue = () => {
        const trimmed = typeof initialValue === 'string' ? initialValue.trim() : ''
        if (trimmed) {
            if (effectivePrefix && !trimmed.startsWith(effectivePrefix)) {
                return `${effectivePrefix}${trimmed}`
            }
            return trimmed
        }
        return effectivePrefix || ''
    }

    const [branchName, setBranchName] = useState(computeInitialValue)
    const [isSubmitting, setIsSubmitting] = useState(false)

    // Reset input value when modal opens
    useEffect(() => {
        if (isOpen) {
            const nextValue = computeInitialValue()
            setBranchName(nextValue)
            setIsSubmitting(false)
            if (inputRef.current) {
                inputRef.current.focus()
                const len = nextValue.length
                try {
                    inputRef.current.setSelectionRange(len, len)
                } catch {
                    // Ignore selection errors in environments without text selection support
                }
            }
        }
    }, [isOpen])

    // Handle Escape key to close modal
    useEffect(() => {
        if (!isOpen) return
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && !isSubmitting) {
                onClose()
            }
        }
        document.addEventListener('keydown', handleKeyDown)
        return () => document.removeEventListener('keydown', handleKeyDown)
    }, [isOpen, isSubmitting, onClose])

    if (!isOpen || typeof document === 'undefined') {
        return null
    }

    const trimmed = branchName.trim()
    let errorMessage: string | null = null

    // Validation rules:
    // 1. Cannot end with '/'
    // 2. Cannot already exist in existingBranches
    // 3. Must satisfy git branch naming requirements
    if (trimmed.endsWith('/')) {
        errorMessage = t('composer.branchNameCannotEndWithSlash', {
            defaultValue: '分支名不能以“/”结尾。',
        })
    } else if (trimmed && existingBranches.includes(trimmed)) {
        errorMessage = t('composer.branchAlreadyExists', {
            defaultValue: '该分支已存在',
        })
    } else if (trimmed && !isValidGitBranchName(trimmed)) {
        errorMessage = t('composer.invalidBranchName', {
            defaultValue: '无效的分支名',
        })
    }

    const hasError = Boolean(errorMessage)
    const isValid = Boolean(trimmed && !hasError)

    const handleConfirm = async () => {
        if (!isValid || isSubmitting) return
        setIsSubmitting(true)
        try {
            await onConfirm(trimmed)
        } finally {
            setIsSubmitting(false)
        }
    }

    return createPortal(
        <div
            className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs"
            role="presentation"
            onMouseDown={(e) => {
                if (e.target === e.currentTarget && !isSubmitting) {
                    onClose()
                }
            }}
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                className="w-full max-w-[420px] rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-5 text-[var(--text-primary)] shadow-2xl animate-in fade-in zoom-in-95 duration-150"
            >
                {/* Header */}
                <div className="mb-4 flex items-center justify-between">
                    <h2
                        id={titleId}
                        className="text-[16px] font-semibold text-[var(--text-primary)]"
                    >
                        {t('composer.createBranchModalTitle', {
                            defaultValue: '创建并检出分支',
                        })}
                    </h2>
                    <button
                        type="button"
                        aria-label={t('composer.closeDialog', { defaultValue: 'Close dialog' })}
                        disabled={isSubmitting}
                        onClick={onClose}
                        className="flex size-7 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)] disabled:opacity-50"
                    >
                        <X className="size-4" aria-hidden />
                    </button>
                </div>

                {/* Body Form */}
                <div className="mb-2">
                    <label
                        htmlFor={inputId}
                        className="mb-2 block text-[13px] font-medium text-[var(--text-primary)]"
                    >
                        {t('composer.branchNameLabel', {
                            defaultValue: '分支名称',
                        })}
                    </label>
                    <input
                        id={inputId}
                        ref={inputRef}
                        type="text"
                        value={branchName}
                        onChange={(e) => setBranchName(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && isValid && !isSubmitting) {
                                e.preventDefault()
                                void handleConfirm()
                            }
                        }}
                        placeholder={t('composer.enterBranchName', {
                            defaultValue: '输入新分支名称',
                        })}
                        disabled={isSubmitting}
                        className={cn(
                            'h-10 w-full rounded-lg border bg-[var(--bg-app)] px-3 text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none transition-colors',
                            hasError
                                ? 'border-red-500/80 focus:border-red-500 focus:ring-1 focus:ring-red-500/30'
                                : 'border-[var(--border-subtle)] focus:border-[var(--accent-blue)] focus:ring-1 focus:ring-[var(--accent-blue)]/30',
                        )}
                    />
                    <div className="mt-1.5 min-h-[20px] text-[12px] text-red-400">
                        {errorMessage || ''}
                    </div>
                </div>

                {/* Footer Buttons */}
                <div className="mt-5 flex items-center justify-end gap-2.5">
                    <button
                        type="button"
                        disabled={isSubmitting}
                        onClick={onClose}
                        className="rounded-lg px-4 py-2 text-[13px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)] disabled:opacity-50"
                    >
                        {t('composer.close', { defaultValue: '关闭' })}
                    </button>
                    <button
                        type="button"
                        disabled={!isValid || isSubmitting}
                        onClick={() => void handleConfirm()}
                        className={cn(
                            'flex items-center gap-1.5 rounded-lg px-4 py-2 text-[13px] font-medium transition-colors',
                            isValid && !isSubmitting
                                ? 'bg-[var(--accent-blue)] text-white hover:opacity-90 active:scale-[0.98]'
                                : 'cursor-not-allowed border border-[var(--border-subtle)]/50 bg-[var(--bg-card)] text-[var(--text-muted)] opacity-50',
                        )}
                    >
                        {isSubmitting ? (
                            <Loader2 className="size-3.5 animate-spin" aria-hidden />
                        ) : null}
                        <span>
                            {t('composer.createAndCheckout', {
                                defaultValue: '创建并检出',
                            })}
                        </span>
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    )
}
