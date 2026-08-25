import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import * as fs from 'node:fs'
import * as path from 'node:path'
import i18n from '@/i18n'
import { HostServicesProvider } from '@cpa/plugin-ui'
import {
    UsageStatsSection,
    ModelIcon,
    formatTokenCount,
    formatDuration,
    formatStreak,
    formatReasoningEffort,
    formatSkillName,
    formatLocalDateKey,
    buildHeatmapGrid,
} from './UsageStatsSection.js'

describe('UsageStatsSection helpers', () => {
    describe('formatTokenCount', () => {
        it('formats zero or invalid tokens', () => {
            expect(formatTokenCount(0, true)).toBe('0')
            expect(formatTokenCount(-5, false)).toBe('0')
            expect(formatTokenCount(NaN, true)).toBe('0')
        })

        it('formats large numbers into standard units', () => {
            expect(formatTokenCount(497_000_000_000, true)).toBe('497B')
            expect(formatTokenCount(2_560_000_000, true)).toBe('2.6B')
            expect(formatTokenCount(125_000, true)).toBe('125k')
            expect(formatTokenCount(8_500, true)).toBe('8.5k')
        })

        it('formats Western units (B, M, k, standard)', () => {
            expect(formatTokenCount(49_700_000_000, false)).toBe('49.7B')
            expect(formatTokenCount(2_500_000, false)).toBe('2.5M')
            expect(formatTokenCount(12_500, false)).toBe('12.5k')
            expect(formatTokenCount(850, false)).toBe('850')
        })
    })

    describe('formatDuration', () => {
        it('formats zero or negative durations', () => {
            expect(formatDuration(0, true)).toBe('0s')
            expect(formatDuration(0, false)).toBe('0s')
            expect(formatDuration(-100, true)).toBe('0s')
        })

        it('formats hours, minutes, seconds in Chinese and English', () => {
            const ms = (3 * 3600 + 6 * 60 + 12) * 1000
            expect(formatDuration(ms, true)).toBe('3h 6m')
            expect(formatDuration(ms, false)).toBe('3h 6m')

            const msMin = (5 * 60 + 30) * 1000
            expect(formatDuration(msMin, true)).toBe('5m 30s')
            expect(formatDuration(msMin, false)).toBe('5m 30s')

            const msSec = 45 * 1000
            expect(formatDuration(msSec, true)).toBe('45s')
            expect(formatDuration(msSec, false)).toBe('45s')
        })
    })

    describe('formatStreak', () => {
        it('formats day streaks', () => {
            expect(formatStreak(0, false)).toBe('0 days')
            expect(formatStreak(1, false)).toBe('1 day')
            expect(formatStreak(164, false)).toBe('164 days')
            expect(formatStreak(164, (k, opt) => i18n.t(k, { ...opt, lng: 'zh-CN' }))).not.toBe('164 days')
        })
    })

    describe('formatReasoningEffort', () => {
        it('handles null / empty values', () => {
            expect(formatReasoningEffort(null, false, 'None')).toBe('None')
            expect(formatReasoningEffort(undefined, false, 'None')).toBe('None')
        })

        it('translates and formats reasoning effort levels', () => {
            expect(formatReasoningEffort({ level: 'low', percentage: 15 }, false, 'None')).toBe('Low · 15%')
            expect(formatReasoningEffort({ level: 'medium', percentage: 25 }, false, 'None')).toBe('Medium · 25%')
            expect(formatReasoningEffort({ level: 'high', percentage: 40 }, false, 'None')).toBe('High · 40%')
            expect(formatReasoningEffort({ level: 'very_high', percentage: 37 }, false, 'None')).toBe('Very High · 37%')
            expect(formatReasoningEffort({ level: 'xhigh', percentage: 50 }, false, 'None')).toBe('Very High · 50%')
            expect(formatReasoningEffort({ level: 'low', percentage: 15 }, (k, opt) => i18n.t(k, { ...opt, lng: 'zh-CN' }), 'None')).not.toBe('Low · 15%')
        })
    })

    describe('formatSkillName', () => {
        it('adds $ prefix if none exists', () => {
            expect(formatSkillName('gh-issue')).toBe('$gh-issue')
            expect(formatSkillName('$gh-issue')).toBe('$gh-issue')
            expect(formatSkillName('@superpowers')).toBe('@superpowers')
        })
    })

    describe('formatLocalDateKey', () => {
        it('formats local date into YYYY-MM-DD string regardless of UTC offset', () => {
            const date = new Date(2026, 8, 7) // Month is 0-indexed: 8 = September
            expect(formatLocalDateKey(date)).toBe('2026-09-07')
        })
    })

    describe('buildHeatmapGrid', () => {
        it('builds 52 weeks of 7 days each and calculates levels for daily, weekly, cumulative modes', () => {
            const today = new Date()
            const todayKey = formatLocalDateKey(today)

            const mockBuckets = [
                { bucketKey: todayKey, metrics: { totalTokens: 10000, totalChats: 5 } },
            ]

            const dailyGrid = buildHeatmapGrid(mockBuckets, 'daily', true)
            expect(dailyGrid.weeks).toHaveLength(52)
            expect(dailyGrid.weeks[0]).toHaveLength(7)
            expect(dailyGrid.monthLabels.length).toBeGreaterThan(0)

            // Verify today's cell is accurately found and matched
            const activeDailyCell = dailyGrid.weeks.flatMap((w) => w).find((c) => c.dateKey === todayKey)
            expect(activeDailyCell).toBeDefined()
            expect(activeDailyCell?.tokens).toBe(10000)
            expect(activeDailyCell?.level).toBe(4)

            const weeklyGrid = buildHeatmapGrid(mockBuckets, 'weekly', true)
            expect(weeklyGrid.weeks).toHaveLength(52)
            const activeWeeklyCell = weeklyGrid.weeks.flatMap((w) => w).find((c) => c.dateKey === todayKey)
            expect(activeWeeklyCell).toBeDefined()
            expect(activeWeeklyCell?.level).toBe(4)

            const cumGrid = buildHeatmapGrid(mockBuckets, 'cumulative', true)
            expect(cumGrid.weeks).toHaveLength(52)
            const activeCumCell = cumGrid.weeks.flatMap((w) => w).find((c) => c.dateKey === todayKey)
            expect(activeCumCell).toBeDefined()
            expect(activeCumCell?.level).toBe(4)
        })
    })
})

