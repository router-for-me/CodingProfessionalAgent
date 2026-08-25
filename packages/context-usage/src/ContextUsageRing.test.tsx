import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setDefaultHostServices } from '@cpa/plugin-ui'
import {
    computeContextUsageBreakdown,
    ContextUsageRing,
} from './index.js'

const mockEntriesBySession: Record<string, any[]> = {}
const mockSessions: any[] = []
let mockModelId = 'gpt-5-codex'
let mockModels: any[] = [
    {
        id: 'gpt-5-codex',
        label: 'GPT-5 CPA',
        contextWindow: 200_000,
    },
    {
        id: 'claude-3-7-sonnet',
        label: 'Claude 3.7 Sonnet',
        contextWindow: 200_000,
    },
]

const mockServices: any = {
    sessions: {
        getSnapshot: () => mockSessions,
        getCurrentSessionId: () => 's1',
    },
    settings: {
        getSnapshot: () => ({
            modelId: mockModelId,
            compactionThresholdPercent: 95,
        }),
    },
    models: {
        getModels: () => mockModels,
    },
    chatMessages: {
        getEntries: (sessionId: string) => mockEntriesBySession[sessionId] ?? [],
        ensureSessionLoaded: vi.fn(async () => {}),
        subscribeMessages: vi.fn(() => () => {}),
    },
}

describe('computeContextUsageBreakdown', () => {
    it('returns zeros and compaction window for empty conversation', () => {
        const breakdown = computeContextUsageBreakdown([], 200_000, 95)
        expect(breakdown).toEqual({
            totalTokens: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            compactionWindow: 190_000,
            contextWindow: 200_000,
            percentUsed: 0,
            percentLabel: '0%',
        })
    })

    it('computes breakdown from the latest assistant usage', () => {
        const assistant: any = {
            id: 'a1',
            sessionId: 's1',
            createdAt: 1000,
            kind: 'assistant',
            status: 'done',
            stopReason: 'stop',
            content: [{ type: 'text', text: 'hello' }],
            usage: {
                input: 1200,
                output: 300,
                cacheRead: 400,
                cacheWrite: 100,
                totalTokens: 2000,
            },
        }

        const breakdown = computeContextUsageBreakdown([assistant], 200_000)
        expect(breakdown.totalTokens).toBe(2000)
        expect(breakdown.inputTokens).toBe(1200)
        expect(breakdown.outputTokens).toBe(300)
        expect(breakdown.cacheReadTokens).toBe(400)
        expect(breakdown.cacheWriteTokens).toBe(100)
        expect(breakdown.contextWindow).toBe(200_000)
        expect(breakdown.percentUsed).toBe(1)
        expect(breakdown.percentLabel).toBe('1%')
    })

    it('adds trailing estimated tokens to input and total', () => {
        const assistant: any = {
            id: 'a1',
            sessionId: 's1',
            createdAt: 1000,
            kind: 'assistant',
            status: 'done',
            stopReason: 'stop',
            content: [{ type: 'text', text: 'hi' }],
            usage: {
                input: 1000,
                output: 200,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 1200,
            },
        }
        const trailingUser: any = {
            id: 'u2',
            sessionId: 's1',
            createdAt: 2000,
            kind: 'user',
            content: [{ type: 'text', text: 'x'.repeat(40) }], // ceil(40/4) = 10 tokens
        }

        const breakdown = computeContextUsageBreakdown(
            [assistant, trailingUser],
            100_000,
        )
        expect(breakdown.inputTokens).toBe(1010)
        expect(breakdown.totalTokens).toBe(1210)
    })

    it('formats <1% for tiny usage ratio', () => {
        const assistant: any = {
            id: 'a1',
            sessionId: 's1',
            createdAt: 1000,
            kind: 'assistant',
            status: 'done',
            stopReason: 'stop',
            content: [{ type: 'text', text: 'hi' }],
            usage: {
                input: 10,
                output: 5,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 15,
            },
        }

        const breakdown = computeContextUsageBreakdown([assistant], 200_000)
        expect(breakdown.percentUsed).toBeGreaterThan(0)
        expect(breakdown.percentUsed).toBeLessThan(1)
        expect(breakdown.percentLabel).toBe('<1%')
    })

    it('calculates custom compaction threshold correctly', () => {
        const breakdown = computeContextUsageBreakdown([], 100_000, 80)
        expect(breakdown.compactionWindow).toBe(80_000)
    })
})

