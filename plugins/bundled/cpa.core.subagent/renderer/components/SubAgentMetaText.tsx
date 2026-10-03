import {
    useTranslation,
    useModelCatalog,
    useSettings,
    Zap,
    cn,
} from '@cpa/plugin-ui'
import type { SubAgentRecord } from '@cpa/plugin-api'
import { subAgentDisplayMeta } from '../utils/subAgentMeta.js'

export function SubAgentMetaText({
    agent,
    className,
}: {
    agent: Pick<SubAgentRecord, 'modelId' | 'reasoningEffort' | 'speed'>
    className?: string
}) {
    const { t } = useTranslation()
    const settings = useSettings()
    const { models } = useModelCatalog()
    const preferredReasoning = settings?.reasoningLevel
    const meta = subAgentDisplayMeta(agent, models, preferredReasoning, t)
    const label = meta.reasoningLabel
        ? `${meta.modelLabel} · ${meta.reasoningLabel}`
        : meta.modelLabel
    // Use the executed run's recorded speed, never current global or session preferences.
    const isFastEnabled = Boolean(
        models.find((model) => model.id === agent.modelId)?.supportsFast &&
        agent.speed && agent.speed !== 'standard',
    )
    const fastLabel = t('composer.speed.fast', { defaultValue: 'Fast' })

    return (
        <span
            className={cn(
                'inline-flex min-w-0 items-center gap-1 text-[11px] text-[var(--text-muted)]',
                className,
            )}
            data-testid="subagent-model-meta"
            title={isFastEnabled ? `${label} · ${fastLabel}` : label}
        >
            <span className="truncate">{label}</span>
            {isFastEnabled ? (
                <>
                    <Zap className="size-3 shrink-0 text-[var(--accent-blue)]" aria-hidden />
                    <span className="sr-only">{fastLabel}</span>
                </>
            ) : null}
        </span>
    )
}
