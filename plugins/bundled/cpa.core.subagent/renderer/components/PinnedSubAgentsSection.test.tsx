import i18n from '@/i18n'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { SubAgentRecord } from '@cpa/plugin-api'
import { HostServicesProvider } from '@cpa/plugin-ui'
import { PinnedSubAgentsSection } from './PinnedSubAgentsSection.js'

function agent(overrides: Partial<SubAgentRecord> = {}): SubAgentRecord {
  return {
    id: 'ag-1',
    name: 'Kierkegaard',
    color: '#9b7dff',
    icon: 'sparkle',
    parentSessionId: 'sess-1',
    sessionId: 'ag-1',
    modelId: 'gpt-5.4',
    reasoningEffort: 'high',
    status: 'running',
    createdAt: Date.now() - 5_000,
    updatedAt: Date.now(),
    ...overrides,
  }
}

const EMPTY_AGENTS: readonly SubAgentRecord[] = Object.freeze([])
const EMPTY_MODELS = Object.freeze([])
const EMPTY_SETTINGS = Object.freeze({ reasoningLevel: 'high' })

function createServices(options?: {
  agents?: readonly SubAgentRecord[]
  models?: readonly any[]
  openTab?: (...args: any[]) => void
  openRightPanelTab?: (...args: any[]) => void
  setRightSidebarCollapsed?: (...args: any[]) => void
}) {
  const agents = options?.agents ?? EMPTY_AGENTS
  const models = options?.models ?? EMPTY_MODELS
  return {
    subAgents: {
      getAgents: () => agents,
      openTab: options?.openTab,
      subscribe: () => () => {},
    },
    models: {
      getModels: () => models,
    },
    settings: {
      getSnapshot: () => EMPTY_SETTINGS,
      subscribe: () => () => {},
    },
    chatMessages: {
      ensureSessionLoaded: vi.fn(),
      getEntries: () => [],
    },
    ui: {
      openRightPanelTab: options?.openRightPanelTab,
      setRightSidebarCollapsed: options?.setRightSidebarCollapsed,
    },
  }
}

describe('PinnedSubAgentsSection', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('renders avatar, model meta, and status details like legacy pinned summary', () => {
    const agents = Object.freeze([agent()])
    const models = Object.freeze([
      {
        id: 'gpt-5.4',
        label: 'GPT-5.4',
        provider: 'openai',
        reasoningLevels: [],
      },
    ])

    render(
      <HostServicesProvider services={createServices({ agents, models }) as any}>
        <PinnedSubAgentsSection sessionId="sess-1" />
      </HostServicesProvider>,
    )

    expect(screen.getByText('Subagents')).toBeInTheDocument()
    expect(screen.getByText('Kierkegaard')).toBeInTheDocument()
    expect(screen.getByTestId('subagent-list')).toBeInTheDocument()
    expect(screen.getByTestId('subagent-model-meta')).toHaveTextContent(/GPT-5\.4/)
    expect(screen.getByTestId('subagent-status')).toBeInTheDocument()
    // Avatar icon is rendered as an inline SVG inside the colored circle.
    expect(document.querySelector('svg')).toBeTruthy()
  })

  it('hides itself when the session has no sub-agents', () => {
    render(
      <HostServicesProvider services={createServices() as any}>
        <PinnedSubAgentsSection sessionId="sess-1" />
      </HostServicesProvider>,
    )

    expect(screen.queryByText('Subagents')).not.toBeInTheDocument()
    expect(screen.queryByTestId('subagent-list')).not.toBeInTheDocument()
  })

  it('opens the matching sub-agent tab and uncollapses the right sidebar on select', async () => {
    const mockOpenTab = vi.fn()
    const mockOpenRightPanelTab = vi.fn()
    const mockSetRightSidebarCollapsed = vi.fn()
    const agents = Object.freeze([agent()])

    render(
      <HostServicesProvider
        services={
          createServices({
            agents,
            openTab: mockOpenTab,
            openRightPanelTab: mockOpenRightPanelTab,
            setRightSidebarCollapsed: mockSetRightSidebarCollapsed,
          }) as any
        }
      >
        <PinnedSubAgentsSection sessionId="sess-1" />
      </HostServicesProvider>,
    )

    await userEvent.click(screen.getByText('Kierkegaard'))

    expect(mockOpenTab).toHaveBeenCalledWith('sess-1', 'ag-1')
    expect(mockOpenRightPanelTab).toHaveBeenCalledWith('subagent', { activate: true })
    expect(mockSetRightSidebarCollapsed).toHaveBeenCalledWith(false)
  })

  it('allows collapsing and expanding the section', async () => {
    const agents = Object.freeze([agent()])

    render(
      <HostServicesProvider services={createServices({ agents }) as any}>
        <PinnedSubAgentsSection sessionId="sess-1" />
      </HostServicesProvider>,
    )

    const header = screen.getByRole('button', { name: /Subagents/i })
    expect(header).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Kierkegaard')).toBeInTheDocument()

    await userEvent.click(header)
    expect(header).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Kierkegaard')).not.toBeInTheDocument()

    await userEvent.click(header)
    expect(header).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Kierkegaard')).toBeInTheDocument()
  })

  it('does not display scroll buttons when agents count <= 5', () => {
    const agents = Object.freeze(
      Array.from({ length: 5 }, (_, i) => agent({ id: `ag-${i + 1}`, name: `Agent ${i + 1}` })),
    )

    render(
      <HostServicesProvider services={createServices({ agents }) as any}>
        <PinnedSubAgentsSection sessionId="sess-1" />
      </HostServicesProvider>,
    )

    for (let i = 1; i <= 5; i++) {
      expect(screen.getByText(`Agent ${i}`)).toBeInTheDocument()
    }
    expect(screen.queryByTestId('subagent-scroll-up')).not.toBeInTheDocument()
    expect(screen.queryByTestId('subagent-scroll-down')).not.toBeInTheDocument()
  })

  it('renders all agents and scroll buttons when agents count > 5, allowing scroll on click', async () => {
    const agents = Object.freeze(
      Array.from({ length: 8 }, (_, i) => agent({ id: `ag-${i + 1}`, name: `Agent ${i + 1}` })),
    )

    render(
      <HostServicesProvider services={createServices({ agents }) as any}>
        <PinnedSubAgentsSection sessionId="sess-1" />
      </HostServicesProvider>,
    )

    for (let i = 1; i <= 8; i++) {
      expect(screen.getByText(`Agent ${i}`)).toBeInTheDocument()
    }

    const upButton = screen.getByTestId('subagent-scroll-up')
    const downButton = screen.getByTestId('subagent-scroll-down')
    expect(upButton).toBeInTheDocument()
    expect(downButton).toBeInTheDocument()

    expect(upButton).toBeDisabled()
    expect(downButton).not.toBeDisabled()

    await userEvent.click(downButton)
  })
})
