import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import type { SubAgentRecord } from '@cpa/plugin-api'
import { HostServicesProvider } from '@cpa/plugin-ui'
import { SubAgentPills } from './SubAgentPills.js'

const EMPTY_AGENTS: readonly SubAgentRecord[] = []

describe('SubAgentPills', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('opens the matching sub-agent tab and uncollapses right sidebar when a pill is clicked', async () => {
    const mockOpenTab = vi.fn()
    const mockOpenRightPanelTab = vi.fn()
    const mockSetRightSidebarCollapsed = vi.fn()

    const mockAgents: readonly SubAgentRecord[] = [
      {
        id: 'ag-1',
        name: 'Kierkegaard',
        color: '#9b7dff',
        icon: 'sparkle',
        parentSessionId: 'sess-1',
        sessionId: 'ag-1',
        modelId: 'm',
        status: 'running',
        createdAt: 1,
        updatedAt: 1,
        parentToolCallId: 'call-1',
      },
    ]

    const mockServices = {
      subAgents: {
        getAgents: () => mockAgents,
        openTab: mockOpenTab,
      },
      ui: {
        openRightPanelTab: mockOpenRightPanelTab,
        setRightSidebarCollapsed: mockSetRightSidebarCollapsed,
      },
    }

    render(
      <HostServicesProvider services={mockServices as any}>
        <SubAgentPills
          parentSessionId="sess-1"
          parts={[
            {
              id: 'call-1',
              name: 'spawn_agent',
              args: { prompt: 'solve' },
              status: 'running',
            },
          ]}
        />
      </HostServicesProvider>,
    )

    expect(screen.getByText('Kierkegaard')).toBeInTheDocument()
    await userEvent.click(screen.getByText('Kierkegaard'))

    expect(mockOpenTab).toHaveBeenCalledWith('sess-1', 'ag-1')
    expect(mockOpenRightPanelTab).toHaveBeenCalledWith('subagent', { activate: true })
    expect(mockSetRightSidebarCollapsed).toHaveBeenCalledWith(false)
  })

  it('switches to subagent tab when right sidebar is already open on review page and a pill is clicked', async () => {
    const mockOpenTab = vi.fn()
    const mockOpenRightPanelTab = vi.fn()
    const mockSetRightSidebarCollapsed = vi.fn()

    const mockAgents: readonly SubAgentRecord[] = [
      {
        id: 'ag-1',
        name: 'Kierkegaard',
        color: '#9b7dff',
        icon: 'sparkle',
        parentSessionId: 'sess-1',
        sessionId: 'ag-1',
        modelId: 'm',
        status: 'running',
        createdAt: 1,
        updatedAt: 1,
        parentToolCallId: 'call-1',
      },
    ]

    const mockServices = {
      subAgents: {
        getAgents: () => mockAgents,
        openTab: mockOpenTab,
      },
      ui: {
        openRightPanelTab: mockOpenRightPanelTab,
        setRightSidebarCollapsed: mockSetRightSidebarCollapsed,
      },
    }

    render(
      <HostServicesProvider services={mockServices as any}>
        <SubAgentPills
          parentSessionId="sess-1"
          parts={[
            {
              id: 'call-1',
              name: 'spawn_agent',
              args: { prompt: 'solve' },
              status: 'running',
            },
          ]}
        />
      </HostServicesProvider>,
    )

    await userEvent.click(screen.getByText('Kierkegaard'))
    expect(mockOpenTab).toHaveBeenCalledWith('sess-1', 'ag-1')
    expect(mockOpenRightPanelTab).toHaveBeenCalledWith('subagent', { activate: true })
    expect(mockSetRightSidebarCollapsed).toHaveBeenCalledWith(false)
  })

  it('matches sub-agent when part has composite tool call ID and agent has base ID', async () => {
    const mockOpenTab = vi.fn()
    const mockOpenRightPanelTab = vi.fn()
    const mockSetRightSidebarCollapsed = vi.fn()

    const mockAgents: readonly SubAgentRecord[] = [
      {
        id: 'ag-2',
        name: 'Reviewer',
        color: '#9b7dff',
        icon: 'sparkle',
        parentSessionId: 'sess-1',
        sessionId: 'ag-2',
        modelId: 'm',
        status: 'completed',
        createdAt: 1,
        updatedAt: 1,
        parentToolCallId: 'call_1787344285308732000_1724',
      },
    ]

    const mockServices = {
      subAgents: {
        getAgents: () => mockAgents,
        openTab: mockOpenTab,
      },
      ui: {
        openRightPanelTab: mockOpenRightPanelTab,
        setRightSidebarCollapsed: mockSetRightSidebarCollapsed,
      },
    }

    render(
      <HostServicesProvider services={mockServices as any}>
        <SubAgentPills
          parentSessionId="sess-1"
          parts={[
            {
              id: 'call_1787344285308732000_1724|fc_call_1787344285308732000_1724',
              name: 'spawn_agent',
              args: { prompt: 'review code' },
              status: 'done',
            },
          ]}
        />
      </HostServicesProvider>,
    )

    expect(screen.getByText('Reviewer')).toBeInTheDocument()
    await userEvent.click(screen.getByText('Reviewer'))
    expect(mockOpenTab).toHaveBeenCalledWith('sess-1', 'ag-2')
    expect(mockOpenRightPanelTab).toHaveBeenCalledWith('subagent', { activate: true })
  })

  it('matches sub-agent when agent has composite parentToolCallId and part has base ID or different suffix', async () => {
    const mockOpenTab = vi.fn()
    const mockOpenRightPanelTab = vi.fn()
    const mockSetRightSidebarCollapsed = vi.fn()

    const mockAgents: readonly SubAgentRecord[] = [
      {
        id: 'ag-3',
        name: 'Planner',
        color: '#9b7dff',
        icon: 'sparkle',
        parentSessionId: 'sess-1',
        sessionId: 'ag-3',
        modelId: 'm',
        status: 'running',
        createdAt: 1,
        updatedAt: 1,
        parentToolCallId: 'call_999|fc_first',
      },
    ]

    const mockServices = {
      subAgents: {
        getAgents: () => mockAgents,
        openTab: mockOpenTab,
      },
      ui: {
        openRightPanelTab: mockOpenRightPanelTab,
        setRightSidebarCollapsed: mockSetRightSidebarCollapsed,
      },
    }

    render(
      <HostServicesProvider services={mockServices as any}>
        <SubAgentPills
          parentSessionId="sess-1"
          parts={[
            {
              id: 'call_999|fc_second',
              name: 'spawn_agent',
              args: { prompt: 'plan work' },
              status: 'running',
            },
          ]}
        />
      </HostServicesProvider>,
    )

    expect(screen.getByText('Planner')).toBeInTheDocument()
    await userEvent.click(screen.getByText('Planner'))
    expect(mockOpenTab).toHaveBeenCalledWith('sess-1', 'ag-3')
  })

  it('hides spawn pills that never created a sub-agent because prompt is missing', () => {
    const mockServices = {
      subAgents: {
        getAgents: () => EMPTY_AGENTS,
      },
      ui: {},
    }

    const { container } = render(
      <HostServicesProvider services={mockServices as any}>
        <SubAgentPills
          parentSessionId="sess-1"
          parts={[
            {
              id: 'call-unmatched',
              name: 'spawn_agent',
              args: { name: 'UnmatchedAgent' },
              status: 'error',
            },
          ]}
        />
      </HostServicesProvider>,
    )

    expect(screen.queryByTestId('subagent-pills')).toBeNull()
    expect(screen.queryByText('UnmatchedAgent')).toBeNull()
    expect(container).toBeEmptyDOMElement()
  })

  it('hides a pile of failed spawn_agent calls that omitted prompt', () => {
    const mockServices = {
      subAgents: {
        getAgents: () => EMPTY_AGENTS,
      },
    }

    const parts = Array.from({ length: 12 }, (_, index) => ({
      id: `call-23857bfb-${118 + index}|fc_a97423dd_${index}`,
      name: 'spawn_agent',
      args: {
        name: 'issue-reviewer',
        model: 'gpt-6-astra',
        reasoning_effort: 'medium',
        role: 'role-reviewer',
        thinking: 'medium',
      },
      status: 'error',
    }))

    render(
      <HostServicesProvider services={mockServices as any}>
        <SubAgentPills parentSessionId="sess-flood" parts={parts} />
      </HostServicesProvider>,
    )

    expect(screen.queryByTestId('subagent-pills')).toBeNull()
    expect(screen.queryAllByText('issue-reviewer')).toHaveLength(0)
  })

  it('still shows the real sub-agent when failed prompt-less calls are mixed in', () => {
    const mockAgents: readonly SubAgentRecord[] = [
      {
        id: 'ag-real',
        name: 'astra-review',
        color: '#9b7dff',
        icon: 'sparkle',
        parentSessionId: 'sess-mix',
        sessionId: 'ag-real',
        modelId: 'gpt-6-astra',
        status: 'completed',
        createdAt: 1,
        updatedAt: 1,
        parentToolCallId: 'call-real',
      },
    ]

    const mockServices = {
      subAgents: {
        getAgents: () => mockAgents,
      },
    }

    render(
      <HostServicesProvider services={mockServices as any}>
        <SubAgentPills
          parentSessionId="sess-mix"
          parts={[
            {
              id: 'call-missing-prompt',
              name: 'spawn_agent',
              args: { name: 'issue-reviewer', model: 'gpt-6-astra' },
              status: 'error',
            },
            {
              id: 'call-real',
              name: 'spawn_agent',
              args: { name: 'astra-review', prompt: 'review independently' },
              status: 'done',
            },
            {
              id: 'call-empty-args',
              name: 'spawn_agent',
              args: {},
              status: 'error',
            },
          ]}
        />
      </HostServicesProvider>,
    )

    expect(screen.getByTestId('subagent-pills')).toBeInTheDocument()
    expect(screen.getByText('astra-review')).toBeInTheDocument()
    expect(screen.queryByText('issue-reviewer')).toBeNull()
    expect(screen.queryByText('Agent')).toBeNull()
  })

  it('does not open sidebar or tab when in-flight pill has no matching record', async () => {
    const mockOpenTab = vi.fn()
    const mockOpenRightPanelTab = vi.fn()
    const mockSetRightSidebarCollapsed = vi.fn()

    const mockServices = {
      subAgents: {
        getAgents: () => EMPTY_AGENTS,
        openTab: mockOpenTab,
      },
      ui: {
        openRightPanelTab: mockOpenRightPanelTab,
        setRightSidebarCollapsed: mockSetRightSidebarCollapsed,
      },
    }

    render(
      <HostServicesProvider services={mockServices as any}>
        <SubAgentPills
          parentSessionId="sess-1"
          parts={[
            {
              id: 'call-unmatched',
              name: 'spawn_agent',
              args: { name: 'UnmatchedAgent', prompt: 'review the fix' },
              status: 'running',
            },
          ]}
        />
      </HostServicesProvider>,
    )

    expect(screen.getByText('UnmatchedAgent')).toBeInTheDocument()
    await userEvent.click(screen.getByText('UnmatchedAgent'))
    expect(mockOpenTab).not.toHaveBeenCalled()
    expect(mockOpenRightPanelTab).not.toHaveBeenCalled()
    expect(mockSetRightSidebarCollapsed).not.toHaveBeenCalled()
  })

  it('applies animate-text-shimmer class to running pill text when sub-agents are running or queued', () => {
    const mockServices = {
      subAgents: {
        getAgents: () => EMPTY_AGENTS,
      },
      ui: {},
    }

    render(
      <HostServicesProvider services={mockServices as any}>
        <SubAgentPills
          parentSessionId="sess-1"
          parts={[
            {
              id: 'call-running',
              name: 'spawn_agent',
              args: { name: 'Worker', prompt: 'do work' },
              status: 'running',
            },
          ]}
        />
      </HostServicesProvider>,
    )

    const pillNameElement = screen.getByText('Worker')
    expect(pillNameElement).toBeInTheDocument()
    expect(pillNameElement).toHaveClass('animate-text-shimmer')
  })

  it('does not apply animate-text-shimmer class to pill text when all sub-agents are done', () => {
    const mockAgents: readonly SubAgentRecord[] = [
      {
        id: 'ag-done',
        name: 'Worker',
        color: '#9b7dff',
        icon: 'sparkle',
        parentSessionId: 'sess-1',
        sessionId: 'ag-done',
        modelId: 'm',
        status: 'completed',
        createdAt: 1,
        updatedAt: 1,
        parentToolCallId: 'call-done',
      },
    ]

    const mockServices = {
      subAgents: {
        getAgents: () => mockAgents,
      },
      ui: {},
    }

    render(
      <HostServicesProvider services={mockServices as any}>
        <SubAgentPills
          parentSessionId="sess-1"
          parts={[
            {
              id: 'call-done',
              name: 'spawn_agent',
              args: { name: 'Worker' },
              status: 'done',
            },
          ]}
        />
      </HostServicesProvider>,
    )

    const pillNameElement = screen.getByText('Worker')
    expect(pillNameElement).toBeInTheDocument()
    expect(pillNameElement).not.toHaveClass('animate-text-shimmer')
  })

  it('applies animate-text-shimmer class selectively only to running pills in a mixed list', () => {
    const mockAgents: readonly SubAgentRecord[] = [
      {
        id: 'ag-1',
        name: 'RunningAgent',
        color: '#9b7dff',
        icon: 'sparkle',
        parentSessionId: 'sess-1',
        sessionId: 'ag-1',
        modelId: 'm',
        status: 'running',
        createdAt: 1,
        updatedAt: 1,
        parentToolCallId: 'call-run',
      },
      {
        id: 'ag-2',
        name: 'DoneAgent',
        color: '#3dd68c',
        icon: 'atom',
        parentSessionId: 'sess-1',
        sessionId: 'ag-2',
        modelId: 'm',
        status: 'completed',
        createdAt: 1,
        updatedAt: 1,
        parentToolCallId: 'call-done',
      },
    ]

    const mockServices = {
      subAgents: {
        getAgents: () => mockAgents,
      },
      ui: {},
    }

    render(
      <HostServicesProvider services={mockServices as any}>
        <SubAgentPills
          parentSessionId="sess-1"
          parts={[
            {
              id: 'call-run',
              name: 'spawn_agent',
              args: { name: 'RunningAgent' },
              status: 'running',
            },
            {
              id: 'call-done',
              name: 'spawn_agent',
              args: { name: 'DoneAgent' },
              status: 'done',
            },
          ]}
        />
      </HostServicesProvider>,
    )

    const runningPill = screen.getByText('RunningAgent')
    const donePill = screen.getByText('DoneAgent')

    expect(runningPill).toHaveClass('animate-text-shimmer')
    expect(donePill).not.toHaveClass('animate-text-shimmer')
  })

  it('accepts sessionId alias from chat.message.subagents ExtensionSlot props', async () => {
    const mockOpenTab = vi.fn()
    const mockOpenRightPanelTab = vi.fn()
    const mockSetRightSidebarCollapsed = vi.fn()

    const mockAgents: readonly SubAgentRecord[] = [
      {
        id: 'ag-slot',
        name: 'SlotAgent',
        color: '#9b7dff',
        icon: 'sparkle',
        parentSessionId: 'sess-slot',
        sessionId: 'ag-slot',
        modelId: 'm',
        status: 'running',
        createdAt: 1,
        updatedAt: 1,
        parentToolCallId: 'call-slot',
      },
    ]

    const mockServices = {
      subAgents: {
        getAgents: () => mockAgents,
        openTab: mockOpenTab,
      },
      ui: {
        openRightPanelTab: mockOpenRightPanelTab,
        setRightSidebarCollapsed: mockSetRightSidebarCollapsed,
      },
    }

    render(
      <HostServicesProvider services={mockServices as any}>
        <SubAgentPills
          sessionId="sess-slot"
          parts={[
            {
              id: 'call-slot',
              name: 'spawn_agent',
              args: { name: 'SlotAgent' },
              status: 'running',
            },
          ]}
        />
      </HostServicesProvider>,
    )

    expect(screen.getByTestId('subagent-pills')).toBeInTheDocument()
    expect(screen.getByText('SlotAgent')).toBeInTheDocument()
    await userEvent.click(screen.getByText('SlotAgent'))
    expect(mockOpenTab).toHaveBeenCalledWith('sess-slot', 'ag-slot')
    expect(mockOpenRightPanelTab).toHaveBeenCalledWith('subagent', { activate: true })
    expect(mockSetRightSidebarCollapsed).toHaveBeenCalledWith(false)
  })

  it('displays "(Queued)" text in pill badge when sub-agent is queued', () => {
    const mockAgents: readonly SubAgentRecord[] = [
      {
        id: 'ag-queued',
        name: 'QueuedWorker',
        color: '#f5c518',
        icon: 'sun',
        parentSessionId: 'sess-queued',
        sessionId: 'ag-queued',
        modelId: 'm',
        status: 'queued',
        createdAt: 1,
        updatedAt: 1,
        parentToolCallId: 'call-queued',
      },
    ]

    const mockServices = {
      subAgents: {
        getAgents: () => mockAgents,
      },
    }

    render(
      <HostServicesProvider services={mockServices as any}>
        <SubAgentPills
          parentSessionId="sess-queued"
          parts={[
            {
              id: 'call-queued',
              name: 'spawn_agent',
              args: { name: 'QueuedWorker' },
              status: 'queued',
            },
          ]}
        />
      </HostServicesProvider>,
    )

    expect(screen.getByText('QueuedWorker')).toBeInTheDocument()
    expect(screen.getByText('(Queued)')).toBeInTheDocument()
  })

  it('does NOT display "(Queued)" when sub-agent record is running or not queued', () => {
    const mockAgents: readonly SubAgentRecord[] = [
      {
        id: 'ag-running',
        name: 'ActiveWorker',
        color: '#3dd68c',
        icon: 'sparkle',
        parentSessionId: 'sess-running',
        sessionId: 'ag-running',
        modelId: 'm',
        status: 'running',
        createdAt: 1,
        updatedAt: 1,
        parentToolCallId: 'call-running',
      },
    ]

    const mockServices = {
      subAgents: {
        getAgents: () => mockAgents,
      },
    }

    render(
      <HostServicesProvider services={mockServices as any}>
        <SubAgentPills
          parentSessionId="sess-running"
          parts={[
            {
              id: 'call-running',
              name: 'spawn_agent',
              args: { name: 'ActiveWorker' },
              status: 'queued', // tool call part status alone must NOT trigger queued badge
            },
          ]}
        />
      </HostServicesProvider>,
    )

    expect(screen.getByText('ActiveWorker')).toBeInTheDocument()
    expect(screen.queryByText('(Queued)')).toBeNull()
  })
})
