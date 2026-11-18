import { FileText, useTranslation } from '@cpa/plugin-ui'

export function SystemPromptBuildStatus() {
    const { t } = useTranslation()

    return (
        <div
            role="status"
            aria-live="polite"
            aria-atomic="true"
            data-testid="system-prompt-build-status"
            className="my-2 flex w-fit max-w-full min-w-0 items-center gap-2 rounded-md py-0.5 text-left text-[13px] text-[var(--text-muted)] first:mt-0"
        >
            <FileText className="size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 truncate animate-text-shimmer">
                {t('run.buildingSystemPrompt')}
            </span>
        </div>
    )
}
