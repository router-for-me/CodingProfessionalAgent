import { useTranslation } from 'react-i18next'

/**
 * Placeholder body for settings sections not implemented or not found.
 */
export function SettingsPlaceholderSection({
    sectionId,
    labelKey,
}: {
    sectionId: string
    labelKey?: string
}) {
    const { t } = useTranslation()
    const title = labelKey ? t(labelKey, { defaultValue: labelKey }) : sectionId

    return (
        <div className="mx-auto flex w-full max-w-[760px] flex-col px-8 pt-8 pb-12">
            <h1 className="text-[22px] font-semibold tracking-tight text-[var(--text-primary)]">
                {title}
            </h1>
            <p className="mt-6 max-w-md text-[13px] leading-relaxed text-[var(--text-muted)]">
                {t('placeholder.body')}
            </p>
        </div>
    )
}
