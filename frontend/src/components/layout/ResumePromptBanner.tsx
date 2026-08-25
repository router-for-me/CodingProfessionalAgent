import { Clock } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { isBrowserEnvironment } from '@/lib/platform'
import { getHostBridge } from '@/application/services/hostTransport'
import { useResumePromptStore } from '@/stores/resumePromptStore'

/**
 * Prompt banner shown in sidebar above UserFooter when unfinished tasks/conversations
 * are detected on app launch.
 */
export function ResumePromptBanner() {
  const { t } = useTranslation()
  const isOpen = useResumePromptStore((s) => s.isOpen)
  const totalCount = useResumePromptStore((s) => s.totalCount)
  const countdown = useResumePromptStore((s) => s.countdown)
  const onContinueAction = useResumePromptStore((s) => s.onContinueAction)
  const onAbortAction = useResumePromptStore((s) => s.onAbortAction)
  const closePrompt = useResumePromptStore((s) => s.closePrompt)

  if (!isOpen) {
    return null
  }

  const handleContinue = () => {
    const action = onContinueAction
    closePrompt()
    if (action) {
      void action()
    } else if (isBrowserEnvironment()) {
      const bridge = getHostBridge()
      if (typeof bridge?.SessionResumePromptAction === 'function') {
        void bridge.SessionResumePromptAction('continue')
      }
    }
  }

  const handleAbort = () => {
    const action = onAbortAction
    closePrompt()
    if (action) {
      void action()
    } else if (isBrowserEnvironment()) {
      const bridge = getHostBridge()
      if (typeof bridge?.SessionResumePromptAction === 'function') {
        void bridge.SessionResumePromptAction('abort')
      }
    }
  }

  return (
    <div
      role="region"
      aria-label={t('resumePrompt.message', { count: totalCount, seconds: countdown })}
      className="mx-2 mb-2 flex flex-col gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-2.5 shadow-lg select-none"
    >
      <div className="flex items-start gap-2">
        <Clock className="mt-0.5 size-3.5 shrink-0 text-[var(--accent-blue)]" />
        <p className="text-[12px] leading-snug font-medium text-[var(--text-primary)]">
          {t('resumePrompt.message', { count: totalCount, seconds: countdown })}
        </p>
      </div>
      <div className="flex items-center gap-1.5 pt-0.5">
        <button
          type="button"
          onClick={handleContinue}
          className="flex-1 cursor-pointer rounded-lg bg-[var(--accent-blue)] px-2.5 py-1.5 text-center text-[11px] font-medium text-white shadow-xs transition-colors hover:bg-[var(--accent-blue)]/90"
        >
          {t('resumePrompt.resumeNow')}
        </button>
        <button
          type="button"
          onClick={handleAbort}
          className="flex-1 cursor-pointer rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-sidebar-hover)] px-2.5 py-1.5 text-center text-[11px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-sidebar)] hover:text-[var(--text-primary)]"
        >
          {t('resumePrompt.abort')}
        </button>
      </div>
    </div>
  )
}
