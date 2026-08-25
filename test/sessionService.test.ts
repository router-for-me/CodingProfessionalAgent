import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { SessionService } from '../plugins/bundled/cpa.core.session-manager/main/sessionService.js'

describe('SessionService', () => {
  let service: SessionService
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cpa-session-test-'))
    service = new SessionService({ customDir: tempDir })
  })

  afterEach(async () => {
    service.close()
    try {
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore
    }
  })

  it('maintains getSessionsDir() for backward compatibility', () => {
    const mockHome = path.join(tempDir, 'mock-home')
    const defaultService = new SessionService({ getHomeDir: () => mockHome })
    try {
      const expectedDir = path.join(mockHome, '.coding-professional-agent', 'sessions')
      expect(defaultService.getSessionsDir()).toBe(expectedDir)
    } finally {
      defaultService.close()
    }

    const memoryService = new SessionService(':memory:')
    try {
      expect(memoryService.getSessionsDir()).toBe(':memory:')
    } finally {
      memoryService.close()
    }

    expect(service.getSessionsDir()).toBe(tempDir)
  })

  it('gets, sets, queries metrics and deletes session data via SQLite backend', async () => {
    // 1. get(nonExistent) returns null
    expect(await service.get('non-existent')).toBeNull()

    // 2. set('sess-1', payload) and get('sess-1') returns the session data
    const mockPayload = {
      id: 'sess-1',
      projectId: 'proj-alpha',
      entries: [
        {
          id: 'e1',
          kind: 'user',
          text: 'please run $superpower and /skill:audit',
          createdAt: 1000,
        },
        {
          id: 'e2',
          kind: 'assistant',
          model: 'gpt-4o',
          speed: 'fast',
          reasoningEffort: 'high',
          usage: {
            input: 100,
            output: 50,
            cacheRead: 20,
            cacheWrite: 10,
            reasoning: 30,
            totalTokens: 150,
            cost: {
              input: 0.001,
              output: 0.002,
              cacheRead: 0.0001,
              cacheWrite: 0.0002,
              total: 0.0033,
            },
          },
          createdAt: 2500,
        },
      ],
      subAgents: [
        {
          id: 'sub-1',
          sessionId: 'child-sess-1',
          name: 'Explorer Subagent',
          status: 'completed',
        },
      ],
    }

    await service.set('sess-1', mockPayload)

    const sessionData = await service.get('sess-1')
    expect(sessionData).not.toBeNull()
    expect(sessionData?.id).toBe('sess-1')
    expect(sessionData?.version).toBe(2)
    expect(sessionData?.entries).toHaveLength(2)
    expect(sessionData?.entries[0].id).toBe('e1')
    expect(sessionData?.entries[1].id).toBe('e2')
    expect(sessionData?.subAgents).toHaveLength(1)
    expect(sessionData?.subAgents?.[0].name).toBe('Explorer Subagent')

    // 3. list() returns ['sess-1', 'child-sess-1']
    const sessionList = await service.list()
    expect(sessionList).toContain('sess-1')
    expect(sessionList).toContain('child-sess-1')

    // 4. queryMetrics() returns calculated metrics
    const metrics = await service.queryMetrics()
    expect(metrics.summary.totalChats).toBe(1)
    expect(metrics.summary.totalTokens).toBe(150)
    expect(metrics.summary.totalTokensBreakdown.input).toBe(100)
    expect(metrics.summary.totalTokensBreakdown.output).toBe(50)
    expect(metrics.summary.totalTokensBreakdown.cacheRead).toBe(20)
    expect(metrics.summary.totalTokensBreakdown.cacheWrite).toBe(10)
    expect(metrics.summary.totalTokensBreakdown.reasoning).toBe(30)
    expect(metrics.summary.totalCost).toBe(0.0033)
    expect(metrics.summary.uniqueSkillsCount).toBe(2)
    expect(metrics.summary.totalSkillInvocations).toBe(2)
    expect(metrics.summary.topSkills).toEqual([
      { name: 'audit', count: 1 },
      { name: 'superpower', count: 1 },
    ])

    // Query metrics with project filter
    const projectMetrics = await service.queryMetrics({ projectId: 'proj-alpha' })
    expect(projectMetrics.summary.totalChats).toBe(1)

    const nonExistentProjectMetrics = await service.queryMetrics({ projectId: 'unknown-proj' })
    expect(nonExistentProjectMetrics.summary.totalChats).toBe(0)

    // 5. delete('sess-1') removes session and child sessions
    await service.delete('sess-1')
    expect(await service.get('sess-1')).toBeNull()
    expect(await service.get('child-sess-1')).toBeNull()
    expect(await service.list()).not.toContain('sess-1')
    expect(await service.list()).not.toContain('child-sess-1')
  })

  it('provides listSessions() and setMeta() delegating to database service', async () => {
    // 1. Initially empty
    expect(await service.listSessions()).toEqual([])

    // 2. Set metadata for two sessions
    await service.setMeta({
      id: 'sess-a',
      title: 'Session A',
      projectId: 'proj-1',
      branch: 'feature/test',
      pinned: false,
      createdAt: 1000,
      updatedAt: 1000,
    })

    await service.setMeta({
      id: 'sess-b',
      title: 'Session B',
      projectId: 'proj-2',
      pinned: true,
      createdAt: 2000,
      updatedAt: 2000,
    })

    // 3. listSessions returns both sessions, pinned first
    const list = await service.listSessions()
    expect(list).toHaveLength(2)
    expect(list[0].id).toBe('sess-b')
    expect(list[0].pinned).toBe(true)
    expect(list[0].projectId).toBe('proj-2')
    expect(list[1].id).toBe('sess-a')
    expect(list[1].pinned).toBe(false)
    expect(list[1].branch).toBe('feature/test')

    // 4. Update session metadata (rename and pin session A)
    await service.setMeta({
      id: 'sess-a',
      title: 'Session A Renamed',
      pinned: true,
      updatedAt: 3000,
    })

    const updatedList = await service.listSessions()
    expect(updatedList[0].id).toBe('sess-a') // pinned and more recent updatedAt
    expect(updatedList[0].title).toBe('Session A Renamed')
    expect(updatedList[0].pinned).toBe(true)
    expect(updatedList[0].projectId).toBe('proj-1') // preserved
    expect(updatedList[0].branch).toBe('feature/test') // preserved

    // 5. Exclude subagents
    await service.set('sess-parent', {
      id: 'sess-parent',
      version: 2,
      title: 'Parent Session',
      entries: [{ id: 'pe1', kind: 'user', content: [{ type: 'text', text: 'hi' }] }],
      subAgents: [
        {
          id: 'sub-agent-1',
          sessionId: 'sess-child',
          name: 'Child Agent',
          status: 'completed',
        },
      ],
    })

    const listWithSubagent = await service.listSessions()
    expect(listWithSubagent.some((s) => s.id === 'sess-child')).toBe(false)
    expect(listWithSubagent.some((s) => s.id === 'sess-parent')).toBe(true)
  })

  it('persists scheduleId and supports listSessionsByScheduleId()', async () => {
    // 1. Initially empty for schedule
    expect(await service.listSessionsByScheduleId('schedule-123')).toEqual([])

    // 2. Set metadata with scheduleId
    await service.setMeta({
      id: 'sess-sched-1',
      title: 'Daily Briefing Run #1',
      scheduleId: 'schedule-123',
      createdAt: 1000,
      updatedAt: 1000,
    })

    await service.setMeta({
      id: 'sess-sched-2',
      title: 'Daily Briefing Run #2',
      scheduleId: 'schedule-123',
      createdAt: 2000,
      updatedAt: 2000,
    })

    await service.setMeta({
      id: 'sess-other',
      title: 'Unrelated Session',
      createdAt: 1500,
      updatedAt: 1500,
    })

    // 3. Query metadata and get() includes scheduleId
    const meta1 = await service.getMeta('sess-sched-1')
    expect(meta1?.scheduleId).toBe('schedule-123')

    const listBySchedule = await service.listSessionsByScheduleId('schedule-123')
    expect(listBySchedule).toHaveLength(2)
    expect(listBySchedule[0].id).toBe('sess-sched-2') // Newer createdAt first
    expect(listBySchedule[1].id).toBe('sess-sched-1')
    expect(listBySchedule.every((s) => s.scheduleId === 'schedule-123')).toBe(true)

    // 4. Session data via set() also preserves scheduleId
    await service.set('sess-sched-3', {
      id: 'sess-sched-3',
      scheduleId: 'schedule-456',
      title: 'Weekly Review Run',
      entries: [{ id: 'e1', kind: 'user', text: 'run review', createdAt: 3000 }],
    })

    const data3 = await service.get('sess-sched-3')
    expect(data3?.scheduleId).toBe('schedule-456')

    const list456 = await service.listSessionsByScheduleId('schedule-456')
    expect(list456).toHaveLength(1)
    expect(list456[0].id).toBe('sess-sched-3')
  })

  it('closes cleanly', () => {
    expect(() => service.close()).not.toThrow()
    // Repeated close is safe
    expect(() => service.close()).not.toThrow()
  })
})
