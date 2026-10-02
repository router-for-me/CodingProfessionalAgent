import { useHostServices, useTranslation, PluginSurface } from '@cpa/plugin-ui'

function normalizeToolCallId(id?: string): string {
    if (!id) return ''
    return id.split('|', 1)[0] ?? id
}

function findOverlay(toolOverlays: Readonly<Record<string, any>> | undefined, id?: string): any {
    if (!toolOverlays || !id) return undefined
    const normalized = normalizeToolCallId(id)
    return (
        toolOverlays[id] ??
        toolOverlays[normalized] ??
        toolOverlays['call_' + normalized] ??
        Object.values(toolOverlays).find((item: any) => normalizeToolCallId(item?.toolCallId || '') === normalized)
    )
}

function mergeDetails(canonical: Record<string, any> | undefined, live: Record<string, any> | undefined): Record<string, any> {
    const base = canonical ?? {}
    const current = live ?? {}
    return {
        ...base,
        ...current,
        nestedTools: Array.isArray(current.nestedTools) ? current.nestedTools : base.nestedTools,
    }
}

export function ExecToolCard(props: any) {
    const services = useHostServices()
    const { t } = useTranslation()
    const part = props.part ?? props.value ?? {}
    const overlay = findOverlay(props.toolOverlays, part.id)
    const details = mergeDetails(props.details ?? part.details, overlay?.details)
    const result = part.result ?? overlay?.partialOutput ?? props.partialOutput ?? ''
    const status = details.status ?? (/\bterminated\b/.test(result) ? 'terminated' : /\byielded\b/.test(result) ? 'yielded' : /\bmissing\b|\bfailed\b/.test(result) ? 'failed' : part.status === 'done' ? 'completed' : part.status === 'error' ? 'failed' : 'running')
    const nested = Array.isArray(details.nestedTools) ? details.nestedTools : []
    const images = props.resultImages ?? part.resultImages ?? overlay?.resultImages ?? []
    return <article className="space-y-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-card)] p-3 font-[inherit] text-[var(--text-primary)]">
        <header className="flex gap-2"><span>{t(part.name === 'wait' ? 'codeMode.waitTitle' : 'codeMode.execTitle')}</span><span className="text-[var(--text-muted)]">{t(`codeMode.status.${status}`)}</span></header>
        {part.name === 'wait' ? <p>{part.args?.cell_id} {part.args?.terminate ? t('codeMode.terminate') : ''}</p> : <pre className="overflow-auto whitespace-pre-wrap font-mono">{part.args?.source ?? ''}</pre>}
        {details.cellId && <p className="text-[var(--text-secondary)]">cell_id: {details.cellId}</p>}
        {result && <pre className="overflow-auto whitespace-pre-wrap font-mono">{result}</pre>}
        {images.filter((image: any) => ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'].includes(image.mimeType)).map((image: any, index: number) => <img key={index} className="max-w-full rounded" src={`data:${image.mimeType};base64,${image.data}`} alt={t('codeMode.image')} />)}
        {nested.length > 0 && <details open={nested.some((item: any) => item.status === 'awaiting_approval')}>
            <summary>{t('codeMode.nestedTools')} ({nested.length})</summary>
            <div className="ml-4 space-y-2 border-l border-[var(--border-subtle)] pl-3">
                {nested.map((value: any) => {
                    const renderer = services?.rendererContributions?.selectChatRenderer?.(value, { target: 'part' })
                    if (!renderer) return <pre key={value.id} className="whitespace-pre-wrap font-mono">{value.name}: {value.result ?? value.status}</pre>
                    const Component = renderer.component
                    return <PluginSurface key={value.id} pluginId={renderer.pluginId ?? 'unknown'} contributionId={renderer.id}>
                        <Component {...props} part={value} value={value} details={value.details} resultImages={value.resultImages} partialOutput={undefined} statusOverride={value.status} />
                    </PluginSurface>
                })}
            </div>
        </details>}
        {details.nestedToolsTruncated && <p className="text-[var(--text-muted)]">{t('codeMode.nestedToolsTruncated')}</p>}
    </article>
}
