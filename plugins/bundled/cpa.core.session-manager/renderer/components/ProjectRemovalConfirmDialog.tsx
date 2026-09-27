import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useHostService, useTranslation, useWorkspaceVisible } from '@cpa/plugin-ui'
import { UiServiceToken, type Project } from '@cpa/plugin-api'

interface ProjectRemovalConfirmDialogProps {
    project: Project
    onCancel: () => void
    onConfirm: () => Promise<void>
}

export function ProjectRemovalConfirmDialog({
    project,
    onCancel,
    onConfirm,
}: ProjectRemovalConfirmDialogProps) {
    const { t } = useTranslation()
    const workspaceVisible = useWorkspaceVisible()
    const uiService = useHostService(UiServiceToken)
    const titleId = useId()
    const descriptionId = useId()
    const cancelRef = useRef<HTMLButtonElement>(null)
    const confirmRef = useRef<HTMLButtonElement>(null)
    const [removing, setRemoving] = useState(false)

    useEffect(() => {
        if (workspaceVisible) cancelRef.current?.focus()
    }, [workspaceVisible])

    useEffect(() => {
        if (!workspaceVisible) return
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && !removing) {
                event.preventDefault()
                onCancel()
            }
        }
        document.addEventListener('keydown', handleKeyDown)
        return () => document.removeEventListener('keydown', handleKeyDown)
    }, [onCancel, removing, workspaceVisible])

    const handleConfirm = async () => {
        if (removing) return
        setRemoving(true)
        try {
            await onConfirm()
        } catch {
            uiService?.pushToast(t('project.removeFailed'), 'error')
            setRemoving(false)
        }
    }

    if (typeof document === 'undefined') return null

    return createPortal(
        <div
            className="fixed inset-0 z-[80] flex items-center justify-center bg-black/55 p-5"
            style={workspaceVisible ? undefined : { display: 'none' }}
            inert={!workspaceVisible}
            aria-hidden={!workspaceVisible}
            role="presentation"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget && !removing) onCancel()
            }}
        >
            <div
                role="alertdialog"
                aria-modal="true"
                aria-labelledby={titleId}
                aria-describedby={descriptionId}
                className="w-full max-w-[420px] rounded-[18px] border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-5 text-[var(--text-primary)] shadow-2xl"
                onKeyDown={(event) => {
                    if (event.key !== 'Tab') return
                    if (event.shiftKey && document.activeElement === cancelRef.current) {
                        event.preventDefault()
                        confirmRef.current?.focus()
                    } else if (!event.shiftKey && document.activeElement === confirmRef.current) {
                        event.preventDefault()
                        cancelRef.current?.focus()
                    }
                }}
            >
                <h2 id={titleId} className="text-[18px] font-semibold">
                    {t('project.removeConfirmTitle', { name: project.name })}
                </h2>
                <p id={descriptionId} className="mt-3 text-[13px] text-[var(--text-secondary)]">
                    {t('project.removeConfirmDescription')}
                </p>
                <div className="mt-6 flex justify-end gap-2">
                    <button
                        ref={cancelRef}
                        type="button"
                        disabled={removing}
                        className="rounded-lg px-4 py-2 text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)] disabled:opacity-40"
                        onClick={onCancel}
                    >
                        {t('common.cancel')}
                    </button>
                    <button
                        ref={confirmRef}
                        type="button"
                        disabled={removing}
                        className="rounded-lg bg-red-500/15 px-4 py-2 text-[13px] font-medium text-red-400 transition-colors hover:bg-red-500/25 hover:text-red-300 disabled:opacity-40"
                        onClick={() => void handleConfirm()}
                    >
                        {t('project.remove')}
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    )
}
