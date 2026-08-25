import i18n from '@/i18n'
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { SubAgentRecord, ModelCatalogEntry } from '@cpa/plugin-api'
import { HostServicesProvider } from '@cpa/plugin-ui'
import { SubAgentList } from './SubAgentList.js'

function agent(
  patch: Partial<SubAgentRecord> = {},
): SubAgentRecord {
  return {
    id: 'ag-1',
    name: 'Kierkegaard',
    color: '#9b7dff',
    icon: 'sparkle',
    parentSessionId: 'sess-1',
    sessionId: 'ag-1',
    modelId: 'test-model-pro',
    reasoningEffort: 'medium',
    status: 'running',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...patch,
  }
}

const mockModels: readonly ModelCatalogEntry[] = [
  {
    id: 'test-model-pro',
    label: 'Test Model Pro',
    supportsFast: false,
    reasoningLevels: [],
    input: ['text'],
    contextWindow: 128_000,
    maxTokens: 16_384,
  },
]

const mockSettings = {
  locale: 'zh-CN',
  reasoningLevel: 'medium',
}

let mockServices: any

beforeEach(async () => {
    await i18n.changeLanguage('en')
  mockServices = {
    models: {
      getModels: () => mockModels,
    },
    settings: {
      getSnapshot: () => mockSettings,
    },
    chatMessages: {
      getEntries: () => [],
      ensureSessionLoaded: vi.fn(async () => {}),
    },
  }
})

afterEach(() => {
  vi.useRealTimers()
})

describe('SubAgentList elapsed status', () => {
  it('ticks elapsed time while running and freezes when completed', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const startedAt = Date.now()

    const { rerender } = render(
      <HostServicesProvider services={mockServices}>
        <SubAgentList
          agents={[agent({ createdAt: startedAt, updatedAt: startedAt })]}
          onSelect={() => undefined}
        />
      </HostServicesProvider>,
    )

    expect(screen.getByTestId('subagent-status')).toHaveTextContent(/running.*0/i)

    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(screen.getByTestId('subagent-status')).toHaveTextContent(/running.*5/i)

    rerender(
      <HostServicesProvider services={mockServices}>
        <SubAgentList
          agents={[
            agent({
              status: 'completed',
              createdAt: startedAt,
              updatedAt: startedAt + 5000,
            }),
          ]}
          onSelect={() => undefined}
        />
      </HostServicesProvider>,
    )
    expect(screen.getByTestId('subagent-status')).toHaveTextContent(/(?:done|completed).*5/i)

    act(() => {
      vi.advanceTimersByTime(8000)
    })
    expect(screen.getByTestId('subagent-status')).toHaveTextContent(/(?:done|completed).*5/i)
  })

  it('shows the catalog model label and reasoning after the name', () => {
    render(
      <HostServicesProvider services={mockServices}>
        <SubAgentList agents={[agent()]} onSelect={() => undefined} />
      </HostServicesProvider>,
    )

    expect(screen.getByText('Kierkegaard')).toBeInTheDocument()
    expect(screen.getByTestId('subagent-model-meta')).toHaveTextContent(
      /Test Model Pro/,
    )
    expect(screen.getByTestId('context-usage-ring')).toBeInTheDocument()
  })

  it('falls back to the model id when the catalog has no label', () => {
    render(
      <HostServicesProvider services={mockServices}>
        <SubAgentList
          agents={[agent({ modelId: 'unknown-model', reasoningEffort: undefined })]}
          onSelect={() => undefined}
        />
      </HostServicesProvider>,
    )

    expect(screen.getByTestId('subagent-model-meta')).toHaveTextContent(
      /^unknown-model$/,
    )
  })

  it('triggers ensureSessionLoaded for each agent on mount', () => {
    render(
      <HostServicesProvider services={mockServices}>
        <SubAgentList
          agents={[
            agent({ id: 'ag-1', sessionId: 'sess-ag-1' }),
            agent({ id: 'ag-2', sessionId: 'sess-ag-2' }),
          ]}
          onSelect={() => undefined}
        />
      </HostServicesProvider>,
    )

    expect(mockServices.chatMessages.ensureSessionLoaded).toHaveBeenCalledWith('sess-ag-1')
    expect(mockServices.chatMessages.ensureSessionLoaded).toHaveBeenCalledWith('sess-ag-2')
  })

  it('renders all agents without limit by default', () => {
    const testAgents = Array.from({ length: 8 }, (_, i) =>
      agent({ id: `ag-${i + 1}`, name: `Agent ${i + 1}` }),
    )

    render(
      <HostServicesProvider services={mockServices}>
        <SubAgentList agents={testAgents} onSelect={() => undefined} />
      </HostServicesProvider>,
    )

    for (let i = 1; i <= 8; i++) {
      expect(screen.getByText(`Agent ${i}`)).toBeInTheDocument()
    }
    expect(screen.queryByText(/show/i)).not.toBeInTheDocument()
  })

  it('limits visible agents without showing extra count when limit is specified', () => {
    const testAgents = Array.from({ length: 8 }, (_, i) =>
      agent({ id: `ag-${i + 1}`, name: `Agent ${i + 1}` }),
    )

    render(
      <HostServicesProvider services={mockServices}>
        <SubAgentList
          agents={testAgents}
          limit={5}
          onSelect={() => undefined}
        />
      </HostServicesProvider>,
    )

    for (let i = 1; i <= 5; i++) {
      expect(screen.getByText(`Agent ${i}`)).toBeInTheDocument()
    }
    expect(screen.queryByText('Agent 6')).not.toBeInTheDocument()
    expect(screen.queryByText('Agent 7')).not.toBeInTheDocument()
    expect(screen.queryByText('Agent 8')).not.toBeInTheDocument()
    expect(screen.queryByText(/show/i)).not.toBeInTheDocument()
  })

  it('deducts pausedMs so live time resumes smoothly instead of jumping back to dispatch time', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const startedAt = Date.now()

    vi.advanceTimersByTime(10000)
    vi.advanceTimersByTime(60000)

    const { rerender } = render(
      <HostServicesProvider services={mockServices}>
        <SubAgentList
          agents={[
            agent({
              status: 'running',
              createdAt: startedAt,
              updatedAt: startedAt + 70000,
              pausedMs: 60000,
            }),
          ]}
          onSelect={() => undefined}
        />
      </HostServicesProvider>,
    )

    expect(screen.getByTestId('subagent-status')).toHaveTextContent(/running.*10/i)

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(screen.getByTestId('subagent-status')).toHaveTextContent(/running.*11/i)

    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(screen.getByTestId('subagent-status')).toHaveTextContent(/running.*16/i)

    rerender(
      <HostServicesProvider services={mockServices}>
        <SubAgentList
          agents={[
            agent({
              status: 'completed',
              createdAt: startedAt,
              completedAt: startedAt + 76000,
              pausedMs: 60000,
            }),
          ]}
          onSelect={() => undefined}
        />
      </HostServicesProvider>,
    )
    expect(screen.getByTestId('subagent-status')).toHaveTextContent(/(?:done|completed).*16/i)
  })

  it('hides ContextUsageRing when showContextUsage is false in editor settings', () => {
    mockServices.settings = {
      getSnapshot: () => ({
        ...mockSettings,
        editor: { showContextUsage: false },
      }),
    }

    render(
      <HostServicesProvider services={mockServices}>
        <SubAgentList
          agents={[agent()]}
          onSelect={() => undefined}
        />
      </HostServicesProvider>,
    )

    expect(screen.queryByTestId('context-usage-ring')).not.toBeInTheDocument()
  })
})
