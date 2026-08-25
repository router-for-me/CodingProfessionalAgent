import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import type { SubAgentRecord } from '@cpa/plugin-api'
import { HostServicesProvider } from '@cpa/plugin-ui'
import { SubAgentTabHeaders } from './SubAgentTabHeaders.js'

const EMPTY_AGENTS: readonly SubAgentRecord[] = Object.freeze([])
const EMPTY_TAB_IDS: readonly string[] = Object.freeze([])

function createAgent(patch: Partial<SubAgentRecord> = {}): SubAgentRecord {
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

describe('SubAgentTabHeaders', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('renders null when there are no subagents', () => {
    const mockUiSnapshot = { rightPanelActiveTab: null }
    const mockServices = {
      subAgents: {
        getAgents: () => EMPTY_AGENTS,
        getOpenTabIds: () => EMPTY_TAB_IDS,
        getFocusedId: () => null,
      },
      ui: {
        getSnapshot: () => mockUiSnapshot,
      },
    }

    const { container } = render(
      <HostServicesProvider services={mockServices as any}>
        <SubAgentTabHeaders sessionId="sess-1" />
      </HostServicesProvider>,
    )

    expect(container.firstChild).toBeNull()
  })

  it('renders default button with non-deforming shrink-0 and whitespace-nowrap classes when agents exist but no tabs are open', async () => {
    const mockOpenRightPanelTab = vi.fn()
    const agentsList: readonly SubAgentRecord[] = [createAgent()]
    const mockUiSnapshot = { rightPanelActiveTab: 'selection' }
    const mockServices = {
      subAgents: {
        getAgents: () => agentsList,
        getOpenTabIds: () => EMPTY_TAB_IDS,
        getFocusedId: () => null,
      },
      ui: {
        getSnapshot: () => mockUiSnapshot,
        openRightPanelTab: mockOpenRightPanelTab,
      },
    }

    render(
      <HostServicesProvider services={mockServices as any}>
        <SubAgentTabHeaders sessionId="sess-1" />
      </HostServicesProvider>,
    )

    const button = screen.getByRole('button', { name: /SubAgents|Sub-agents|Subagents/i })
    expect(button).toBeInTheDocument()
    expect(button.className).toContain('shrink-0')
    expect(button.className).toContain('whitespace-nowrap')
    expect(button.className).toContain('h-7')

    await userEvent.click(button)
    expect(mockOpenRightPanelTab).toHaveBeenCalledWith('subagent', { activate: true })
  })

  it('renders open tabs with shrink-0 and truncated names when tabs are open', async () => {
    const mockFocusTab = vi.fn()
    const mockCloseTab = vi.fn()
    const mockOpenRightPanelTab = vi.fn()

    const agent1 = createAgent({ id: 'ag-1', name: 'Agent 1' })
    const agent2 = createAgent({ id: 'ag-2', name: 'Agent 2' })
    const agentsList: readonly SubAgentRecord[] = [agent1, agent2]
    const openTabIdsList: readonly string[] = ['ag-1', 'ag-2']
    const mockUiSnapshot = { rightPanelActiveTab: 'subagent' }

    const mockServices = {
      subAgents: {
        getAgents: () => agentsList,
        getOpenTabIds: () => openTabIdsList,
        getFocusedId: () => 'ag-1',
        focusTab: mockFocusTab,
        closeTab: mockCloseTab,
      },
      ui: {
        getSnapshot: () => mockUiSnapshot,
        openRightPanelTab: mockOpenRightPanelTab,
      },
    }

    render(
      <HostServicesProvider services={mockServices as any}>
        <SubAgentTabHeaders sessionId="sess-1" />
      </HostServicesProvider>,
    )

    expect(screen.getByText('Agent 1')).toBeInTheDocument()
    expect(screen.getByText('Agent 2')).toBeInTheDocument()

    const tabButtons = screen.getAllByRole('button')
    const agent1Button = tabButtons.find((btn) => btn.textContent?.includes('Agent 1'))
    expect(agent1Button).toBeDefined()
    expect(agent1Button?.className).toContain('shrink-0')
    expect(agent1Button?.className).toContain('h-7')

    await userEvent.click(screen.getByText('Agent 2'))
    expect(mockOpenRightPanelTab).toHaveBeenCalledWith('subagent', { activate: true })
    expect(mockFocusTab).toHaveBeenCalledWith('sess-1', 'ag-2')

    const closeBtn = screen.getByLabelText(/Agent 1/i)
    await userEvent.click(closeBtn)
    expect(mockCloseTab).toHaveBeenCalledWith('sess-1', 'ag-1')
  })
})
