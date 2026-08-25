import { useState, useEffect, useMemo } from 'react'
import { cn, useHostServices, useTranslation } from '@cpa/plugin-ui'

export type ViewMode = 'daily' | 'weekly' | 'cumulative'

export interface HeatmapCell {
    dateKey: string
    tokens: number
    chats: number
    level: number
    isFuture: boolean
    weekIndex: number
    dayIndex: number
    tooltip: string
}

export interface ModelRankingItem {
    modelId: string
    count: number
    totalTokens: number
    percentage?: number
}

export interface MetricSummary {
    totalTokens: number
    totalCost: number
    maxTaskDurationMs: number
    currentStreakDays: number
    longestStreakDays: number
    fastMode: {
        count: number
        percentage: number
    }
    topReasoningEffort: {
        level: string
        count: number
        percentage: number
    } | null
    uniqueSkillsCount: number
    totalSkillInvocations: number
    totalChats: number
    topSkills: Array<{ name: string; count: number }>
    topModels?: ModelRankingItem[]
}

export interface MetricBucket {
    bucketKey: string
    startTimeMs?: number
    endTimeMs?: number
    metrics: {
        totalTokens: number
        totalChats: number
        maxTaskDurationMs?: number
        fastMode?: {
            count: number
            percentage: number
        }
        totalCost?: number
        topModels?: ModelRankingItem[]
    }
}

/**
 * Superpowers / Litepowers Spiral Badge Icon
 */
export function SpiralIcon({ className }: { className?: string }) {
    return (
        <span
            className={cn(
                'flex size-5 shrink-0 items-center justify-center rounded-full bg-[rgba(255,255,255,0.08)] text-[var(--text-secondary)]',
                className,
            )}
            aria-hidden
        >
            <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="size-3"
            >
                <path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5" />
                <circle cx="12" cy="12" r="1.5" fill="currentColor" />
            </svg>
        </span>
    )
}

/**
 * GitHub Octocat Icon
 */
export function GithubIcon({ className }: { className?: string }) {
    return (
        <span
            className={cn(
                'flex size-5 shrink-0 items-center justify-center rounded-full bg-[rgba(255,255,255,0.08)] text-[var(--text-secondary)]',
                className,
            )}
            aria-hidden
        >
            <svg
                viewBox="0 0 24 24"
                fill="currentColor"
                className="size-3"
            >
                <path
                    fillRule="evenodd"
                    clipRule="evenodd"
                    d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
                />
            </svg>
        </span>
    )
}

/**
 * Browser Window Icon
 */
export function BrowserIcon({ className }: { className?: string }) {
    return (
        <span
            className={cn(
                'flex size-5 shrink-0 items-center justify-center rounded-full bg-[rgba(255,255,255,0.08)] text-[var(--text-secondary)]',
                className,
            )}
            aria-hidden
        >
            <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="size-3"
            >
                <rect width="18" height="14" x="3" y="5" rx="2" />
                <path d="M3 9h18" />
                <path d="M7 7h.01" />
                <path d="M10 7h.01" />
            </svg>
        </span>
    )
}

/**
 * Icon renderer matched by skill or plugin name
 */
export function SkillIcon({ name, className }: { name: string; className?: string }) {
    const lower = name.toLowerCase()
    if (lower.startsWith('gh') || lower.includes('git')) {
        return <GithubIcon className={className} />
    }
    if (lower.includes('browser') || lower.includes('web')) {
        return <BrowserIcon className={className} />
    }
    return <SpiralIcon className={className} />
}

/**
 * Model Icon with provider-specific visual hints
 */
export function ModelIcon({ modelId, className }: { modelId: string; className?: string }) {
    const lower = (modelId || '').toLowerCase()
    return (
        <span
            className={cn(
                'flex size-5 shrink-0 items-center justify-center rounded-full bg-[rgba(255,255,255,0.08)] text-[var(--text-secondary)]',
                className,
            )}
            aria-hidden
        >
            {lower.includes('claude') || lower.includes('anthropic') ? (
                <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="size-3"
                >
                    <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
                </svg>
            ) : lower.includes('gemini') || lower.includes('google') ? (
                <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="size-3"
                >
                    <path d="M12 2v20M2 12h20M4.93 4.93l14.14 14.14M4.93 19.07 19.07 4.93" />
                </svg>
            ) : lower.includes('gpt') ||
              lower.includes('openai') ||
              lower.includes('o1') ||
              lower.includes('o3') ? (
                <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="size-3"
                >
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 7v5l3 3" />
                </svg>
            ) : lower.includes('deepseek') ? (
                <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="size-3"
                >
                    <circle cx="12" cy="12" r="10" />
                    <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
                </svg>
            ) : (
                <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="size-3"
                >
                    <rect width="18" height="18" x="3" y="3" rx="2" />
                    <path d="M9 3v18M15 3v18M3 9h18M3 15h18" />
                </svg>
            )}
        </span>
    )
}