describe('ContextUsageRing Component', () => {
    beforeEach(() => {
        setDefaultHostServices(mockServices)
        mockEntriesBySession['s1'] = []
        mockModelId = 'gpt-5-codex'
    })

    it('renders with default test id and aria label', () => {
        render(<ContextUsageRing sessionId="s1" />)
        const ring = screen.getByTestId('context-usage-ring')
        expect(ring).toBeInTheDocument()
        expect(ring).toHaveAttribute('role', 'button')
    })

    it('opens portal tooltip on mouse enter and closes on mouse leave', async () => {
        render(<ContextUsageRing sessionId="s1" />)
        const ring = screen.getByTestId('context-usage-ring')

        fireEvent.mouseEnter(ring)
        const tooltip = await screen.findByRole('tooltip')
        expect(tooltip).toBeInTheDocument()

        fireEvent.mouseLeave(ring)
        await vi.waitFor(() => {
            expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
        })
    })

    it('displays breakdown details including cache and compaction inside tooltip', async () => {
        mockEntriesBySession['s1'] = [
            {
                id: 'a1',
                sessionId: 's1',
                createdAt: 1000,
                kind: 'assistant',
                status: 'done',
                stopReason: 'stop',
                content: [{ type: 'text', text: 'hi' }],
                usage: {
                    input: 2500,
                    output: 500,
                    cacheRead: 1000,
                    cacheWrite: 200,
                    totalTokens: 4200,
                },
            },
        ]

        render(<ContextUsageRing sessionId="s1" />)
        const ring = screen.getByTestId('context-usage-ring')

        fireEvent.mouseEnter(ring)
        const tooltip = await screen.findByRole('tooltip')

        expect(tooltip).toHaveTextContent('2,500')
        expect(tooltip).toHaveTextContent('500')
        expect(tooltip).toHaveTextContent('1,000')
        expect(tooltip).toHaveTextContent('200')
    })

    it('respects agent prop for sub-agent session and model resolution', async () => {
        mockEntriesBySession['sub-agent-session'] = [
            {
                id: 'a2',
                sessionId: 'sub-agent-session',
                createdAt: 2000,
                kind: 'assistant',
                status: 'done',
                stopReason: 'stop',
                content: [{ type: 'text', text: 'subagent text' }],
                usage: {
                    input: 5000,
                    output: 1000,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 6000,
                },
            },
        ]

        const subAgent = {
            id: 'sub-agent-1',
            sessionId: 'sub-agent-session',
            modelId: 'claude-3-7-sonnet',
        }

        render(<ContextUsageRing agent={subAgent} />)
        const ring = screen.getByTestId('context-usage-ring')

        fireEvent.mouseEnter(ring)
        const tooltip = await screen.findByRole('tooltip')
        expect(tooltip).toHaveTextContent('6,000')
    })

    it('handles unknown model fallback to default context window', async () => {
        const subAgent = {
            id: 'sub-agent-2',
            sessionId: 'sub-agent-session-2',
            modelId: 'unknown-future-model',
        }
        render(<ContextUsageRing agent={subAgent} />)
        const ring = screen.getByTestId('context-usage-ring')

        fireEvent.mouseEnter(ring)
        const tooltip = await screen.findByRole('tooltip')
        expect(tooltip).toBeInTheDocument()
    })

    it('isolates new session (sessionId={null}) and does not display current/background session tokens', async () => {
        mockEntriesBySession['s1'] = [
            {
                id: 'a1',
                sessionId: 's1',
                createdAt: 1000,
                kind: 'assistant',
                status: 'done',
                stopReason: 'stop',
                content: [{ type: 'text', text: 'session 1 text' }],
                usage: {
                    input: 2500,
                    output: 500,
                    cacheRead: 1000,
                    cacheWrite: 200,
                    totalTokens: 4200,
                },
            },
        ]

        render(<ContextUsageRing sessionId={null as any} />)
        const ring = screen.getByTestId('context-usage-ring')

        fireEvent.mouseEnter(ring)
        const tooltip = await screen.findByRole('tooltip')

        expect(tooltip).toHaveTextContent('0%')
        expect(tooltip).not.toHaveTextContent('4,200')
    })

    it('hides the ring when showContextUsage is false in settings', () => {
        const originalGetSnapshot = mockServices.settings.getSnapshot
        mockServices.settings.getSnapshot = () => ({
            modelId: mockModelId,
            compactionThresholdPercent: 95,
            editor: { showContextUsage: false },
        })

        const { container } = render(<ContextUsageRing sessionId="s1" />)
        expect(screen.queryByTestId('context-usage-ring')).not.toBeInTheDocument()
        expect(container.firstChild).toBeNull()

        mockServices.settings.getSnapshot = originalGetSnapshot
    })

    it('forces rendering when forceShow is true even if showContextUsage is false', () => {
        const originalGetSnapshot = mockServices.settings.getSnapshot
        mockServices.settings.getSnapshot = () => ({
            modelId: mockModelId,
            compactionThresholdPercent: 95,
            editor: { showContextUsage: false },
        })

        render(<ContextUsageRing sessionId="s1" forceShow={true} />)
        expect(screen.getByTestId('context-usage-ring')).toBeInTheDocument()

        mockServices.settings.getSnapshot = originalGetSnapshot
    })
})
