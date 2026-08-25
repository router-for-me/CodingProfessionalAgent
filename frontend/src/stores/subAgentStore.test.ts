import { beforeEach, describe, expect, it } from 'vitest'
import type { SubAgentRecord } from '@cpa/plugin-api'
import { agentsForParent, useSubAgentStore } from './subAgentStore'

function makeAgent(patch: Partial<SubAgentRecord> = {}): SubAgentRecord {
  return {
    id: 'agent-1',
    sessionId: 'sess-child-1',
    parentSessionId: 'sess-parent-1',
    name: 'Researcher',
    modelId: 'gpt-5.6',
    status: 'running',
    color: '#9b7dff',
    icon: 'sparkle',
    createdAt: 1000,
    updatedAt: 1000,
    ...patch,
  }
}

describe('subAgentStore', () => {
  beforeEach(() => {
    useSubAgentStore.setState({
      agents: [],
      openTabIdsByParent: {},
      focusedIdByParent: {},
    })
  })

  it('preserves running and queued subagents when mergeAgentsForParent is called', () => {
    const runningAgent = makeAgent({ id: 'agent-run', status: 'running' })
    const queuedAgent = makeAgent({ id: 'agent-queue', status: 'queued' })
    useSubAgentStore.setState({ agents: [runningAgent, queuedAgent] })

    // Disk snapshot with aborted/completed statuses should not overwrite live running/queued agents
    useSubAgentStore.getState().mergeAgentsForParent('sess-parent-1', [
      { ...runningAgent, status: 'aborted' as const },
      { ...queuedAgent, status: 'aborted' as const },
      makeAgent({ id: 'agent-disk', status: 'completed' }),
    ])

    const agents = useSubAgentStore.getState().agents
    expect(agents).toHaveLength(3)
    expect(agents.find((a) => a.id === 'agent-run')?.status).toBe('running')
    expect(agents.find((a) => a.id === 'agent-queue')?.status).toBe('queued')
    expect(agents.find((a) => a.id === 'agent-disk')?.status).toBe('completed')
  })

  it('preserves live running and queued agents when setAgentsForParent is called with disk records', () => {
    const runningAgent = makeAgent({ id: 'agent-live', status: 'running' })
    useSubAgentStore.setState({ agents: [runningAgent] })

    useSubAgentStore.getState().setAgentsForParent('sess-parent-1', [
      { ...runningAgent, status: 'aborted' as const },
      makeAgent({ id: 'agent-completed', status: 'completed' }),
    ])

    const agents = useSubAgentStore.getState().agents
    expect(agents).toHaveLength(2)
    expect(agents.find((a) => a.id === 'agent-live')?.status).toBe('running')
    expect(agents.find((a) => a.id === 'agent-completed')?.status).toBe('completed')
  })

  it('preserves newly spawned in-memory running agents when setAgentsForParent receives older disk snapshot without them', () => {
    const newlySpawned = makeAgent({ id: 'agent-new', status: 'running' })
    useSubAgentStore.setState({ agents: [newlySpawned] })

    // Disk snapshot that has not captured newlySpawned yet
    useSubAgentStore.getState().setAgentsForParent('sess-parent-1', [
      makeAgent({ id: 'agent-old', status: 'completed' }),
    ])

    const agents = useSubAgentStore.getState().agents
    expect(agents).toHaveLength(2)
    expect(agents.find((a) => a.id === 'agent-new')?.status).toBe('running')
    expect(agents.find((a) => a.id === 'agent-old')?.status).toBe('completed')
  })

  it('filters agents correctly by parent session', () => {
    const agentA = makeAgent({ id: 'a', parentSessionId: 'parent-1' })
    const agentB = makeAgent({ id: 'b', parentSessionId: 'parent-2' })
    const agents = [agentA, agentB]

    expect(agentsForParent(agents, 'parent-1')).toEqual([agentA])
    expect(agentsForParent(agents, 'parent-2')).toEqual([agentB])
    expect(agentsForParent(agents, 'parent-3')).toEqual([])
  })

  it('manages open tabs and focused tab per parent session', () => {
    const store = useSubAgentStore.getState()

    store.openTab('p1', 'ag1')
    expect(useSubAgentStore.getState().openTabIdsByParent['p1']).toEqual(['ag1'])
    expect(useSubAgentStore.getState().focusedIdByParent['p1']).toBe('ag1')

    store.openTab('p1', 'ag2')
    expect(useSubAgentStore.getState().openTabIdsByParent['p1']).toEqual(['ag1', 'ag2'])
    expect(useSubAgentStore.getState().focusedIdByParent['p1']).toBe('ag2')

    store.closeTab('p1', 'ag2')
    expect(useSubAgentStore.getState().openTabIdsByParent['p1']).toEqual(['ag1'])
    expect(useSubAgentStore.getState().focusedIdByParent['p1']).toBe('ag1')

    store.closeTab('p1', 'ag1')
    expect(useSubAgentStore.getState().openTabIdsByParent['p1']).toEqual([])
    expect(useSubAgentStore.getState().focusedIdByParent['p1']).toBeNull()
  })

  it('removes agents and tabs for parent session on removeAgentsForParent', () => {
    const agentA = makeAgent({ id: 'a', parentSessionId: 'p1' })
    const agentB = makeAgent({ id: 'b', parentSessionId: 'p2' })
    useSubAgentStore.setState({
      agents: [agentA, agentB],
      openTabIdsByParent: { p1: ['a'], p2: ['b'] },
      focusedIdByParent: { p1: 'a', p2: 'b' },
    })

    useSubAgentStore.getState().removeAgentsForParent('p1')

    const state = useSubAgentStore.getState()
    expect(state.agents).toEqual([agentB])
    expect(state.openTabIdsByParent['p1']).toBeUndefined()
    expect(state.focusedIdByParent['p1']).toBeUndefined()
    expect(state.openTabIdsByParent['p2']).toEqual(['b'])
    expect(state.focusedIdByParent['p2']).toBe('b')
  })
})