export function formatSkillName(name: string): string {
    if (name.startsWith('@') || name.startsWith('$')) {
        return name
    }
    return `$${name}`
}

export function formatTokenCount(tokens: number, _isZh?: boolean): string {
    if (!tokens || tokens <= 0 || isNaN(tokens)) return '0'
    if (tokens >= 1_000_000_000) {
        return `${(tokens / 1e9).toFixed(1).replace(/\.0$/, '')}B`
    }
    if (tokens >= 1_000_000) {
        return `${(tokens / 1e6).toFixed(1).replace(/\.0$/, '')}M`
    }
    if (tokens >= 1_000) {
        return `${(tokens / 1e3).toFixed(1).replace(/\.0$/, '')}k`
    }
    return tokens.toLocaleString('en-US')
}

export function formatDuration(ms: number, _isZh?: boolean): string {
    if (!ms || ms <= 0 || isNaN(ms)) return '0s'
    const totalSec = Math.floor(ms / 1000)
    const hours = Math.floor(totalSec / 3600)
    const minutes = Math.floor((totalSec % 3600) / 60)
    const seconds = totalSec % 60

    if (hours > 0) {
        return `${hours}h ${minutes}m`
    }
    if (minutes > 0) {
        return `${minutes}m ${seconds}s`
    }
    return `${seconds}s`
}

export function formatStreak(
    days: number,
    tOrIsZh?: boolean | ((key: string, options?: any) => string),
): string {
    const count = Math.max(0, days || 0)
    if (typeof tOrIsZh === 'function') {
        return tOrIsZh(count === 1 ? 'settings.profile.streakDay' : 'settings.profile.streakDays', {
            count,
            defaultValue: `${count} ${count === 1 ? 'day' : 'days'}`,
        })
    }
    return `${count} ${count === 1 ? 'day' : 'days'}`
}

export function formatReasoningEffort(
    effort: { level: string; percentage: number } | null | undefined,
    tOrIsZh?: boolean | ((key: string, options?: any) => string),
    defaultNone = 'None',
): string {
    if (!effort || !effort.level) return defaultNone
    const raw = effort.level.toLowerCase().trim()
    let levelKey = 'settings.profile.reasoning.low'
    let defaultLevelName = 'Low'
    if (raw === 'medium') {
        levelKey = 'settings.profile.reasoning.medium'
        defaultLevelName = 'Medium'
    } else if (raw === 'high') {
        levelKey = 'settings.profile.reasoning.high'
        defaultLevelName = 'High'
    } else if (
        raw === 'very_high' ||
        raw === 'very high' ||
        raw === 'xhigh' ||
        raw === 'extreme'
    ) {
        levelKey = 'settings.profile.reasoning.veryHigh'
        defaultLevelName = 'Very High'
    }
    const levelName =
        typeof tOrIsZh === 'function'
            ? tOrIsZh(levelKey, { defaultValue: defaultLevelName })
            : defaultLevelName
    return `${levelName} · ${effort.percentage}%`
}

export function formatLocalDateKey(date: Date): string {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
}

const HEATMAP_COLORS = [
    'bg-[#1a1c22]',
    'bg-[#1e3a5f]',
    'bg-[#2563eb]',
    'bg-[#60a5fa]',
    'bg-[#93c5fd]',
]

const WEEKS_COUNT = 52
const DAYS_PER_WEEK = 7

