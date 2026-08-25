import {
  useTranslation,
  useHostServices,
  useSettings,
  cn,
} from '@cpa/plugin-ui'
import type { SubAgentRecord, ModelCatalogEntry } from '@cpa/plugin-api'
import { subAgentDisplayMeta } from '../utils/subAgentMeta.js'

export function SubAgentMetaText({
  agent,
  className,
}: {
  agent: Pick<SubAgentRecord, 'modelId' | 'reasoningEffort'>
  className?: string
}) {
  const { t } = useTranslation()
  const services = useHostServices()
  const settings = useSettings()
  const models = (services?.models?.getModels?.() ?? []) as readonly ModelCatalogEntry[]
  const preferredReasoning = settings?.reasoningLevel
  const meta = subAgentDisplayMeta(agent, models, preferredReasoning, t)
  const label = meta.reasoningLabel
    ? `${meta.modelLabel} · ${meta.reasoningLabel}`
    : meta.modelLabel

  return (
    <span
      className={cn(
        'min-w-0 truncate text-[11px] text-[var(--text-muted)]',
        className,
      )}
      data-testid="subagent-model-meta"
      title={label}
    >
      {label}
    </span>
  )
}
