import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import {
    RotateCcw,
    Trash2,
    X,
    cn,
    useTranslation,
} from '@cpa/plugin-ui'
import { eventToShortcutBinding } from './formatKey.js'
import {
    areShortcutBindingsEqual,
    formatShortcutBinding,
    normalizeShortcutBinding,
    type ShortcutItem,
    type ShortcutKeyBinding,
} from './shortcutsData.js'

interface ShortcutEditDialogProps {
    item: ShortcutItem
    index: number // -1 for adding/editing unassigned, >= 0 for editing specific existing shortcut
    currentShortcuts: ShortcutKeyBinding[]
    isOpen: boolean
    onClose: () => void
    onSave: (newShortcuts: ShortcutKeyBinding[]) => void
}

export function ShortcutEditDialog({
    item,
    index,
    currentShortcuts,
    isOpen,
    onClose,
    onSave,
}: ShortcutEditDialogProps) {
    const { t } = useTranslation()
    const [draftBinding, setDraftBinding] = useState<ShortcutKeyBinding | null>(null)
    const [draftValue, setDraftValue] = useState<string>('')
    const [isRecording, setIsRecording] = useState(false)
    const inputRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
        if (isOpen) {
            if (index >= 0 && index < currentShortcuts.length) {
                const existing = currentShortcuts[index]
                if (existing) {
                    setDraftBinding(existing)
                    setDraftValue(formatShortcutBinding(existing))
                }
            } else {
                setDraftBinding(null)
                setDraftValue('')
            }
            setIsRecording(false)
        }
    }, [isOpen, index, currentShortcuts])

    if (!isOpen) return null

    const handleKeyDownCapture = (event: ReactKeyboardEvent<HTMLInputElement>) => {
        event.preventDefault()
        event.stopPropagation()

        const binding = eventToShortcutBinding(event)
        if (binding) {
            setDraftBinding(binding)
            setDraftValue(formatShortcutBinding(binding))
            setIsRecording(false)
        }
    }

    const handleSave = () => {
        const resolvedBinding = draftBinding ?? normalizeShortcutBinding(draftValue.trim())
        const next = [...currentShortcuts]
        if (index >= 0 && index < next.length) {
            if (resolvedBinding) {
                next[index] = resolvedBinding
            } else {
                next.splice(index, 1)
            }
        } else if (resolvedBinding) {
            next.push(resolvedBinding)
        }

        // Deduplicate bindings
        const unique: ShortcutKeyBinding[] = []
        for (const b of next) {
            if (!unique.some((u) => areShortcutBindingsEqual(u, b))) {
                unique.push(b)
            }
        }

        onSave(unique)
        onClose()
    }

    const handleClear = () => {
        const next = [...currentShortcuts]
        if (index >= 0 && index < next.length) {
            next.splice(index, 1)
        }
        onSave(next)
        onClose()
    }

    const handleResetDefault = () => {
        onSave(item.defaultShortcuts)
        onClose()
    }

    return (
        <div
            className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-xs p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="shortcut-dialog-title"
            onClick={onClose}
        >
            <div
                className={cn(
                    'w-full max-w-md rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-6 shadow-2xl',
                    'text-[var(--text-primary)]',
                )}
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between pb-3">
                    <h2
                        id="shortcut-dialog-title"
                        className="text-[16px] font-semibold text-[var(--text-primary)]"
                    >
                        {t(item.titleKey, item.titleZh)}
                    </h2>
                    <button
                        type="button"
                        className="rounded-md p-1 text-[var(--text-muted)] hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)] transition-colors"
                        onClick={onClose}
                    >
                        <X className="size-4" />
                    </button>
                </div>

                <p className="text-[12px] text-[var(--text-muted)] pb-4">
                    {t(item.descKey, item.descEn)}
                </p>

                <div className="space-y-3 pb-6">
                    <div className="text-[12px] font-medium text-[var(--text-secondary)]">
                        {isRecording
                            ? t('shortcuts.dialog.recording', 'Press keys...')
                            : t('shortcuts.dialog.pressKeys', 'Click input and press shortcut keys')}
                    </div>
                    <div className="relative">
                        <input
                            ref={inputRef}
                            type="text"
                            readOnly
                            value={draftValue}
                            placeholder={t('shortcuts.dialog.placeholder', 'e.g. ⌘ K')}
                            className={cn(
                                'w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-sidebar-hover)] px-3.5 py-2.5',
                                'font-mono text-[14px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)]',
                                'outline-none cursor-pointer text-center font-semibold tracking-wider',
                                isRecording && 'ring-2 ring-[var(--accent-blue)] border-transparent',
                            )}
                            onFocus={() => setIsRecording(true)}
                            onBlur={() => setIsRecording(false)}
                            onKeyDown={handleKeyDownCapture}
                        />
                    </div>
                </div>

                <div className="flex items-center justify-between pt-2 border-t border-[var(--border-subtle)]">
                    <div className="flex items-center gap-2">
                        {index >= 0 ? (
                            <button
                                type="button"
                                className={cn(
                                    'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] text-rose-400',
                                    'hover:bg-rose-500/10 hover:text-rose-300 transition-colors',
                                )}
                                onClick={handleClear}
                            >
                                <Trash2 className="size-3.5" />
                                <span>{t('shortcuts.dialog.deleteShortcut', 'Delete shortcut')}</span>
                            </button>
                        ) : null}

                        <button
                            type="button"
                            className={cn(
                                'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] text-[var(--text-muted)]',
                                'hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)] transition-colors',
                            )}
                            onClick={handleResetDefault}
                        >
                            <RotateCcw className="size-3.5" />
                            <span>{t('shortcuts.dialog.resetDefault', 'Reset to default')}</span>
                        </button>
                    </div>

                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            className={cn(
                                'rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-sidebar)]',
                                'px-3 py-1.5 text-[12px] text-[var(--text-secondary)] transition-colors',
                                'hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
                            )}
                            onClick={onClose}
                        >
                            {t('common.cancel')}
                        </button>
                        <button
                            type="button"
                            className={cn(
                                'rounded-lg bg-[var(--accent-blue)] px-4 py-1.5 text-[12px] font-medium text-white shadow-xs',
                                'hover:bg-[var(--accent-blue)]/90 transition-colors',
                            )}
                            onClick={handleSave}
                        >
                            {t('common.save')}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    )
}