export function buildHeatmapGrid(
    buckets: MetricBucket[],
    viewMode: ViewMode,
    isZh: boolean,
    t?: (key: string, options?: any) => string,
): { weeks: HeatmapCell[][]; monthLabels: string[] } {
    const bucketMap = new Map<string, { totalTokens: number; totalChats: number }>()
    for (const b of buckets) {
        if (b?.bucketKey) {
            bucketMap.set(b.bucketKey.trim(), {
                totalTokens: Number(b.metrics?.totalTokens) || 0,
                totalChats: Number(b.metrics?.totalChats) || 0,
            })
        }
    }

    const today = new Date()
    today.setHours(0, 0, 0, 0)

    // Align to Monday as the start of the week (0 = Monday, ..., 6 = Sunday)
    const dayOfWeek = today.getDay()
    const daysSinceMonday = (dayOfWeek + 6) % 7
    const totalDays = (WEEKS_COUNT - 1) * DAYS_PER_WEEK + (daysSinceMonday + 1)

    const startDate = new Date(today)
    startDate.setDate(today.getDate() - (totalDays - 1))

    interface RawDay {
        date: Date
        dateKey: string
        tokens: number
        chats: number
        isFuture: boolean
        weekIdx: number
        dayIdx: number
    }

    const rawDays: RawDay[] = []
    let maxDailyTokens = 0
    let maxDailyChats = 0

    for (let i = 0; i < totalDays; i++) {
        const d = new Date(startDate)
        d.setDate(startDate.getDate() + i)
        d.setHours(0, 0, 0, 0)
        const dateKey = formatLocalDateKey(d)
        const isFuture = d.getTime() > today.getTime()

        const data = bucketMap.get(dateKey)
        const tokens = isFuture ? 0 : (data?.totalTokens || 0)
        const chats = isFuture ? 0 : (data?.totalChats || 0)

        if (!isFuture) {
            if (tokens > maxDailyTokens) maxDailyTokens = tokens
            if (chats > maxDailyChats) maxDailyChats = chats
        }

        rawDays.push({
            date: d,
            dateKey,
            tokens,
            chats,
            isFuture,
            weekIdx: Math.floor(i / DAYS_PER_WEEK),
            dayIdx: i % DAYS_PER_WEEK,
        })
    }

    // Weekly totals
    const weekTotals = new Map<number, { tokens: number; chats: number }>()
    for (const d of rawDays) {
        let wt = weekTotals.get(d.weekIdx)
        if (!wt) {
            wt = { tokens: 0, chats: 0 }
            weekTotals.set(d.weekIdx, wt)
        }
        wt.tokens += d.tokens
        wt.chats += d.chats
    }

    let maxWeeklyTokens = 0
    for (const wt of weekTotals.values()) {
        if (wt.tokens > maxWeeklyTokens) maxWeeklyTokens = wt.tokens
    }

    // Cumulative totals
    let runningTokens = 0
    let runningChats = 0
    const cumulativeDayMap = new Map<string, { cumulativeTokens: number; cumulativeChats: number }>()
    for (const d of rawDays) {
        if (!d.isFuture) {
            runningTokens += d.tokens
            runningChats += d.chats
        }
        cumulativeDayMap.set(d.dateKey, {
            cumulativeTokens: runningTokens,
            cumulativeChats: runningChats,
        })
    }
    const maxCumulativeTokens = runningTokens

    const weeks: HeatmapCell[][] = []
    let currentWeek: HeatmapCell[] = []

    for (let i = 0; i < rawDays.length; i++) {
        const item = rawDays[i]
        const { date, dateKey, tokens, chats, isFuture, weekIdx, dayIdx } = item

        const dateStr = date.toLocaleDateString(isZh ? 'zh-CN' : 'en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
        })

        let level = 0
        let tooltip = ''

        if (isFuture) {
            level = 0
            tooltip = ''
        } else if (viewMode === 'daily') {
            if (tokens > 0) {
                if (maxDailyTokens <= 0) level = 1
                else {
                    const ratio = tokens / maxDailyTokens
                    if (ratio >= 0.75) level = 4
                    else if (ratio >= 0.5) level = 3
                    else if (ratio >= 0.25) level = 2
                    else level = 1
                }
            }
            tooltip = t
                ? t('settings.profile.tooltipDaily', {
                      date: dateStr,
                      tokens: formatTokenCount(tokens, isZh),
                      chats,
                      defaultValue: `${dateStr} · ${formatTokenCount(tokens, isZh)} tokens · ${chats} ${
                          chats === 1 ? 'chat' : 'chats'
                      }`,
                  })
                : `${dateStr} · ${formatTokenCount(tokens, isZh)} tokens · ${chats} ${
                      chats === 1 ? 'chat' : 'chats'
                  }`
        } else if (viewMode === 'weekly') {
            const wt = weekTotals.get(weekIdx)
            const wTokens = wt?.tokens || 0
            const wChats = wt?.chats || 0
            if (wTokens > 0) {
                if (maxWeeklyTokens <= 0) level = 1
                else {
                    const ratio = wTokens / maxWeeklyTokens
                    if (ratio >= 0.75) level = 4
                    else if (ratio >= 0.5) level = 3
                    else if (ratio >= 0.25) level = 2
                    else level = 1
                }
            }
            tooltip = t
                ? t('settings.profile.tooltipWeekly', {
                      date: dateStr,
                      tokens: formatTokenCount(wTokens, isZh),
                      chats: wChats,
                      defaultValue: `${dateStr} (Week: ${formatTokenCount(wTokens, false)} tokens · ${wChats} chats)`,
                  })
                : `${dateStr} (Week: ${formatTokenCount(wTokens, false)} tokens · ${wChats} chats)`
        } else {
            // cumulative
            const cum = cumulativeDayMap.get(dateKey)
            const cTokens = cum?.cumulativeTokens || 0
            const cChats = cum?.cumulativeChats || 0
            if (cTokens > 0) {
                if (maxCumulativeTokens <= 0) level = 1
                else {
                    const ratio = cTokens / maxCumulativeTokens
                    if (ratio >= 0.75) level = 4
                    else if (ratio >= 0.5) level = 3
                    else if (ratio >= 0.25) level = 2
                    else level = 1
                }
            }
            tooltip = t
                ? t('settings.profile.tooltipCumulative', {
                      date: dateStr,
                      tokens: formatTokenCount(cTokens, isZh),
                      chats: cChats,
                      defaultValue: `Through ${dateStr} · Cum. ${formatTokenCount(cTokens, false)} tokens · ${cChats} chats`,
                  })
                : `Through ${dateStr} · Cum. ${formatTokenCount(cTokens, false)} tokens · ${cChats} chats`
        }

        currentWeek.push({
            dateKey,
            tokens,
            chats,
            level,
            isFuture,
            weekIndex: weekIdx,
            dayIndex: dayIdx,
            tooltip,
        })

        if (currentWeek.length === DAYS_PER_WEEK) {
            weeks.push(currentWeek)
            currentWeek = []
        }
    }

    if (currentWeek.length > 0) {
        while (currentWeek.length < DAYS_PER_WEEK) {
            currentWeek.push({
                dateKey: '',
                tokens: 0,
                chats: 0,
                level: 0,
                isFuture: true,
                weekIndex: weeks.length,
                dayIndex: currentWeek.length,
                tooltip: '',
            })
        }
        weeks.push(currentWeek)
    }

    const monthLabels: string[] = []
    let lastMonth = -1
    for (let w = 0; w < weeks.length; w++) {
        const firstDayOfWeek = weeks[w]?.[0]
        if (!firstDayOfWeek || !firstDayOfWeek.dateKey) {
            monthLabels.push('')
            continue
        }
        const [y, m, d] = firstDayOfWeek.dateKey.split('-').map(Number)
        if (!y || !m || !d) {
            monthLabels.push('')
            continue
        }
        const dateObj = new Date(y, m - 1, d)
        const monthIndex = dateObj.getMonth()
        if (monthIndex !== lastMonth) {
            const mName = dateObj.toLocaleDateString(isZh ? 'zh-CN' : 'en-US', {
                month: 'short',
            })
            monthLabels.push(mName)
            lastMonth = monthIndex
        } else {
            monthLabels.push('')
        }
    }

    return { weeks, monthLabels }
}