describe('UsageStatsSection Component', () => {
    let mockQueryMetrics: any
    let mockServices: any

    beforeEach(async () => {
        await i18n.changeLanguage('en')
        mockQueryMetrics = vi.fn().mockResolvedValue({
            summary: {
                totalTokens: 49700000000,
                totalCost: 12.34,
                maxTaskDurationMs: 11160000, // 3h 6m
                currentStreakDays: 164,
                longestStreakDays: 164,
                fastMode: { count: 23, percentage: 23 },
                topReasoningEffort: { level: 'very_high', count: 37, percentage: 37 },
                uniqueSkillsCount: 53,
                totalSkillInvocations: 1885,
                totalChats: 17789,
                topSkills: [
                    { name: '@superpowers', count: 598 },
                    { name: 'gh-issue', count: 412 },
                    { name: '@litepowers', count: 294 },
                    { name: 'gh-issue-all', count: 123 },
                    { name: 'browser', count: 103 },
                ],
                topModels: [
                    { modelId: 'gpt-4o', count: 1024, totalTokens: 35000000000, percentage: 57.6 },
                    { modelId: 'claude-3-7-sonnet', count: 512, totalTokens: 12000000000, percentage: 28.8 },
                    { modelId: 'deepseek-r1', count: 243, totalTokens: 2700000000, percentage: 13.6 },
                ],
            },
            buckets: [
                {
                    bucketKey: '2025-01-15',
                    metrics: { totalTokens: 2560000000, totalChats: 42 },
                },
            ],
        })

        mockServices = {
            sessionMetrics: {
                queryMetrics: mockQueryMetrics,
            },
            ui: {
                pushToast: vi.fn(),
            },
        }
    })

    it('renders and queries SQLite session metrics on mount', async () => {
        render(
            <HostServicesProvider services={mockServices}>
                <UsageStatsSection />
            </HostServicesProvider>,
        )

        expect(mockQueryMetrics).toHaveBeenCalledWith({
            timeGranularity: 'day',
            topSkillsLimit: 10,
            topModelsLimit: 10,
        })

        await waitFor(() => {
            expect(screen.getByText('49.7B')).toBeInTheDocument()
        })

        expect(screen.getByText('2.6B')).toBeInTheDocument()
        expect(screen.getByText('3h 6m')).toBeInTheDocument()
        expect(screen.getAllByText('164 days')).toHaveLength(2)

        // Activity Insights
        expect(screen.getByText('23%')).toBeInTheDocument()
        expect(screen.getByText('Very High · 37%')).toBeInTheDocument()
        expect(screen.getByText('53')).toBeInTheDocument()
        expect(screen.getByText('1885')).toBeInTheDocument()
        expect(screen.getByText('17789')).toBeInTheDocument()

        // Most Used Skills
        expect(screen.getByText('@superpowers')).toBeInTheDocument()
        expect(screen.getByText('$gh-issue')).toBeInTheDocument()
        expect(screen.getByText('@litepowers')).toBeInTheDocument()
        expect(screen.getByText('$gh-issue-all')).toBeInTheDocument()
        expect(screen.getByText('$browser')).toBeInTheDocument()
        expect(screen.getByText(/598/)).toBeInTheDocument()

        // Most Used Models Leaderboard
        expect(screen.getByText(/Top Models/i)).toBeInTheDocument()
        expect(screen.getByText('gpt-4o')).toBeInTheDocument()
        expect(screen.getByText('claude-3-7-sonnet')).toBeInTheDocument()
        expect(screen.getByText('deepseek-r1')).toBeInTheDocument()
        expect(screen.getByText(/1024/)).toBeInTheDocument()
    })

    it('switches view mode between daily, weekly, and cumulative', async () => {
        render(
            <HostServicesProvider services={mockServices}>
                <UsageStatsSection />
            </HostServicesProvider>,
        )

        const weeklyBtn = screen.getByRole('button', { name: /Weekly/i })
        const cumulativeBtn = screen.getByRole('button', { name: /Cumulative/i })
        const dailyBtn = screen.getByRole('button', { name: /Daily/i })

        fireEvent.click(weeklyBtn)
        expect(weeklyBtn).toHaveClass('font-medium')

        fireEvent.click(cumulativeBtn)
        expect(cumulativeBtn).toHaveClass('font-medium')

        fireEvent.click(dailyBtn)
        expect(dailyBtn).toHaveClass('font-medium')
    })

    it('renders gracefully when no sessionMetrics service or empty statistics', async () => {
        render(
            <HostServicesProvider services={null}>
                <UsageStatsSection />
            </HostServicesProvider>,
        )

        expect(screen.getAllByText('0')).toHaveLength(5)
        expect(screen.getByText('0s')).toBeInTheDocument()
        expect(screen.getAllByText('0 days')).toHaveLength(2)
        expect(screen.getByText('0%')).toBeInTheDocument()
    })

    it('renders model icons correctly for different model families', () => {
        const { container: c1 } = render(<ModelIcon modelId="claude-3-7-sonnet" />)
        expect(c1.querySelector('svg')).toBeInTheDocument()

        const { container: c2 } = render(<ModelIcon modelId="gpt-4o" />)
        expect(c2.querySelector('svg')).toBeInTheDocument()

        const { container: c3 } = render(<ModelIcon modelId="deepseek-chat" />)
        expect(c3.querySelector('svg')).toBeInTheDocument()

        const { container: c4 } = render(<ModelIcon modelId="gemini-3.7-flash" />)
        expect(c4.querySelector('svg')).toBeInTheDocument()

        const { container: c5 } = render(<ModelIcon modelId="custom-llm" />)
        expect(c5.querySelector('svg')).toBeInTheDocument()
    })

    it('statically enforces zero window.electronBridge access across cpa.core.usage-stats', () => {
        const usagePluginDir = path.resolve(__dirname, '../../')
        const scanFiles = (dir: string): string[] => {
            const results: string[] = []
            for (const file of fs.readdirSync(dir)) {
                const fullPath = path.join(dir, file)
                if (fs.statSync(fullPath).isDirectory()) {
                    results.push(...scanFiles(fullPath))
                } else if (file.endsWith('.ts') || file.endsWith('.tsx')) {
                    results.push(fullPath)
                }
            }
            return results
        }

        const files = scanFiles(usagePluginDir)
        for (const file of files) {
            if (!file.endsWith('.test.ts') && !file.endsWith('.test.tsx')) {
                const content = fs.readFileSync(file, 'utf8')
                expect(content, `File ${file} should not access native bridge`).not.toContain('window.electronBridge')
            }
        }
    })
})
