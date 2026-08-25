import { useState, useRef, type ChangeEvent } from 'react'
import {
    Upload,
    X,
    cn,
    useTranslation,
} from '@cpa/plugin-ui'
import type { AppSettings } from '@cpa/plugin-api'

export interface ThemeImportDialogProps {
    open: boolean
    onClose: () => void
    onImport: (themeConfig: Partial<AppSettings>) => void
}

export function ThemeImportDialog({
    open,
    onClose,
    onImport,
}: ThemeImportDialogProps) {
    const { t } = useTranslation()
    const [jsonText, setJsonText] = useState('')
    const [error, setError] = useState<string | null>(null)
    const fileInputRef = useRef<HTMLInputElement>(null)

    if (!open) return null

    const handleFileUpload = (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0]
        if (!file) return
        const reader = new FileReader()
        reader.onload = (e) => {
            const content = e.target?.result
            if (typeof content === 'string') {
                setJsonText(content)
                setError(null)
            }
        }
        reader.readAsText(file)
    }

    const handleConfirm = () => {
        try {
            const parsed = JSON.parse(jsonText.trim())
            if (typeof parsed !== 'object' || parsed === null) {
                throw new Error('Root must be an object')
            }
            setError(null)
            onImport(parsed as Partial<AppSettings>)
            onClose()
        } catch {
            setError(t('settings.appearance.importError'))
        }
    }

    return (
        <div
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="import-dialog-title"
        >
            <div className="w-full max-w-[500px] rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-6 shadow-2xl">
                <div className="flex items-center justify-between pb-3 border-b border-[var(--border-subtle)]">
                    <h2
                        id="import-dialog-title"
                        className="text-[16px] font-semibold text-[var(--text-primary)]"
                    >
                        {t('settings.appearance.importDialog.title')}
                    </h2>
                    <button
                        type="button"
                        className="rounded-md p-1 text-[var(--text-muted)] hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)] transition-colors"
                        onClick={onClose}
                    >
                        <X className="size-4" />
                    </button>
                </div>

                <div className="mt-4 space-y-3">
                    <textarea
                        value={jsonText}
                        rows={8}
                        placeholder={t('settings.appearance.importDialog.placeholder')}
                        className={cn(
                            'w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-sidebar-hover)] p-3',
                            'font-mono text-[12px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)]',
                            'outline-none focus:border-[var(--accent-blue)] focus:ring-1 focus:ring-[var(--accent-blue)]',
                        )}
                        onChange={(e) => {
                            setJsonText(e.target.value)
                            if (error) setError(null)
                        }}
                    />

                    {error ? (
                        <div className="text-[12px] text-red-400 font-medium">{error}</div>
                    ) : null}

                    <div className="flex items-center justify-between pt-1">
                        <button
                            type="button"
                            className={cn(
                                'inline-flex items-center gap-2 rounded-lg border border-[var(--border-subtle)]',
                                'bg-[var(--bg-sidebar)] px-3 py-1.5 text-[12px] text-[var(--text-secondary)]',
                                'hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)] transition-colors',
                            )}
                            onClick={() => fileInputRef.current?.click()}
                        >
                            <Upload className="size-3.5" />
                            <span>{t('settings.appearance.importDialog.uploadFile')}</span>
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept=".json,application/json"
                                className="sr-only"
                                onChange={handleFileUpload}
                            />
                        </button>

                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                className={cn(
                                    'rounded-lg px-3 py-1.5 text-[13px] text-[var(--text-muted)]',
                                    'hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)] transition-colors',
                                )}
                                onClick={onClose}
                            >
                                {t('settings.appearance.importDialog.cancel')}
                            </button>
                            <button
                                type="button"
                                disabled={!jsonText.trim()}
                                className={cn(
                                    'rounded-lg bg-[var(--accent-blue)] px-4 py-1.5 text-[13px] font-medium text-white',
                                    'hover:opacity-90 disabled:opacity-40 transition-opacity',
                                )}
                                onClick={handleConfirm}
                            >
                                {t('settings.appearance.importDialog.confirm')}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    )
}