export function UsageStatsSection() {
    const { t, i18n } = useTranslation()
    const services = useHostServices()
    const isZh = (i18n.language || '').toLowerCase().startsWith('zh')

    const [viewMode, setViewMode] = useState<ViewMode>('daily')
    const [summary, setSummary] = useState<MetricSummary | null>(null)
    const [buckets, setBuckets] = useState<MetricBucket[]>([])
    const [, setLoading] = useState<boolean>(true)
    const [hoveredCell, setHoveredCell] = useState<HeatmapCell | null>(null)

    useEffect(() => {
        let isMounted = true

        const fetchMetrics = async () => {
            if (!services?.sessionMetrics?.queryMetrics) {
                if (isMounted) setLoading(false)
                return
            }

            try {
                const res = await services.sessionMetrics.queryMetrics({
                    timeGranularity: 'day',
                    topSkillsLimit: 10,
                    topModelsLimit: 10,
                })

                if (isMounted && res) {
                    setSummary(res.summary ?? null)
                    setBuckets((res.buckets as MetricBucket[]) ?? [])
                }
            } catch (err) {
                console.error('Failed to query session metrics:', err)
            } finally {
                if (isMounted) setLoading(false)
            }
        }

        void fetchMetrics()

        return () => {
            isMounted = false
        }
    }, [services?.sessionMetrics])

    const totalTokens = summary?.totalTokens || 0
    const peakTokens = useMemo(() => {
        if (!buckets || buckets.length === 0) return 0
        return Math.max(...buckets.map((b) => b.metrics?.totalTokens || 0), 0)
    }, [buckets])

    const longestChatDurationMs = summary?.maxTaskDurationMs || 0
    const currentStreak = summary?.currentStreakDays || 0
    const longestStreak = summary?.longestStreakDays || 0

    const fastModePercentage = summary?.fastMode?.percentage || 0
    const topReasoningEffort = summary?.topReasoningEffort || null
    const exploredSkills = summary?.uniqueSkillsCount || 0
    const totalSkillsUsed = summary?.totalSkillInvocations || 0
    const totalChats = summary?.totalChats || 0
    const topSkills = summary?.topSkills || []
    const topModels = summary?.topModels || []

    const { weeks: heatmapWeeks, monthLabels } = useMemo(
        () => buildHeatmapGrid(buckets, viewMode, isZh, t),
        [buckets, viewMode, isZh, t],
    )

    const heatmapSummary = useMemo(() => {
        let activeDays = 0
        let totalT = 0
        let totalC = 0
        let peakT = 0
        const activeWeeksSet = new Set<number>()
        const weekTokenMap = new Map<number, number>()

        for (const week of heatmapWeeks) {
            for (const cell of week) {
                if (!cell.isFuture && cell.tokens > 0) {
                    activeDays += 1
                    totalT += cell.tokens
                    totalC += cell.chats
                    if (cell.tokens > peakT) peakT = cell.tokens
                    activeWeeksSet.add(cell.weekIndex)
                    weekTokenMap.set(cell.weekIndex, (weekTokenMap.get(cell.weekIndex) || 0) + cell.tokens)
                }
            }
        }

        let peakW = 0
        for (const tokens of weekTokenMap.values()) {
            if (tokens > peakW) peakW = tokens
        }

        return {
            activeDays,
            activeWeeks: activeWeeksSet.size,
            totalTokens: totalT,
            totalChats: totalC,
            peakTokens: peakT,
            peakWeeklyTokens: peakW,
        }
    }, [heatmapWeeks])

    return (
        <div className="flex w-full flex-col">
            <div className="mx-auto flex w-full max-w-[760px] flex-col px-8 pt-8 pb-16">
                <h1 className="text-[22px] font-semibold tracking-tight text-[var(--text-primary)] font-[inherit]">
                    {t('settings.nav.usage', 'Usage & Billing')}
                </h1>

                {/* 5-Column Stats Summary Card */}
                <div className="mt-7 w-full rounded-2xl border border-[var(--border-subtle)] bg-[rgba(255,255,255,0.015)] p-4 sm:p-5">
                    <div className="grid grid-cols-5 divide-x divide-[var(--border-subtle)]">
                        <div className="flex flex-col items-center px-1 text-center">
                            <span className="text-[17px] font-semibold text-[var(--text-primary)] sm:text-[19px]">
                                {formatTokenCount(totalTokens, isZh)}
                            </span>
                            <span className="mt-1 text-[12px] text-[var(--text-muted)] font-[inherit]">
                                {t('settings.profile.totalTokens', 'Total Tokens')}
                            </span>
                        </div>

                        <div className="flex flex-col items-center px-1 text-center">
                            <span className="text-[17px] font-semibold text-[var(--text-primary)] sm:text-[19px]">
                                {formatTokenCount(peakTokens, isZh)}
                            </span>
                            <span className="mt-1 text-[12px] text-[var(--text-muted)] font-[inherit]">
                                {t('settings.profile.peakTokens', 'Peak Daily Tokens')}
                            </span>
                        </div>

                        <div className="flex flex-col items-center px-1 text-center">
                            <span className="text-[17px] font-semibold text-[var(--text-primary)] sm:text-[19px]">
                                {formatDuration(longestChatDurationMs, isZh)}
                            </span>
                            <span className="mt-1 text-[12px] text-[var(--text-muted)] font-[inherit]">
                                {t('settings.profile.longestChatDuration', 'Longest Single Task')}
                            </span>
                        </div>

                        <div className="flex flex-col items-center px-1 text-center">
                            <span className="text-[17px] font-semibold text-[var(--text-primary)] sm:text-[19px]">
                                {formatStreak(currentStreak, t)}
                            </span>
                            <span className="mt-1 text-[12px] text-[var(--text-muted)] font-[inherit]">
                                {t('settings.profile.currentStreak', 'Current Streak')}
                            </span>
                        </div>

                        <div className="flex flex-col items-center px-1 text-center">
                            <span className="text-[17px] font-semibold text-[var(--text-primary)] sm:text-[19px]">
                                {formatStreak(longestStreak, t)}
                            </span>
                            <span className="mt-1 text-[12px] text-[var(--text-muted)] font-[inherit]">
                                {t('settings.profile.longestStreak', 'Longest Streak')}
                            </span>
                        </div>
                    </div>
                </div>

                {/* Token Activity Section */}
                <div className="mt-8 w-full">
                    <div className="mb-3.5 flex items-center justify-between">
                        <h3 className="text-[13px] font-medium text-[var(--text-primary)] font-[inherit]">
                            {t('settings.profile.tokenActivity', 'Token Activity')}
                        </h3>

                        <div className="flex items-center gap-3.5 text-[12px]">
                            <button
                                type="button"
                                className={cn(
                                    'transition-colors cursor-pointer font-[inherit]',
                                    viewMode === 'daily'
                                        ? 'font-medium text-[var(--text-primary)]'
                                        : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]',
                                )}
                                onClick={() => setViewMode('daily')}
                            >
                                {t('settings.profile.daily', 'Daily')}
                            </button>

                            <button
                                type="button"
                                className={cn(
                                    'transition-colors cursor-pointer font-[inherit]',
                                    viewMode === 'weekly'
                                        ? 'font-medium text-[var(--text-primary)]'
                                        : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]',
                                )}
                                onClick={() => setViewMode('weekly')}
                            >
                                {t('settings.profile.weekly', 'Weekly')}
                            </button>

                            <button
                                type="button"
                                className={cn(
                                    'transition-colors cursor-pointer font-[inherit]',
                                    viewMode === 'cumulative'
                                        ? 'font-medium text-[var(--text-primary)]'
                                        : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]',
                                )}
                                onClick={() => setViewMode('cumulative')}
                            >
                                {t('settings.profile.cumulative', 'Cumulative')}
                            </button>
                        </div>
                    </div>

                    {/* Heatmap Card */}
                    <div className="w-full overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-[rgba(255,255,255,0.015)] p-4 sm:p-5">
                        <div className="w-full">
                            {/* Real-time Hovered Cell or View Summary */}
                            <div className="mb-3 flex items-center justify-between text-[12px] h-5">
                                {hoveredCell && hoveredCell.tooltip ? (
                                    <div className="flex items-center gap-2 font-[inherit] text-[var(--text-primary)]">
                                        <span className="size-2 rounded-full bg-[var(--accent-blue)] shrink-0" />
                                        <span className="font-medium">{hoveredCell.tooltip}</span>
                                    </div>
                                ) : (
                                    <div className="flex items-center gap-3 text-[var(--text-muted)] font-[inherit]">
                                        <span>
                                            {viewMode === 'daily'
                                                ? t('settings.profile.activeDays', {
                                                      count: heatmapSummary.activeDays,
                                                      defaultValue: `Active days: ${heatmapSummary.activeDays}`,
                                                  })
                                                : viewMode === 'weekly'
                                                  ? t('settings.profile.activeWeeks', {
                                                        count: heatmapSummary.activeWeeks,
                                                        defaultValue: `Active weeks: ${heatmapSummary.activeWeeks}`,
                                                    })
                                                  : t('settings.profile.totalTokensCount', {
                                                        tokens: formatTokenCount(heatmapSummary.totalTokens, isZh),
                                                        defaultValue: `Total tokens: ${formatTokenCount(heatmapSummary.totalTokens, false)}`,
                                                    })}
                                        </span>
                                        <span className="opacity-40">·</span>
                                        <span>
                                            {viewMode === 'daily'
                                                ? t('settings.profile.peakDay', {
                                                      tokens: formatTokenCount(heatmapSummary.peakTokens, isZh),
                                                      defaultValue: `Peak day: ${formatTokenCount(heatmapSummary.peakTokens, false)} tokens`,
                                                  })
                                                : viewMode === 'weekly'
                                                  ? t('settings.profile.peakWeek', {
                                                        tokens: formatTokenCount(heatmapSummary.peakWeeklyTokens, isZh),
                                                        defaultValue: `Peak week: ${formatTokenCount(heatmapSummary.peakWeeklyTokens, false)} tokens`,
                                                    })
                                                  : t('settings.profile.totalChatsCount', {
                                                        count: heatmapSummary.totalChats,
                                                        defaultValue: `Total chats: ${heatmapSummary.totalChats}`,
                                                    })}
                                        </span>
                                    </div>
                                )}
                            </div>

                            {/* Month Labels aligned to 52 columns */}
                            <div className="flex w-full items-start gap-1.5 sm:gap-2 mb-1.5 h-3.5">
                                <div className="shrink-0 w-5 sm:w-6" />
                                <div className="flex flex-1 items-stretch gap-[2px] sm:gap-[2.5px] w-full min-w-0">
                                    {heatmapWeeks.map((_, wIdx) => {
                                        const label = monthLabels[wIdx]
                                        return (
                                            <div key={wIdx} className="flex-1 min-w-0 relative">
                                                {label ? (
                                                    <span className="absolute left-0 top-0 text-[10px] text-[var(--text-muted)] select-none whitespace-nowrap">
                                                        {label}
                                                    </span>
                                                ) : null}
                                            </div>
                                        )
                                    })}
                                </div>
                            </div>

                            {/* Heatmap Grid (7 rows x 52 columns, 100% responsive without horizontal scrollbar) */}
                            <div className="flex w-full items-stretch gap-1.5 sm:gap-2">
                                <div className="flex flex-col shrink-0 w-5 sm:w-6 text-[9px] sm:text-[10px] text-[var(--text-muted)] select-none gap-[2px] sm:gap-[2.5px]">
                                    <div className="flex-1 min-h-0 flex items-center">
                                        <span className="leading-none">{t('settings.profile.weekday.mon', 'Mon')}</span>
                                    </div>
                                    <div className="flex-1 min-h-0 flex items-center" aria-hidden="true" />
                                    <div className="flex-1 min-h-0 flex items-center">
                                        <span className="leading-none">{t('settings.profile.weekday.wed', 'Wed')}</span>
                                    </div>
                                    <div className="flex-1 min-h-0 flex items-center" aria-hidden="true" />
                                    <div className="flex-1 min-h-0 flex items-center">
                                        <span className="leading-none">{t('settings.profile.weekday.fri', 'Fri')}</span>
                                    </div>
                                    <div className="flex-1 min-h-0 flex items-center" aria-hidden="true" />
                                    <div className="flex-1 min-h-0 flex items-center">
                                        <span className="leading-none">{t('settings.profile.weekday.sun', 'Sun')}</span>
                                    </div>
                                </div>

                                <div className="flex flex-1 items-stretch gap-[2px] sm:gap-[2.5px] w-full min-w-0">
                                    {heatmapWeeks.map((week, wIdx) => (
                                        <div key={wIdx} className="flex flex-1 flex-col gap-[2px] sm:gap-[2.5px] min-w-0">
                                            {week.map((cell, cIdx) => (
                                                <div
                                                    key={`${cell.dateKey}-${cIdx}`}
                                                    title={cell.tooltip}
                                                    onMouseEnter={() => {
                                                        if (!cell.isFuture) {
                                                            setHoveredCell(cell)
                                                        }
                                                    }}
                                                    onMouseLeave={() => setHoveredCell(null)}
                                                    className={cn(
                                                        'w-full aspect-square rounded-[2px] transition-colors',
                                                        cell.isFuture
                                                            ? 'bg-[#15171c]'
                                                            : cn(
                                                                  HEATMAP_COLORS[cell.level],
                                                                  'cursor-pointer hover:ring-1 hover:ring-white/40',
                                                              ),
                                                    )}
                                                />
                                            ))}
                                        </div>
                                    ))}
                                </div>
                            </div>

                            <div className="mt-3 flex items-center justify-end gap-1.5 text-[11px] text-[var(--text-muted)]">
                                <span>{t('settings.profile.less', 'Less')}</span>
                                {HEATMAP_COLORS.map((c, i) => (
                                    <div
                                        key={i}
                                        className={cn('size-[9px] rounded-[2px]', c)}
                                    />
                                ))}
                                <span>{t('settings.profile.more', 'More')}</span>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Performance & Model Metrics Breakdown */}
                <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {/* Fast Mode & Reasoning Card */}
                    <div className="flex flex-col rounded-2xl border border-[var(--border-subtle)] bg-[rgba(255,255,255,0.015)] p-5">
                        <span className="text-[13px] font-medium text-[var(--text-primary)] font-[inherit]">
                            {t('settings.profile.inferenceSpeed', 'Inference & Speed')}
                        </span>
                        <div className="mt-4 flex flex-col space-y-3.5">
                            <div className="flex items-center justify-between text-[13px]">
                                <span className="text-[var(--text-secondary)] font-[inherit]">
                                    {t('settings.profile.fastMode', 'Fast mode')}
                                </span>
                                <span className="font-semibold text-[var(--text-primary)] font-mono">
                                    {fastModePercentage}%
                                </span>
                            </div>
                            <div className="flex items-center justify-between text-[13px]">
                                <span className="text-[var(--text-secondary)] font-[inherit]">
                                    {t('settings.profile.topReasoningEffort', 'Preferred Reasoning Effort')}
                                </span>
                                <span className="font-semibold text-[var(--text-primary)] font-[inherit]">
                                    {formatReasoningEffort(
                                        topReasoningEffort,
                                        t,
                                        t('common.none', 'None'),
                                    )}
                                </span>
                            </div>
                            <div className="flex items-center justify-between text-[13px]">
                                <span className="text-[var(--text-secondary)] font-[inherit]">
                                    {t('settings.profile.totalChats', 'Total Chats')}
                                </span>
                                <span className="font-semibold text-[var(--text-primary)] font-mono">
                                    {totalChats}
                                </span>
                            </div>
                        </div>
                    </div>

                    {/* Skill Activity Card */}
                    <div className="flex flex-col rounded-2xl border border-[var(--border-subtle)] bg-[rgba(255,255,255,0.015)] p-5">
                        <span className="text-[13px] font-medium text-[var(--text-primary)] font-[inherit]">
                            {t('settings.profile.skillUsage', 'Skill Usage')}
                        </span>
                        <div className="mt-4 flex flex-col space-y-3.5">
                            <div className="flex items-center justify-between text-[13px]">
                                <span className="text-[var(--text-secondary)] font-[inherit]">
                                    {t('settings.profile.exploredSkills', 'Skills Explored')}
                                </span>
                                <span className="font-semibold text-[var(--text-primary)] font-mono">
                                    {exploredSkills}
                                </span>
                            </div>
                            <div className="flex items-center justify-between text-[13px]">
                                <span className="text-[var(--text-secondary)] font-[inherit]">
                                    {t('settings.profile.totalSkillInvocations', 'Total Invocations')}
                                </span>
                                <span className="font-semibold text-[var(--text-primary)] font-mono">
                                    {totalSkillsUsed}
                                </span>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Top Skills Ranking List */}
                {topSkills.length > 0 ? (
                    <div className="mt-8">
                        <h3 className="mb-3 text-[13px] font-medium text-[var(--text-primary)] font-[inherit]">
                            {t('settings.profile.topSkills', 'Top Skills')}
                        </h3>
                        <div className="divide-y divide-[var(--border-subtle)] rounded-2xl border border-[var(--border-subtle)] bg-[rgba(255,255,255,0.015)] overflow-hidden">
                            {topSkills.map((item, idx) => (
                                <div
                                    key={item.name}
                                    className="flex items-center justify-between px-4 py-3 text-[13px]"
                                >
                                    <div className="flex items-center gap-3">
                                        <span className="w-4 text-center font-mono text-xs text-[var(--text-muted)]">
                                            {idx + 1}
                                        </span>
                                        <SkillIcon name={item.name} />
                                        <span className="font-medium text-[var(--text-primary)] font-mono">
                                            {formatSkillName(item.name)}
                                        </span>
                                    </div>
                                    <span className="font-mono text-xs text-[var(--text-muted)]">
                                        {item.count} {t('settings.profile.invocations', 'calls')}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </div>
                ) : null}

                {/* Top Models Ranking List */}
                {topModels.length > 0 ? (
                    <div className="mt-8">
                        <h3 className="mb-3 text-[13px] font-medium text-[var(--text-primary)] font-[inherit]">
                            {t('settings.profile.topModels', 'Top Models')}
                        </h3>
                        <div className="divide-y divide-[var(--border-subtle)] rounded-2xl border border-[var(--border-subtle)] bg-[rgba(255,255,255,0.015)] overflow-hidden">
                            {topModels.map((item, idx) => (
                                <div
                                    key={item.modelId}
                                    className="flex items-center justify-between px-4 py-3 text-[13px]"
                                >
                                    <div className="flex items-center gap-3">
                                        <span className="w-4 text-center font-mono text-xs text-[var(--text-muted)]">
                                            {idx + 1}
                                        </span>
                                        <ModelIcon modelId={item.modelId} />
                                        <span className="font-medium text-[var(--text-primary)] font-mono">
                                            {item.modelId}
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-4 text-xs font-mono text-[var(--text-muted)]">
                                        <span>
                                            {t('settings.profile.modelTokens', {
                                                tokens: formatTokenCount(item.totalTokens, isZh),
                                                defaultValue: `${formatTokenCount(item.totalTokens, isZh)} tokens`,
                                            })}
                                        </span>
                                        <span>{item.count} {t('settings.profile.chats', 'chats')}</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                ) : null}
            </div>
        </div>
    )
}
