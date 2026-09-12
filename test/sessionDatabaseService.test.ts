import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as fsSync from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { SessionDatabaseService, computeStreaks, parseRightSidebar } from '../plugins/bundled/cpa.core.session-manager/main/sessionDatabaseService.js'
import type { SessionRightSidebarState } from '../src/shared/types.js'

describe('SessionDatabaseService', () => {
  let service: SessionDatabaseService
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cpa-db-test-'))
    service = new SessionDatabaseService({ customDir: tempDir })
  })

  afterEach(async () => {
    service.close()
    try {
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore
    }
  })

  it('initializes WAL mode, busy_timeout, and all 8 indexes on file-based database', () => {
    const db = service.getDb()
    expect(db).toBeDefined()

    // WAL mode check on file DB
    const journalPragma = db.pragma('journal_mode', { simple: true })
    expect(journalPragma).toBe('wal')

    // busy_timeout check
    const busyTimeout = db.pragma('busy_timeout', { simple: true })
    expect(busyTimeout).toBe(5000)

    // Foreign keys check
    const fkPragma = db.pragma('foreign_keys', { simple: true })
    expect(fkPragma).toBe(1)

    // Synchronous check (1 = NORMAL)
    const syncPragma = db.pragma('synchronous', { simple: true })
    expect(syncPragma).toBe(1)

    // All 10 custom indexes in sqlite_master
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'")
      .all()
      .map((r: any) => r.name)

    expect(indexes).toHaveLength(10)
    expect(indexes).toContain('idx_sessions_project')
    expect(indexes).toContain('idx_sessions_schedule')
    expect(indexes).toContain('idx_sessions_parent')
    expect(indexes).toContain('idx_sessions_created')
    expect(indexes).toContain('idx_entries_session_order')
    expect(indexes).toContain('idx_subagents_parent')
    expect(indexes).toContain('idx_turns_stats_agg')
    expect(indexes).toContain('idx_turns_parent_stats')
    expect(indexes).toContain('idx_skills_stats')
    expect(indexes).toContain('idx_plugin_storage_lookup')
  })

  it('initializes schema and pragmas properly with in-memory database', () => {
    const memService = new SessionDatabaseService({ dbPath: ':memory:' })
    try {
      const db = memService.getDb()
      expect(db).toBeDefined()

      // Foreign keys check
      const fkPragma = db.pragma('foreign_keys', { simple: true })
      expect(fkPragma).toBe(1)

      // Synchronous check (1 = NORMAL)
      const syncPragma = db.pragma('synchronous', { simple: true })
      expect(syncPragma).toBe(1)

      // Tables check
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r: any) => r.name)

      expect(tables).toContain('sessions')
      expect(tables).toContain('session_entries')
      expect(tables).toContain('subagents')
      expect(tables).toContain('conversation_turns')
      expect(tables).toContain('skill_invocations')
      expect(tables).toContain('plugin_storage')
    } finally {
      memService.close()
    }
  })

  it('handles custom directory and default path resolution', () => {
    const expectedDbPath = path.join(tempDir, 'data.db')
    expect(service.getDbPath()).toBe(expectedDbPath)

    const homeMock = path.join(tempDir, 'mock-home')
    const homeService = new SessionDatabaseService({ getHomeDir: () => homeMock })
    try {
      expect(homeService.getDbPath()).toBe(
        path.join(homeMock, '.coding-professional-agent', 'sessions', 'data.db'),
      )
    } finally {
      homeService.close()
    }

    const devHomeService = new SessionDatabaseService({ getHomeDir: () => homeMock, isDev: true })
    try {
      expect(devHomeService.getDbPath()).toBe(
        path.join(homeMock, '.coding-professional-agent-dev', 'sessions', 'data.db'),
      )
    } finally {
      devHomeService.close()
    }
  })

  it('gets, sets, updates, lists, and deletes standard session entries', async () => {
    expect(await service.get('non-existent')).toBeNull()

    const mockEntries = [
      { id: 'e1', kind: 'user', content: [{ type: 'text', text: 'hello world' }] },
      { id: 'e2', kind: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
    ]

    // 1. Set raw array
    await service.set('sess-1', mockEntries)
    const result1 = await service.get('sess-1')
    expect(result1).not.toBeNull()
    expect(result1?.id).toBe('sess-1')
    expect(result1?.version).toBe(2)
    expect(result1?.entries).toEqual(mockEntries)

    // 2. List sessions ordered by updated_at DESC
    const list1 = await service.list()
    expect(list1).toContain('sess-1')

    // Create another session to verify list ordering
    await service.set('sess-2', {
      id: 'sess-2',
      version: 2,
      entries: [{ id: 'e2-1', kind: 'user', content: [] }],
      updatedAt: Date.now() + 1000,
    })
    const listOrdered = await service.list()
    expect(listOrdered[0]).toBe('sess-2')
    expect(listOrdered).toContain('sess-1')

    // 3. Update session with payload object
    const updatedEntries = [
      ...mockEntries,
      { id: 'e3', kind: 'user', content: [{ type: 'text', text: 'what is 1+1?' }] },
    ]
    await service.set('sess-1', {
      id: 'sess-1',
      version: 2,
      entries: updatedEntries,
      projectId: 'proj-123',
      title: 'Math Question',
    })

    const result2 = await service.get('sess-1')
    expect(result2?.entries).toHaveLength(3)
    expect(result2?.entries[2].id).toBe('e3')

    // 4. Delete session
    await service.delete('sess-1')
    expect(await service.get('sess-1')).toBeNull()
    const list2 = await service.list()
    expect(list2).not.toContain('sess-1')
  })

  it('persists main session runtime settings for restart recovery', async () => {
    await service.set('runtime-session', {
      id: 'runtime-session',
      title: 'Interrupted',
      entries: [
        {
          id: 'u1',
          kind: 'user',
          createdAt: 100,
          content: [{ type: 'text', text: 'Continue working' }],
        },
      ],
    })
    await service.setMeta({
      id: 'runtime-session',
      modelId: 'gpt-5.6-sol',
      reasoningEffort: 'xhigh',
      speed: 'standard',
    })

    const loaded = await service.get('runtime-session') as any
    expect(loaded).toMatchObject({
      modelId: 'gpt-5.6-sol',
      reasoningEffort: 'xhigh',
      speed: 'standard',
    })

    const listed = (await service.listSessions()).find(
      (session) => session.id === 'runtime-session',
    ) as any
    expect(listed).toMatchObject({
      modelId: 'gpt-5.6-sol',
      reasoningEffort: 'xhigh',
      speed: 'standard',
    })
  })

  it('backfills runtime settings from the latest turn when upgrading existing sessions', async () => {
    await service.set('legacy-runtime-session', {
      id: 'legacy-runtime-session',
      title: 'Interrupted',
      entries: [
        {
          id: 'u1',
          kind: 'user',
          createdAt: 100,
          content: [{ type: 'text', text: 'Continue working' }],
        },
        {
          id: 'a1',
          kind: 'assistant',
          model: 'gpt-5.6-sol',
          createdAt: 101,
          content: [{ type: 'text', text: 'Partial response' }],
          status: 'streaming',
        },
      ],
      modelId: 'gpt-5.6-sol',
      reasoningEffort: 'xhigh',
      speed: 'standard',
    })
    service.getDb().prepare(`
      UPDATE sessions
      SET model_id = NULL, reasoning_effort = NULL, speed = NULL
      WHERE id = ?
    `).run('legacy-runtime-session')

    service.close()
    service = new SessionDatabaseService({ customDir: tempDir })

    const restored = await service.getMeta('legacy-runtime-session') as any
    expect(restored).toMatchObject({
      modelId: 'gpt-5.6-sol',
      reasoningEffort: 'xhigh',
      speed: 'standard',
    })
  })

  it('handles subagents and cascading deletion of child sessions', async () => {
    const parentId = 'parent-sess'
    const childId = 'child-sess-1'

    const subAgents = [
      {
        id: 'agent-1',
        name: 'Explore Agent',
        color: '#4f46e5',
        icon: 'robot',
        parentSessionId: parentId,
        sessionId: childId,
        modelId: 'gpt-4o',
        reasoningEffort: 'medium',
        status: 'completed' as const,
        createdAt: Date.now() - 5000,
        updatedAt: Date.now(),
        lastMessage: 'Task finished',
      },
    ]

    const parentEntries = [
      { id: 'pe1', kind: 'user', content: [{ type: 'text', text: 'run subagent' }] },
    ]

    const childEntries = [
      { id: 'ce1', kind: 'user', content: [{ type: 'text', text: 'subagent query' }] },
      { id: 'ce2', kind: 'assistant', content: [{ type: 'text', text: 'subagent answer' }] },
    ]

    // Set parent session with subAgents
    await service.set(parentId, {
      id: parentId,
      version: 2,
      entries: parentEntries,
      subAgents,
    })

    // Set child session
    await service.set(childId, {
      id: childId,
      version: 2,
      entries: childEntries,
      parentSessionId: parentId,
      isSubagent: true,
    })

    // Verify parent get contains subagents
    const parentData = await service.get(parentId)
    expect(parentData).not.toBeNull()
    expect(parentData?.entries).toEqual(parentEntries)
    expect(parentData?.subAgents).toHaveLength(1)
    expect(parentData?.subAgents?.[0].name).toBe('Explore Agent')
    expect(parentData?.subAgents?.[0].sessionId).toBe(childId)

    // Verify child get
    const childData = await service.get(childId)
    expect(childData).not.toBeNull()
    expect(childData?.entries).toEqual(childEntries)

    // Verify DB records
    const db = service.getDb()
    const rawSubAgents = db.prepare('SELECT * FROM subagents WHERE parent_session_id = ?').all(parentId)
    expect(rawSubAgents).toHaveLength(1)

    const rawEntries = db.prepare('SELECT * FROM session_entries').all()
    expect(rawEntries).toHaveLength(3) // 1 in parent + 2 in child

    // Verify conversation_turns were automatically created for parent and child
    expect(db.prepare('SELECT * FROM conversation_turns WHERE session_id = ?').all(parentId)).toHaveLength(1)
    expect(db.prepare('SELECT * FROM conversation_turns WHERE session_id = ?').all(childId)).toHaveLength(1)

    // Insert dummy skill invocation to verify cascade deletion
    db.prepare(`
      INSERT INTO skill_invocations (
        id, turn_id, session_id, skill_name, invoked_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run('skill-1', 'pe1', parentId, 'fix-issue', Date.now())

    expect(db.prepare('SELECT * FROM skill_invocations WHERE session_id = ?').all(parentId)).toHaveLength(1)

    // Delete parent session -> verify parent, child, entries, subagents, turns, skills are all removed
    await service.delete(parentId)

    expect(await service.get(parentId)).toBeNull()
    expect(await service.get(childId)).toBeNull()
    expect(await service.list()).not.toContain(parentId)
    expect(await service.list()).not.toContain(childId)

    const remainingEntries = db.prepare('SELECT * FROM session_entries').all()
    expect(remainingEntries).toHaveLength(0)

    const remainingSubAgents = db.prepare('SELECT * FROM subagents').all()
    expect(remainingSubAgents).toHaveLength(0)

    const remainingTurns = db.prepare('SELECT * FROM conversation_turns WHERE session_id = ?').all(parentId)
    expect(remainingTurns).toHaveLength(0)

    const remainingSkills = db.prepare('SELECT * FROM skill_invocations WHERE session_id = ?').all(parentId)
    expect(remainingSkills).toHaveLength(0)
  })

  it('preserves is_subagent, parent_session_id, project_id, branch, and pinned when child session is updated via standard set()', async () => {
    const parentId = 'parent-preserved-sess'
    const childId = 'child-preserved-sess'

    // Create child session with full metadata
    await service.set(childId, {
      id: childId,
      version: 2,
      entries: [{ id: 'e1', kind: 'user', content: [{ type: 'text', text: 'initial child prompt' }] }],
      projectId: 'project-xyz',
      parentSessionId: parentId,
      isSubagent: true,
      branch: 'feature/auth',
      pinned: true,
      title: 'Child Subagent Session',
    })

    const db = service.getDb()
    const initialRow = db.prepare('SELECT * FROM sessions WHERE id = ?').get(childId) as any
    expect(initialRow.is_subagent).toBe(1)
    expect(initialRow.parent_session_id).toBe(parentId)
    expect(initialRow.project_id).toBe('project-xyz')
    expect(initialRow.branch).toBe('feature/auth')
    expect(initialRow.pinned).toBe(1)
    expect(initialRow.title).toBe('Child Subagent Session')

    // Update child session with standard payload where isSubagent/parentSessionId/etc. are not specified
    await service.set(childId, {
      id: childId,
      version: 2,
      entries: [
        { id: 'e1', kind: 'user', content: [{ type: 'text', text: 'initial child prompt' }] },
        { id: 'e2', kind: 'assistant', content: [{ type: 'text', text: 'child response' }] },
      ],
    })

    const updatedRow = db.prepare('SELECT * FROM sessions WHERE id = ?').get(childId) as any
    expect(updatedRow.is_subagent).toBe(1)
    expect(updatedRow.parent_session_id).toBe(parentId)
    expect(updatedRow.project_id).toBe('project-xyz')
    expect(updatedRow.branch).toBe('feature/auth')
    expect(updatedRow.pinned).toBe(1)

    // Update child session with raw array payload
    await service.set(childId, [
      { id: 'e1', kind: 'user', content: [{ type: 'text', text: 'updated prompt' }] },
    ])

    const rawUpdatedRow = db.prepare('SELECT * FROM sessions WHERE id = ?').get(childId) as any
    expect(rawUpdatedRow.is_subagent).toBe(1)
    expect(rawUpdatedRow.parent_session_id).toBe(parentId)
    expect(rawUpdatedRow.project_id).toBe('project-xyz')
    expect(rawUpdatedRow.branch).toBe('feature/auth')
    expect(rawUpdatedRow.pinned).toBe(1)
  })

  it('reconciles subagents list on parent session update, deleting removed subagents', async () => {
    const parentId = 'parent-reconcile-sess'
    const agent1 = {
      id: 'agent-reconcile-1',
      name: 'Worker 1',
      parentSessionId: parentId,
      sessionId: 'child-rec-1',
      status: 'completed',
    }
    const agent2 = {
      id: 'agent-reconcile-2',
      name: 'Worker 2',
      parentSessionId: parentId,
      sessionId: 'child-rec-2',
      status: 'running',
    }

    // 1. Initial save with 2 subagents
    await service.set(parentId, {
      id: parentId,
      version: 2,
      entries: [{ id: 'pe1', kind: 'user', content: [] }],
      subAgents: [agent1, agent2],
    })

    const db = service.getDb()
    let rawSubAgents = db.prepare('SELECT id FROM subagents WHERE parent_session_id = ?').all(parentId) as any[]
    expect(rawSubAgents).toHaveLength(2)

    let parentData = await service.get(parentId)
    expect(parentData?.subAgents).toHaveLength(2)

    // 2. Update with only agent1 (agent2 removed)
    await service.set(parentId, {
      id: parentId,
      version: 2,
      entries: [{ id: 'pe1', kind: 'user', content: [] }],
      subAgents: [agent1],
    })

    rawSubAgents = db.prepare('SELECT id FROM subagents WHERE parent_session_id = ?').all(parentId) as any[]
    expect(rawSubAgents).toHaveLength(1)
    expect(rawSubAgents[0].id).toBe('agent-reconcile-1')

    parentData = await service.get(parentId)
    expect(parentData?.subAgents).toHaveLength(1)
    expect(parentData?.subAgents?.[0].id).toBe('agent-reconcile-1')

    // 3. Update without specifying subAgents (undefined) - should keep existing agent1
    await service.set(parentId, {
      id: parentId,
      version: 2,
      entries: [{ id: 'pe1', kind: 'user', content: [] }, { id: 'pe2', kind: 'assistant', content: [] }],
    })

    rawSubAgents = db.prepare('SELECT id FROM subagents WHERE parent_session_id = ?').all(parentId) as any[]
    expect(rawSubAgents).toHaveLength(1)
    expect(rawSubAgents[0].id).toBe('agent-reconcile-1')

    // 4. Update with empty subAgents array - should delete all subagents for this parent
    await service.set(parentId, {
      id: parentId,
      version: 2,
      entries: [{ id: 'pe1', kind: 'user', content: [] }],
      subAgents: [],
    })

    rawSubAgents = db.prepare('SELECT id FROM subagents WHERE parent_session_id = ?').all(parentId) as any[]
    expect(rawSubAgents).toHaveLength(0)

    parentData = await service.get(parentId)
    expect(parentData?.subAgents).toBeUndefined()
  })

  it('asserts exact entry count and idempotency after multiple set() calls with identical or updated entries', async () => {
    const sessId = 'sess-idempotency-test'
    const db = service.getDb()

    const makeEntries = (count: number) =>
      Array.from({ length: count }, (_, idx) => ({
        id: `entry-${idx + 1}`,
        kind: idx % 2 === 0 ? 'user' : 'assistant',
        content: [{ type: 'text', text: `Message index ${idx}` }],
      }))

    // 1. Initial write with 3 entries
    await service.set(sessId, makeEntries(3))
    let countRow = db.prepare('SELECT COUNT(*) as c FROM session_entries WHERE session_id = ?').get(sessId) as any
    expect(countRow.c).toBe(3)
    let fetched = await service.get(sessId)
    expect(fetched?.entries).toHaveLength(3)

    // 2. Rewrite identical 3 entries (idempotent)
    await service.set(sessId, makeEntries(3))
    countRow = db.prepare('SELECT COUNT(*) as c FROM session_entries WHERE session_id = ?').get(sessId) as any
    expect(countRow.c).toBe(3)
    fetched = await service.get(sessId)
    expect(fetched?.entries).toHaveLength(3)

    // 3. Upsert with 5 entries
    await service.set(sessId, {
      id: sessId,
      version: 2,
      entries: makeEntries(5),
    })
    countRow = db.prepare('SELECT COUNT(*) as c FROM session_entries WHERE session_id = ?').get(sessId) as any
    expect(countRow.c).toBe(5)
    fetched = await service.get(sessId)
    expect(fetched?.entries).toHaveLength(5)

    // Verify ordering by entry_index
    const entryIndices = db
      .prepare('SELECT entry_index FROM session_entries WHERE session_id = ? ORDER BY entry_index ASC')
      .all(sessId)
      .map((r: any) => r.entry_index)
    expect(entryIndices).toEqual([0, 1, 2, 3, 4])

    // 4. Shrink entries to 2
    await service.set(sessId, makeEntries(2))
    countRow = db.prepare('SELECT COUNT(*) as c FROM session_entries WHERE session_id = ?').get(sessId) as any
    expect(countRow.c).toBe(2)
    fetched = await service.get(sessId)
    expect(fetched?.entries).toHaveLength(2)
  })

  it('handles invalid / empty inputs gracefully', async () => {
    expect(await service.get('')).toBeNull()
    expect(await service.get(null as any)).toBeNull()
    expect(await service.get(undefined as any)).toBeNull()

    await service.set('', [])
    await service.set(null as any, [])
    await service.delete('')
    await service.delete(null as any)

    expect(await service.list()).toEqual([])
  })

  it('accurately extracts conversation turns with tokens, cost, duration, and metadata', async () => {
    const sessionId = 'sess-turns-test'
    const projectId = 'proj-analytics-1'
    const db = service.getDb()

    const entries = [
      // Turn 1: Starts with User Entry u1
      {
        id: 'u1',
        kind: 'user',
        createdAt: 1000,
        content: [{ type: 'text', text: 'Refactor the database module' }],
      },
      // Assistant step 1 (calling tool)
      {
        id: 'a1',
        kind: 'assistant',
        createdAt: 1200,
        completedAt: 1500,
        model: 'claude-3-5-sonnet',
        status: 'done',
        content: [{ type: 'text', text: 'Let me inspect the file first.' }],
        usage: {
          input: 100,
          output: 50,
          cacheRead: 20,
          cacheWrite: 10,
          reasoning: 5,
          totalTokens: 150,
          cost: {
            input: 0.001,
            output: 0.002,
            cacheRead: 0.0001,
            cacheWrite: 0.0002,
            total: 0.0033,
          },
        },
      },
      // Tool result
      {
        id: 'tr1',
        kind: 'toolResult',
        toolCallId: 'tc1',
        toolName: 'read',
        createdAt: 1600,
        content: [{ type: 'text', text: 'file content' }],
      },
      // Assistant step 2 (final answer for Turn 1)
      {
        id: 'a2',
        kind: 'assistant',
        createdAt: 1700,
        completedAt: 2500,
        model: 'claude-3-5-sonnet',
        status: 'done',
        content: [{ type: 'text', text: 'Database refactoring complete.' }],
        usage: {
          input: 200,
          output: 100,
          cacheRead: 30,
          cacheWrite: 0,
          reasoning: 10,
          totalTokens: 300,
          cost: {
            input: 0.002,
            output: 0.004,
            cacheRead: 0.00015,
            cacheWrite: 0.0,
            total: 0.00615,
          },
        },
      },
      // Turn 2: Starts with User Entry u2
      {
        id: 'u2',
        kind: 'user',
        createdAt: 4000,
        content: [{ type: 'text', text: 'Run the tests now' }],
      },
      // Assistant for Turn 2 (with error status and reasoning effort)
      {
        id: 'a3',
        kind: 'assistant',
        createdAt: 4200,
        completedAt: 5500,
        model: 'gpt-4o',
        reasoningEffort: 'high',
        status: 'error',
        content: [{ type: 'text', text: 'Test execution failed.' }],
        usage: {
          input: 80,
          output: 40,
          cacheRead: 0,
          cacheWrite: 0,
          reasoning: 0,
          totalTokens: 120,
          cost: {
            input: 0.0008,
            output: 0.0016,
            cacheRead: 0.0,
            cacheWrite: 0.0,
            total: 0.0024,
          },
        },
      },
    ]

    await service.set(sessionId, {
      id: sessionId,
      version: 2,
      entries,
      projectId,
      speed: 'fast',
    })

    const turns = db
      .prepare(
        'SELECT * FROM conversation_turns WHERE session_id = ? ORDER BY started_at ASC',
      )
      .all(sessionId) as any[]

    expect(turns).toHaveLength(2)

    // Verify Turn 1
    const t1 = turns[0]
    expect(t1.id).toBe('u1')
    expect(t1.session_id).toBe(sessionId)
    expect(t1.project_id).toBe(projectId)
    expect(t1.is_subagent).toBe(0)
    expect(t1.model_id).toBe('claude-3-5-sonnet')
    expect(t1.speed).toBe('fast')
    expect(t1.started_at).toBe(1000)
    expect(t1.completed_at).toBe(2500)
    expect(t1.duration_ms).toBe(1500)
    expect(t1.status).toBe('done')

    // Turn 1 Token Sums: (100+200), (50+100), (20+30), (10+0), (5+10), (150+300)
    expect(t1.tokens_input).toBe(300)
    expect(t1.tokens_output).toBe(150)
    expect(t1.tokens_cache_read).toBe(50)
    expect(t1.tokens_cache_write).toBe(10)
    expect(t1.tokens_reasoning).toBe(15)
    expect(t1.tokens_total).toBe(450)

    // Turn 1 Cost Sums
    expect(t1.cost_input).toBeCloseTo(0.003)
    expect(t1.cost_output).toBeCloseTo(0.006)
    expect(t1.cost_cache_read).toBeCloseTo(0.00025)
    expect(t1.cost_cache_write).toBeCloseTo(0.0002)
    expect(t1.cost_total).toBeCloseTo(0.00945)

    // Verify Turn 2
    const t2 = turns[1]
    expect(t2.id).toBe('u2')
    expect(t2.session_id).toBe(sessionId)
    expect(t2.project_id).toBe(projectId)
    expect(t2.model_id).toBe('gpt-4o')
    expect(t2.reasoning_effort).toBe('high')
    expect(t2.started_at).toBe(4000)
    expect(t2.completed_at).toBe(5500)
    expect(t2.duration_ms).toBe(1500)
    expect(t2.status).toBe('error')
    expect(t2.tokens_input).toBe(80)
    expect(t2.tokens_output).toBe(40)
    expect(t2.tokens_total).toBe(120)
    expect(t2.cost_total).toBeCloseTo(0.0024)
  })

  it('extracts and deduplicates skill invocations from user text and assistant tool calls', async () => {
    const sessionId = 'sess-skills-test'
    const projectId = 'proj-skills-2'
    const db = service.getDb()

    const entries = [
      // Turn 1: User invokes $gh-issue and /skill:fix-issue
      {
        id: 'u-skill-1',
        kind: 'user',
        createdAt: 2000,
        content: [
          {
            type: 'text',
            text: 'Please run $gh-issue 1234 and also /skill:fix-issue with budget $100',
          },
        ],
      },
      // Assistant calls read on /skills/gh-issue/SKILL.md (should deduplicate with $gh-issue)
      // and read on .cpa/skills/capacity/SKILL.md (new skill)
      {
        id: 'a-skill-1',
        kind: 'assistant',
        createdAt: 2200,
        completedAt: 3000,
        model: 'claude-3-5-sonnet',
        status: 'done',
        content: [
          {
            type: 'toolCall',
            id: 'tc-read-1',
            name: 'read',
            arguments: { path: '/Users/luis/.coding-professional-agent/skills/gh-issue/SKILL.md' },
          },
          {
            type: 'toolCall',
            id: 'tc-read-2',
            name: 'read',
            arguments: { path: '/workspace/.cpa/skills/capacity/SKILL.md' },
          },
          {
            type: 'toolCall',
            id: 'tc-read-3',
            name: 'read',
            arguments: { path: '/workspace/src/index.ts' }, // non-skill file
          },
        ],
      },
      // Turn 2: User invokes $deploy-service and assistant reads skills/deploy-service.md
      {
        id: 'u-skill-2',
        kind: 'user',
        createdAt: 5000,
        content: [{ type: 'text', text: 'Now test $deploy-service' }],
      },
      {
        id: 'a-skill-2',
        kind: 'assistant',
        createdAt: 5200,
        completedAt: 6000,
        model: 'gpt-4o',
        status: 'done',
        content: [
          {
            type: 'tool_call',
            id: 'tc-read-4',
            name: 'read',
            arguments: { path: '/skills/deploy-service.md' },
          },
        ],
      },
    ]

    await service.set(sessionId, {
      id: sessionId,
      version: 2,
      entries,
      projectId,
    })

    const skillRows = db
      .prepare(
        'SELECT * FROM skill_invocations WHERE session_id = ? ORDER BY invoked_at ASC, skill_name ASC',
      )
      .all(sessionId) as any[]

    // Turn 1 should have 3 deduplicated skills: gh-issue, fix-issue, capacity ($100 ignored as currency)
    // Turn 2 should have 1 deduplicated skill: deploy-service
    expect(skillRows).toHaveLength(4)

    const turn1Skills = skillRows.filter((r) => r.turn_id === 'u-skill-1')
    expect(turn1Skills).toHaveLength(3)
    const turn1Names = turn1Skills.map((r) => r.skill_name).sort()
    expect(turn1Names).toEqual(['capacity', 'fix-issue', 'gh-issue'])

    for (const r of turn1Skills) {
      expect(r.session_id).toBe(sessionId)
      expect(r.project_id).toBe(projectId)
      expect(r.model_id).toBe('claude-3-5-sonnet')
      expect(r.invoked_at).toBe(2000)
    }

    const turn2Skills = skillRows.filter((r) => r.turn_id === 'u-skill-2')
    expect(turn2Skills).toHaveLength(1)
    expect(turn2Skills[0].skill_name).toBe('deploy-service')
    expect(turn2Skills[0].model_id).toBe('gpt-4o')
    expect(turn2Skills[0].invoked_at).toBe(5000)
  })

  it('replaces turns and skills idempotently when session is updated or truncated', async () => {
    const sessionId = 'sess-idempotent-turns'
    const db = service.getDb()

    const turn1Entries = [
      {
        id: 't1-user',
        kind: 'user',
        createdAt: 1000,
        content: [{ type: 'text', text: 'Step 1 $gh-issue' }],
      },
      {
        id: 't1-asst',
        kind: 'assistant',
        createdAt: 1200,
        completedAt: 1500,
        model: 'gpt-4o',
        status: 'done',
        usage: { input: 10, output: 20, totalTokens: 30, cost: { input: 0.0001, output: 0.0002, total: 0.0003 } },
      },
    ]

    // 1. Initial save: 1 turn, 1 skill
    await service.set(sessionId, {
      id: sessionId,
      version: 2,
      entries: turn1Entries,
    })

    let turns = db.prepare('SELECT * FROM conversation_turns WHERE session_id = ?').all(sessionId)
    let skills = db.prepare('SELECT * FROM skill_invocations WHERE session_id = ?').all(sessionId)
    expect(turns).toHaveLength(1)
    expect(skills).toHaveLength(1)

    // 2. Add Turn 2: 2 turns, 2 skills
    const turn2Entries = [
      ...turn1Entries,
      {
        id: 't2-user',
        kind: 'user',
        createdAt: 2000,
        content: [{ type: 'text', text: 'Step 2 /skill:fix-issue' }],
      },
      {
        id: 't2-asst',
        kind: 'assistant',
        createdAt: 2200,
        completedAt: 2600,
        model: 'gpt-4o',
        status: 'done',
        usage: { input: 30, output: 40, totalTokens: 70, cost: { input: 0.0003, output: 0.0004, total: 0.0007 } },
      },
    ]

    await service.set(sessionId, {
      id: sessionId,
      version: 2,
      entries: turn2Entries,
    })

    turns = db.prepare('SELECT * FROM conversation_turns WHERE session_id = ?').all(sessionId)
    skills = db.prepare('SELECT * FROM skill_invocations WHERE session_id = ?').all(sessionId)
    expect(turns).toHaveLength(2)
    expect(skills).toHaveLength(2)

    // 3. Truncate back to Turn 1: 1 turn, 1 skill (no orphaned Turn 2 rows)
    await service.set(sessionId, {
      id: sessionId,
      version: 2,
      entries: turn1Entries,
    })

    turns = db.prepare('SELECT * FROM conversation_turns WHERE session_id = ?').all(sessionId)
    skills = db.prepare('SELECT * FROM skill_invocations WHERE session_id = ?').all(sessionId)
    expect(turns).toHaveLength(1)
    expect((turns[0] as any).id).toBe('t1-user')
    expect(skills).toHaveLength(1)
    expect((skills[0] as any).skill_name).toBe('gh-issue')
  })

  it('populates is_subagent and parent_session_id on conversation_turns for subagent sessions', async () => {
    const parentId = 'main-sess-parent'
    const childId = 'child-subagent-sess'
    const db = service.getDb()

    // 1. Create parent session
    await service.set(parentId, {
      id: parentId,
      version: 2,
      entries: [{ id: 'p-u1', kind: 'user', createdAt: 1000, content: [{ type: 'text', text: 'main prompt' }] }],
      projectId: 'proj-sub',
    })

    // 2. Create child subagent session
    await service.set(childId, {
      id: childId,
      version: 2,
      entries: [
        { id: 'c-u1', kind: 'user', createdAt: 2000, content: [{ type: 'text', text: 'subagent prompt' }] },
        { id: 'c-a1', kind: 'assistant', createdAt: 2100, completedAt: 2500, model: 'gpt-4o-mini', status: 'done' },
      ],
      parentSessionId: parentId,
      isSubagent: true,
      projectId: 'proj-sub',
    })

    const childTurn = db
      .prepare('SELECT * FROM conversation_turns WHERE session_id = ?')
      .get(childId) as any

    expect(childTurn).toBeDefined()
    expect(childTurn.id).toBe('c-u1')
    expect(childTurn.session_id).toBe(childId)
    expect(childTurn.parent_session_id).toBe(parentId)
    expect(childTurn.is_subagent).toBe(1)
    expect(childTurn.project_id).toBe('proj-sub')
    expect(childTurn.model_id).toBe('gpt-4o-mini')
  })

  it('queryMetrics returns zeroed summary and handles buckets on empty database', async () => {
    // 1. Default query with no arguments
    const defaultRes = await service.queryMetrics()
    expect(defaultRes).toBeDefined()
    expect(defaultRes.summary.totalChats).toBe(0)
    expect(defaultRes.summary.totalTokens).toBe(0)
    expect(defaultRes.summary.totalTokensBreakdown).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
    })
    expect(defaultRes.summary.totalCost).toBe(0)
    expect(defaultRes.summary.maxTaskDurationMs).toBe(0)
    expect(defaultRes.summary.currentStreakDays).toBe(0)
    expect(defaultRes.summary.longestStreakDays).toBe(0)
    expect(defaultRes.summary.fastMode).toEqual({ count: 0, percentage: 0 })
    expect(defaultRes.summary.topReasoningEffort).toBeNull()
    expect(defaultRes.summary.uniqueSkillsCount).toBe(0)
    expect(defaultRes.summary.totalSkillInvocations).toBe(0)
    expect(defaultRes.summary.topSkills).toEqual([])
    expect(defaultRes.buckets).toBeUndefined()

    // 2. Explicit 'all' granularity
    const allRes = await service.queryMetrics({ timeGranularity: 'all' })
    expect(allRes.summary.totalChats).toBe(0)
    expect(allRes.buckets).toBeUndefined()

    // 3. Specific time granularity ('day', 'hour', etc.) on empty DB returns empty buckets array
    const dayRes = await service.queryMetrics({ timeGranularity: 'day' })
    expect(dayRes.summary.totalChats).toBe(0)
    expect(dayRes.buckets).toEqual([])
  })

  it('queryMetrics calculates all 11 core metrics across multiple sessions and turns with all granularity', async () => {
    // Session 1: 2 turns
    await service.set('sess-agg-1', {
      id: 'sess-agg-1',
      version: 2,
      speed: 'fast',
      reasoningEffort: 'high',
      entries: [
        // Turn 1
        {
          id: 'u1',
          kind: 'user',
          createdAt: 1000,
          content: [{ type: 'text', text: 'Analyze $gh-issue and /skill:fix-issue' }],
        },
        {
          id: 'a1',
          kind: 'assistant',
          createdAt: 1200,
          completedAt: 3000,
          model: 'gpt-4o',
          status: 'done',
          usage: {
            input: 100,
            output: 50,
            cacheRead: 20,
            cacheWrite: 10,
            reasoning: 5,
            totalTokens: 150,
            cost: {
              input: 0.001,
              output: 0.002,
              cacheRead: 0.0001,
              cacheWrite: 0.0002,
              total: 0.0033,
            },
          },
        },
        // Turn 2
        {
          id: 'u2',
          kind: 'user',
          createdAt: 4000,
          content: [{ type: 'text', text: 'Second step' }],
        },
        {
          id: 'a2',
          kind: 'assistant',
          createdAt: 4500,
          completedAt: 7500,
          model: 'claude-3-5-sonnet',
          status: 'done',
          usage: {
            input: 200,
            output: 100,
            cacheRead: 0,
            cacheWrite: 0,
            reasoning: 0,
            totalTokens: 300,
            cost: {
              input: 0.003,
              output: 0.006,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0.009,
            },
          },
        },
      ],
    })

    // Session 2: 1 turn with standard speed, low reasoning effort, and skill tool calls
    await service.set('sess-agg-2', {
      id: 'sess-agg-2',
      version: 2,
      speed: 'standard',
      reasoningEffort: 'low',
      entries: [
        // Turn 3
        {
          id: 'u3',
          kind: 'user',
          createdAt: 10000,
          content: [{ type: 'text', text: 'Deploy service' }],
        },
        {
          id: 'a3',
          kind: 'assistant',
          createdAt: 10200,
          completedAt: 11000,
          model: 'gpt-4o-mini',
          status: 'done',
          usage: {
            input: 50,
            output: 50,
            cacheRead: 0,
            cacheWrite: 0,
            reasoning: 0,
            totalTokens: 100,
            cost: {
              input: 0.0005,
              output: 0.0005,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0.001,
            },
          },
          toolCalls: [
            {
              id: 'tc1',
              name: 'read',
              args: { path: '/skills/fix-issue/SKILL.md' },
            },
            {
              id: 'tc2',
              name: 'read',
              args: { path: '/skills/deploy/SKILL.md' },
            },
          ],
        },
      ],
    })

    const res = await service.queryMetrics()

    // 1. Total tokens: 150 + 300 + 100 = 550
    expect(res.summary.totalTokens).toBe(550)
    expect(res.summary.totalTokensBreakdown).toEqual({
      input: 350,
      output: 200,
      cacheRead: 20,
      cacheWrite: 10,
      reasoning: 5,
    })

    // 2. Total cost: 0.0033 + 0.009 + 0.001 = 0.0133
    expect(res.summary.totalCost).toBeCloseTo(0.0133, 5)

    // 3. Max task duration: max(2000, 3500, 1000) = 3500 ms
    expect(res.summary.maxTaskDurationMs).toBe(3500)

    // 4. Fast mode: 2 turns fast, 1 turn standard -> 2 / 3 = 66.67%
    expect(res.summary.fastMode.count).toBe(2)
    expect(res.summary.fastMode.percentage).toBe(66.67)

    // 5. Top reasoning effort: 2 turns 'high', 1 turn 'low' -> high (66.67%)
    expect(res.summary.topReasoningEffort).toEqual({
      level: 'high',
      count: 2,
      percentage: 66.67,
    })

    // 6. Total chats: 3
    expect(res.summary.totalChats).toBe(3)

    // 7. Skills: gh-issue (1), fix-issue (2), deploy (1) -> 3 unique, 4 total
    expect(res.summary.uniqueSkillsCount).toBe(3)
    expect(res.summary.totalSkillInvocations).toBe(4)
    expect(res.summary.topSkills).toEqual([
      { name: 'fix-issue', count: 2 },
      { name: 'deploy', count: 1 },
      { name: 'gh-issue', count: 1 },
    ])

    // 8. Buckets should be undefined for 'all'
    expect(res.buckets).toBeUndefined()
  })

  it('queryMetrics accurately calculates time granularities (minute, hour, day, week, month, year)', async () => {
    // Generate timestamps with predictable calendar boundaries
    // Local date timestamps:
    // T1: 2026-01-15 10:05:00
    // T2: 2026-01-15 10:45:00
    // T3: 2026-01-16 14:00:00
    // T4: 2026-06-20 08:00:00
    // T5: 2027-03-10 12:00:00
    const t1 = new Date(2026, 0, 15, 10, 5, 0).getTime()
    const t2 = new Date(2026, 0, 15, 10, 45, 0).getTime()
    const t3 = new Date(2026, 0, 16, 14, 0, 0).getTime()
    const t4 = new Date(2026, 5, 20, 8, 0, 0).getTime()
    const t5 = new Date(2027, 2, 10, 12, 0, 0).getTime()

    const makeTurnEntry = (id: string, startTime: number, duration: number, skillName: string) => [
      {
        id: `u-${id}`,
        kind: 'user',
        createdAt: startTime,
        content: [{ type: 'text', text: `Prompt for ${id} $${skillName}` }],
      },
      {
        id: `a-${id}`,
        kind: 'assistant',
        createdAt: startTime + 100,
        completedAt: startTime + duration,
        model: 'gpt-4o',
        usage: { input: 10, output: 20, totalTokens: 30, cost: { input: 0.0001, output: 0.0002, total: 0.0003 } },
      },
    ]

    await service.set('sess-gran-1', {
      id: 'sess-gran-1',
      version: 2,
      entries: [
        ...makeTurnEntry('t1', t1, 1000, 'skill-a'),
        ...makeTurnEntry('t2', t2, 2000, 'skill-b'),
        ...makeTurnEntry('t3', t3, 1500, 'skill-a'),
        ...makeTurnEntry('t4', t4, 1200, 'skill-c'),
        ...makeTurnEntry('t5', t5, 3000, 'skill-d'),
      ],
    })

    // 1. Granularity: 'minute' -> 5 distinct minute buckets
    const minuteRes = await service.queryMetrics({ timeGranularity: 'minute' })
    expect(minuteRes.buckets).toBeDefined()
    expect(minuteRes.buckets).toHaveLength(5)
    for (const b of minuteRes.buckets!) {
      expect(b.bucketKey).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
      expect(b.metrics.totalChats).toBe(1)
      expect(b.metrics.totalTokens).toBe(30)
      expect(b.startTimeMs).toBeGreaterThan(0)
      expect(b.endTimeMs).toBeGreaterThanOrEqual(b.startTimeMs)
    }

    // 2. Granularity: 'hour' -> 4 buckets (t1 and t2 share 2026-01-15 10:00)
    const hourRes = await service.queryMetrics({ timeGranularity: 'hour' })
    expect(hourRes.buckets).toBeDefined()
    expect(hourRes.buckets).toHaveLength(4)
    const firstHourBucket = hourRes.buckets![0]
    expect(firstHourBucket.bucketKey).toMatch(/^\d{4}-\d{2}-\d{2} 10:00$/)
    expect(firstHourBucket.metrics.totalChats).toBe(2)
    expect(firstHourBucket.metrics.totalTokens).toBe(60)
    expect(firstHourBucket.metrics.maxTaskDurationMs).toBe(2000)
    expect(firstHourBucket.startTimeMs).toBe(t1)
    expect(firstHourBucket.endTimeMs).toBe(t2 + 2000)

    // 3. Granularity: 'day' -> 4 buckets (t1 and t2 share 2026-01-15)
    const dayRes = await service.queryMetrics({ timeGranularity: 'day' })
    expect(dayRes.buckets).toBeDefined()
    expect(dayRes.buckets).toHaveLength(4)
    expect(dayRes.buckets![0].metrics.totalChats).toBe(2)
    expect(dayRes.buckets![1].metrics.totalChats).toBe(1)
    expect(dayRes.buckets![0].bucketKey).toBe('2026-01-15')
    expect(dayRes.buckets![1].bucketKey).toBe('2026-01-16')

    // 4. Granularity: 'week' -> verify W%W pattern
    const weekRes = await service.queryMetrics({ timeGranularity: 'week' })
    expect(weekRes.buckets).toBeDefined()
    for (const b of weekRes.buckets!) {
      expect(b.bucketKey).toMatch(/^\d{4}-W\d{2}$/)
    }

    // 5. Granularity: 'month' -> 3 buckets (2026-01, 2026-06, 2027-03)
    const monthRes = await service.queryMetrics({ timeGranularity: 'month' })
    expect(monthRes.buckets).toBeDefined()
    expect(monthRes.buckets).toHaveLength(3)
    expect(monthRes.buckets![0].bucketKey).toBe('2026-01')
    expect(monthRes.buckets![0].metrics.totalChats).toBe(3) // t1, t2, t3
    expect(monthRes.buckets![1].bucketKey).toBe('2026-06')
    expect(monthRes.buckets![1].metrics.totalChats).toBe(1) // t4
    expect(monthRes.buckets![2].bucketKey).toBe('2027-03')
    expect(monthRes.buckets![2].metrics.totalChats).toBe(1) // t5

    // 6. Granularity: 'year' -> 2 buckets (2026, 2027)
    const yearRes = await service.queryMetrics({ timeGranularity: 'year' })
    expect(yearRes.buckets).toBeDefined()
    expect(yearRes.buckets).toHaveLength(2)
    expect(yearRes.buckets![0].bucketKey).toBe('2026')
    expect(yearRes.buckets![0].metrics.totalChats).toBe(4) // t1, t2, t3, t4
    expect(yearRes.buckets![1].bucketKey).toBe('2027')
    expect(yearRes.buckets![1].metrics.totalChats).toBe(1) // t5
  })

  it('queryMetrics accurately calculates current and longest active day streaks', async () => {
    const now = new Date()
    const getPastDate = (daysAgo: number) => {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, 12, 0, 0)
      return d.getTime()
    }

    const makeSingleTurnEntry = (id: string, timestamp: number) => ({
      id: `sess-streak-${id}`,
      version: 2,
      entries: [
        {
          id: `u-${id}`,
          kind: 'user',
          createdAt: timestamp,
          content: [{ type: 'text', text: `Prompt at ${id}` }],
        },
        {
          id: `a-${id}`,
          kind: 'assistant',
          createdAt: timestamp + 100,
          completedAt: timestamp + 500,
          model: 'gpt-4o',
          usage: { input: 10, output: 10, totalTokens: 20 },
        },
      ],
    })

    // Scenario 1: 3 consecutive days ending today (daysAgo: 2, 1, 0)
    await service.set('sess-s1-d0', makeSingleTurnEntry('s1-d0', getPastDate(0)))
    await service.set('sess-s1-d1', makeSingleTurnEntry('s1-d1', getPastDate(1)))
    await service.set('sess-s1-d2', makeSingleTurnEntry('s1-d2', getPastDate(2)))

    let streakRes = await service.queryMetrics()
    expect(streakRes.summary.currentStreakDays).toBe(3)
    expect(streakRes.summary.longestStreakDays).toBe(3)

    // Clean DB
    await service.delete('sess-s1-d0')
    await service.delete('sess-s1-d1')
    await service.delete('sess-s1-d2')

    // Scenario 2: 3 consecutive days ending yesterday (daysAgo: 3, 2, 1, no activity today)
    await service.set('sess-s2-d1', makeSingleTurnEntry('s2-d1', getPastDate(1)))
    await service.set('sess-s2-d2', makeSingleTurnEntry('s2-d2', getPastDate(2)))
    await service.set('sess-s2-d3', makeSingleTurnEntry('s2-d3', getPastDate(3)))

    streakRes = await service.queryMetrics()
    expect(streakRes.summary.currentStreakDays).toBe(3)
    expect(streakRes.summary.longestStreakDays).toBe(3)

    // Clean DB
    await service.delete('sess-s2-d1')
    await service.delete('sess-s2-d2')
    await service.delete('sess-s2-d3')

    // Scenario 3: 3 consecutive days broken 5 days ago (daysAgo: 7, 6, 5)
    await service.set('sess-s3-d5', makeSingleTurnEntry('s3-d5', getPastDate(5)))
    await service.set('sess-s3-d6', makeSingleTurnEntry('s3-d6', getPastDate(6)))
    await service.set('sess-s3-d7', makeSingleTurnEntry('s3-d7', getPastDate(7)))

    streakRes = await service.queryMetrics()
    expect(streakRes.summary.currentStreakDays).toBe(0) // Broken streak
    expect(streakRes.summary.longestStreakDays).toBe(3)

    // Scenario 4: Historical 4-day streak, gap, then 2-day streak ending today
    // Historical: daysAgo 23, 22, 21, 20 (4 days)
    // Recent: daysAgo 1, 0 (2 days)
    await service.set('sess-s4-d20', makeSingleTurnEntry('s4-d20', getPastDate(20)))
    await service.set('sess-s4-d21', makeSingleTurnEntry('s4-d21', getPastDate(21)))
    await service.set('sess-s4-d22', makeSingleTurnEntry('s4-d22', getPastDate(22)))
    await service.set('sess-s4-d23', makeSingleTurnEntry('s4-d23', getPastDate(23)))
    await service.set('sess-s4-d1', makeSingleTurnEntry('s4-d1', getPastDate(1)))
    await service.set('sess-s4-d0', makeSingleTurnEntry('s4-d0', getPastDate(0)))

    streakRes = await service.queryMetrics()
    expect(streakRes.summary.currentStreakDays).toBe(2)
    expect(streakRes.summary.longestStreakDays).toBe(4)
  })

  it('queryMetrics filters turns and skills by timeRange', async () => {
    await service.set('sess-tr-1', {
      id: 'sess-tr-1',
      version: 2,
      entries: [
        // Turn at 1000
        {
          id: 'u-tr-1',
          kind: 'user',
          createdAt: 1000,
          content: [{ type: 'text', text: 'Prompt 1000 $skill-early' }],
        },
        {
          id: 'a-tr-1',
          kind: 'assistant',
          createdAt: 1100,
          completedAt: 1500,
          model: 'gpt-4o',
          usage: { input: 10, output: 10, totalTokens: 20 },
        },
        // Turn at 5000
        {
          id: 'u-tr-2',
          kind: 'user',
          createdAt: 5000,
          content: [{ type: 'text', text: 'Prompt 5000 $skill-target' }],
        },
        {
          id: 'a-tr-2',
          kind: 'assistant',
          createdAt: 5100,
          completedAt: 5800,
          model: 'gpt-4o',
          usage: { input: 30, output: 30, totalTokens: 60 },
        },
        // Turn at 9000
        {
          id: 'u-tr-3',
          kind: 'user',
          createdAt: 9000,
          content: [{ type: 'text', text: 'Prompt 9000 $skill-late' }],
        },
        {
          id: 'a-tr-3',
          kind: 'assistant',
          createdAt: 9100,
          completedAt: 9500,
          model: 'gpt-4o',
          usage: { input: 50, output: 50, totalTokens: 100 },
        },
      ],
    })

    // Filter range: [4000, 6000] -> only Turn 2 (at 5000) matches
    const filteredRes = await service.queryMetrics({ timeRange: [4000, 6000] })
    expect(filteredRes.summary.totalChats).toBe(1)
    expect(filteredRes.summary.totalTokens).toBe(60)
    expect(filteredRes.summary.uniqueSkillsCount).toBe(1)
    expect(filteredRes.summary.topSkills).toEqual([{ name: 'skill-target', count: 1 }])

    // Filter range: [12000, 20000] -> 0 matches
    const outOfRangeRes = await service.queryMetrics({ timeRange: [12000, 20000] })
    expect(outOfRangeRes.summary.totalChats).toBe(0)
    expect(outOfRangeRes.summary.totalTokens).toBe(0)
  })

  it('queryMetrics respects topSkillsLimit', async () => {
    // Seed 5 skills with distinct frequencies: sA (5), sB (4), sC (3), sD (2), sE (1)
    const skillsList = [
      ...Array(5).fill('skill-a'),
      ...Array(4).fill('skill-b'),
      ...Array(3).fill('skill-c'),
      ...Array(2).fill('skill-d'),
      ...Array(1).fill('skill-e'),
    ]

    const entries = skillsList.map((skill, idx) => ({
      id: `u-skill-lim-${idx}`,
      kind: 'user',
      createdAt: 1000 + idx * 100,
      content: [{ type: 'text', text: `Call $${skill}` }],
    }))

    await service.set('sess-skill-limit', {
      id: 'sess-skill-limit',
      version: 2,
      entries,
    })

    // 1. Default topSkillsLimit (10) -> returns all 5
    const defaultRes = await service.queryMetrics()
    expect(defaultRes.summary.topSkills).toHaveLength(5)
    expect(defaultRes.summary.topSkills[0]).toEqual({ name: 'skill-a', count: 5 })
    expect(defaultRes.summary.topSkills[1]).toEqual({ name: 'skill-b', count: 4 })

    // 2. Custom topSkillsLimit: 2 -> returns only top 2
    const limit2Res = await service.queryMetrics({ topSkillsLimit: 2 })
    expect(limit2Res.summary.topSkills).toHaveLength(2)
    expect(limit2Res.summary.topSkills).toEqual([
      { name: 'skill-a', count: 5 },
      { name: 'skill-b', count: 4 },
    ])
  })

  it('queryMetrics calculates topModels and respects topModelsLimit', async () => {
    // Model A: 3 turns, 3000 tokens
    // Model B: 2 turns, 5000 tokens
    // Model C: 1 turn, 1000 tokens
    for (let i = 0; i < 3; i++) {
      await service.set(`sess-mod-a-${i}`, {
        entries: [
          { id: `u-a-${i}`, kind: 'user', content: [{ type: 'text', text: 'hi' }] },
          {
            id: `a-a-${i}`,
            kind: 'assistant',
            model: 'model-a',
            usage: { input: 500, output: 500, totalTokens: 1000 },
          },
        ],
      })
    }
    for (let i = 0; i < 2; i++) {
      await service.set(`sess-mod-b-${i}`, {
        entries: [
          { id: `u-b-${i}`, kind: 'user', content: [{ type: 'text', text: 'hi' }] },
          {
            id: `a-b-${i}`,
            kind: 'assistant',
            model: 'model-b',
            usage: { input: 1250, output: 1250, totalTokens: 2500 },
          },
        ],
      })
    }
    await service.set('sess-mod-c-0', {
      entries: [
        { id: 'u-c-0', kind: 'user', content: [{ type: 'text', text: 'hi' }] },
        {
          id: 'a-c-0',
          kind: 'assistant',
          model: 'model-c',
          usage: { input: 500, output: 500, totalTokens: 1000 },
        },
      ],
    })

    const res = await service.queryMetrics()
    expect(res.summary.topModels).toBeDefined()
    expect(res.summary.topModels).toHaveLength(3)
    expect(res.summary.topModels![0]).toEqual({
      modelId: 'model-a',
      count: 3,
      totalTokens: 3000,
      percentage: 50,
    })
    expect(res.summary.topModels![1]).toEqual({
      modelId: 'model-b',
      count: 2,
      totalTokens: 5000,
      percentage: 33.3,
    })
    expect(res.summary.topModels![2]).toEqual({
      modelId: 'model-c',
      count: 1,
      totalTokens: 1000,
      percentage: 16.7,
    })

    const limit1Res = await service.queryMetrics({ topModelsLimit: 1 })
    expect(limit1Res.summary.topModels).toHaveLength(1)
    expect(limit1Res.summary.topModels![0].modelId).toBe('model-a')
  })

  it('queryMetrics groupByProject groups all metrics by projectId', async () => {
    // Project A: 2 turns, model gpt-4o, speed fast, skill fix-issue
    await service.set('sess-p-a', {
      id: 'sess-p-a',
      version: 2,
      projectId: 'proj-a',
      speed: 'fast',
      entries: [
        {
          id: 'u-pa-1',
          kind: 'user',
          createdAt: 1000,
          content: [{ type: 'text', text: 'Task in proj-a $fix-issue' }],
        },
        {
          id: 'a-pa-1',
          kind: 'assistant',
          createdAt: 1100,
          completedAt: 2000,
          model: 'gpt-4o',
          usage: { input: 100, output: 50, totalTokens: 150, cost: { input: 0.001, output: 0.002, total: 0.003 } },
        },
        {
          id: 'u-pa-2',
          kind: 'user',
          createdAt: 3000,
          content: [{ type: 'text', text: 'Second task in proj-a' }],
        },
        {
          id: 'a-pa-2',
          kind: 'assistant',
          createdAt: 3100,
          completedAt: 4500,
          model: 'gpt-4o',
          usage: { input: 50, output: 50, totalTokens: 100, cost: { input: 0.0005, output: 0.0005, total: 0.001 } },
        },
      ],
    })

    // Project B: 1 turn, model claude-3-5-sonnet, speed standard, skill gh-issue
    await service.set('sess-p-b', {
      id: 'sess-p-b',
      version: 2,
      projectId: 'proj-b',
      speed: 'standard',
      entries: [
        {
          id: 'u-pb-1',
          kind: 'user',
          createdAt: 6000,
          content: [{ type: 'text', text: 'Task in proj-b $gh-issue' }],
        },
        {
          id: 'a-pb-1',
          kind: 'assistant',
          createdAt: 6100,
          completedAt: 8000,
          model: 'claude-3-5-sonnet',
          usage: { input: 200, output: 100, totalTokens: 300, cost: { input: 0.002, output: 0.004, total: 0.006 } },
        },
      ],
    })

    const res = await service.queryMetrics({ groupByProject: true })

    expect(res.groups).toBeDefined()
    expect(res.groups).toHaveLength(2)

    // Group 1: proj-a
    const projAGroup = res.groups!.find((g) => g.groupKey === 'proj-a')
    expect(projAGroup).toBeDefined()
    expect(projAGroup!.summary.totalChats).toBe(2)
    expect(projAGroup!.summary.totalTokens).toBe(250)
    expect(projAGroup!.summary.totalCost).toBeCloseTo(0.004)
    expect(projAGroup!.summary.fastMode).toEqual({ count: 2, percentage: 100 })
    expect(projAGroup!.summary.uniqueSkillsCount).toBe(1)
    expect(projAGroup!.summary.topSkills).toEqual([{ name: 'fix-issue', count: 1 }])

    // Group 2: proj-b
    const projBGroup = res.groups!.find((g) => g.groupKey === 'proj-b')
    expect(projBGroup).toBeDefined()
    expect(projBGroup!.summary.totalChats).toBe(1)
    expect(projBGroup!.summary.totalTokens).toBe(300)
    expect(projBGroup!.summary.totalCost).toBeCloseTo(0.006)
    expect(projBGroup!.summary.fastMode).toEqual({ count: 0, percentage: 0 })
    expect(projBGroup!.summary.uniqueSkillsCount).toBe(1)
    expect(projBGroup!.summary.topSkills).toEqual([{ name: 'gh-issue', count: 1 }])

    // Overall summary still contains both
    expect(res.summary.totalChats).toBe(3)
    expect(res.summary.totalTokens).toBe(550)
    expect(res.summary.uniqueSkillsCount).toBe(2)
  })

  it('queryMetrics groupByModel groups all metrics by modelId', async () => {
    // Session with gpt-4o
    await service.set('sess-m-gpt', {
      id: 'sess-m-gpt',
      version: 2,
      entries: [
        {
          id: 'u-mg-1',
          kind: 'user',
          createdAt: 1000,
          content: [{ type: 'text', text: 'Chat 1 $model-skill-a' }],
        },
        {
          id: 'a-mg-1',
          kind: 'assistant',
          createdAt: 1100,
          completedAt: 2000,
          model: 'gpt-4o',
          usage: { input: 120, output: 80, totalTokens: 200, cost: { input: 0.001, output: 0.002, total: 0.003 } },
        },
      ],
    })

    // Session with claude-3-5-sonnet
    await service.set('sess-m-claude', {
      id: 'sess-m-claude',
      version: 2,
      entries: [
        {
          id: 'u-mc-1',
          kind: 'user',
          createdAt: 3000,
          content: [{ type: 'text', text: 'Chat 2 $model-skill-b' }],
        },
        {
          id: 'a-mc-1',
          kind: 'assistant',
          createdAt: 3100,
          completedAt: 5000,
          model: 'claude-3-5-sonnet',
          usage: { input: 240, output: 160, totalTokens: 400, cost: { input: 0.003, output: 0.005, total: 0.008 } },
        },
      ],
    })

    const res = await service.queryMetrics({ groupByModel: true })

    expect(res.groups).toBeDefined()
    expect(res.groups).toHaveLength(2)

    // claude-3-5-sonnet group
    const claudeGroup = res.groups!.find((g) => g.groupKey === 'claude-3-5-sonnet')
    expect(claudeGroup).toBeDefined()
    expect(claudeGroup!.summary.totalChats).toBe(1)
    expect(claudeGroup!.summary.totalTokens).toBe(400)
    expect(claudeGroup!.summary.totalCost).toBeCloseTo(0.008)
    expect(claudeGroup!.summary.topSkills).toEqual([{ name: 'model-skill-b', count: 1 }])

    // gpt-4o group
    const gptGroup = res.groups!.find((g) => g.groupKey === 'gpt-4o')
    expect(gptGroup).toBeDefined()
    expect(gptGroup!.summary.totalChats).toBe(1)
    expect(gptGroup!.summary.totalTokens).toBe(200)
    expect(gptGroup!.summary.totalCost).toBeCloseTo(0.003)
    expect(gptGroup!.summary.topSkills).toEqual([{ name: 'model-skill-a', count: 1 }])
  })

  it('queryMetrics filters strictly by projectId, modelId, and combined', async () => {
    // Session 1: proj-x with model-1
    await service.set('sess-p1-m1', {
      id: 'sess-p1-m1',
      version: 2,
      projectId: 'proj-x',
      entries: [
        {
          id: 'u-p1-m1',
          kind: 'user',
          createdAt: 1000,
          content: [{ type: 'text', text: 'Task 1 $skill-x1' }],
        },
        {
          id: 'a-p1-m1',
          kind: 'assistant',
          createdAt: 1100,
          completedAt: 1500,
          model: 'model-1',
          usage: { input: 10, output: 10, totalTokens: 20 },
        },
      ],
    })

    // Session 2: proj-x with model-2
    await service.set('sess-p1-m2', {
      id: 'sess-p1-m2',
      version: 2,
      projectId: 'proj-x',
      entries: [
        {
          id: 'u-p1-m2',
          kind: 'user',
          createdAt: 2000,
          content: [{ type: 'text', text: 'Task 2 $skill-x2' }],
        },
        {
          id: 'a-p1-m2',
          kind: 'assistant',
          createdAt: 2100,
          completedAt: 2500,
          model: 'model-2',
          usage: { input: 20, output: 20, totalTokens: 40 },
        },
      ],
    })

    // Session 3: proj-y with model-1
    await service.set('sess-p2-m1', {
      id: 'sess-p2-m1',
      version: 2,
      projectId: 'proj-y',
      entries: [
        {
          id: 'u-p2-m1',
          kind: 'user',
          createdAt: 3000,
          content: [{ type: 'text', text: 'Task 3 $skill-y1' }],
        },
        {
          id: 'a-p2-m1',
          kind: 'assistant',
          createdAt: 3100,
          completedAt: 3500,
          model: 'model-1',
          usage: { input: 30, output: 30, totalTokens: 60 },
        },
      ],
    })

    // 1. Filter by projectId: 'proj-x' -> matches Session 1 and 2
    const projXRes = await service.queryMetrics({ projectId: 'proj-x' })
    expect(projXRes.summary.totalChats).toBe(2)
    expect(projXRes.summary.totalTokens).toBe(60)
    expect(projXRes.summary.uniqueSkillsCount).toBe(2)

    // 2. Filter by modelId: 'model-1' -> matches Session 1 and 3
    const model1Res = await service.queryMetrics({ modelId: 'model-1' })
    expect(model1Res.summary.totalChats).toBe(2)
    expect(model1Res.summary.totalTokens).toBe(80)
    expect(model1Res.summary.uniqueSkillsCount).toBe(2)

    // 3. Filter by BOTH projectId: 'proj-x' AND modelId: 'model-1' -> matches only Session 1
    const combinedRes = await service.queryMetrics({ projectId: 'proj-x', modelId: 'model-1' })
    expect(combinedRes.summary.totalChats).toBe(1)
    expect(combinedRes.summary.totalTokens).toBe(20)
    expect(combinedRes.summary.uniqueSkillsCount).toBe(1)
    expect(combinedRes.summary.topSkills).toEqual([{ name: 'skill-x1', count: 1 }])

    // 4. Filter with non-matching combo -> returns 0
    const nonMatchRes = await service.queryMetrics({ projectId: 'proj-y', modelId: 'model-2' })
    expect(nonMatchRes.summary.totalChats).toBe(0)
    expect(nonMatchRes.summary.totalTokens).toBe(0)
  })

  it('subAgentMode supports rollup_all, main_only, subagent_only, and session_id isolation', async () => {
    const parentId = 'main-parent-session'
    const childId = 'child-subagent-session'
    const unrelatedId = 'unrelated-main-session'

    // 1. Parent session (main, is_subagent = 0)
    await service.set(parentId, {
      id: parentId,
      version: 2,
      entries: [
        {
          id: 'u-parent-1',
          kind: 'user',
          createdAt: 1000,
          content: [{ type: 'text', text: 'Main prompt $parent-skill' }],
        },
        {
          id: 'a-parent-1',
          kind: 'assistant',
          createdAt: 1100,
          completedAt: 1500,
          model: 'gpt-4o',
          usage: { input: 100, output: 50, totalTokens: 150 },
        },
      ],
      subAgents: [
        {
          id: 'subagent-record-1',
          sessionId: childId,
          parentSessionId: parentId,
          name: 'Child Subagent',
          status: 'completed',
        },
      ],
    })

    // 2. Child subagent session (subagent, is_subagent = 1, parent_session_id = parentId)
    await service.set(childId, {
      id: childId,
      version: 2,
      parentSessionId: parentId,
      isSubagent: true,
      entries: [
        {
          id: 'u-child-1',
          kind: 'user',
          createdAt: 2000,
          content: [{ type: 'text', text: 'Child prompt $child-skill' }],
        },
        {
          id: 'a-child-1',
          kind: 'assistant',
          createdAt: 2100,
          completedAt: 2600,
          model: 'gpt-4o-mini',
          usage: { input: 40, output: 20, totalTokens: 60 },
        },
      ],
    })

    // 3. Unrelated main session (main, is_subagent = 0)
    await service.set(unrelatedId, {
      id: unrelatedId,
      version: 2,
      entries: [
        {
          id: 'u-unrel-1',
          kind: 'user',
          createdAt: 3000,
          content: [{ type: 'text', text: 'Unrelated prompt $unrelated-skill' }],
        },
        {
          id: 'a-unrel-1',
          kind: 'assistant',
          createdAt: 3100,
          completedAt: 3800,
          model: 'claude-3-5-sonnet',
          usage: { input: 200, output: 100, totalTokens: 300 },
        },
      ],
    })

    // Case 1: default or 'rollup_all' -> all 3 sessions (150 + 60 + 300 = 510 tokens, 3 chats)
    const rollupRes = await service.queryMetrics({ subAgentMode: 'rollup_all' })
    expect(rollupRes.summary.totalChats).toBe(3)
    expect(rollupRes.summary.totalTokens).toBe(510)
    expect(rollupRes.summary.uniqueSkillsCount).toBe(3)

    // Case 2: 'main_only' -> only parent and unrelated sessions (150 + 300 = 450 tokens, 2 chats)
    const mainOnlyRes = await service.queryMetrics({ subAgentMode: 'main_only' })
    expect(mainOnlyRes.summary.totalChats).toBe(2)
    expect(mainOnlyRes.summary.totalTokens).toBe(450)
    expect(mainOnlyRes.summary.uniqueSkillsCount).toBe(2)
    const mainSkillNames = mainOnlyRes.summary.topSkills.map((s) => s.name).sort()
    expect(mainSkillNames).toEqual(['parent-skill', 'unrelated-skill'])

    // Case 3: 'subagent_only' -> only child subagent session (60 tokens, 1 chat)
    const subOnlyRes = await service.queryMetrics({ subAgentMode: 'subagent_only' })
    expect(subOnlyRes.summary.totalChats).toBe(1)
    expect(subOnlyRes.summary.totalTokens).toBe(60)
    expect(subOnlyRes.summary.uniqueSkillsCount).toBe(1)
    expect(subOnlyRes.summary.topSkills).toEqual([{ name: 'child-skill', count: 1 }])

    // Case 4: 'session_id' with sessionId: parentId -> rolls up parent + child subagent (150 + 60 = 210 tokens, 2 chats), excludes unrelated
    const sessionRes = await service.queryMetrics({ subAgentMode: 'session_id', sessionId: parentId })
    expect(sessionRes.summary.totalChats).toBe(2)
    expect(sessionRes.summary.totalTokens).toBe(210)
    expect(sessionRes.summary.uniqueSkillsCount).toBe(2)
    const sessionSkillNames = sessionRes.summary.topSkills.map((s) => s.name).sort()
    expect(sessionSkillNames).toEqual(['child-skill', 'parent-skill'])
  })

  it('populates granular buckets inside groups when timeGranularity is specified with groupByProject and groupByModel', async () => {
    // Generate timestamps on distinct days
    const day1 = new Date(2026, 4, 10, 10, 0, 0).getTime()
    const day2 = new Date(2026, 4, 11, 14, 0, 0).getTime()

    // Session 1: proj-alpha, model-x, day 1
    await service.set('sess-bg-1', {
      id: 'sess-bg-1',
      version: 2,
      projectId: 'proj-alpha',
      entries: [
        {
          id: 'u-bg-1',
          kind: 'user',
          createdAt: day1,
          content: [{ type: 'text', text: 'Day 1 task in alpha' }],
        },
        {
          id: 'a-bg-1',
          kind: 'assistant',
          createdAt: day1 + 100,
          completedAt: day1 + 1000,
          model: 'model-x',
          usage: { input: 10, output: 10, totalTokens: 20 },
        },
      ],
    })

    // Session 2: proj-alpha, model-x, day 2
    await service.set('sess-bg-2', {
      id: 'sess-bg-2',
      version: 2,
      projectId: 'proj-alpha',
      entries: [
        {
          id: 'u-bg-2',
          kind: 'user',
          createdAt: day2,
          content: [{ type: 'text', text: 'Day 2 task in alpha' }],
        },
        {
          id: 'a-bg-2',
          kind: 'assistant',
          createdAt: day2 + 100,
          completedAt: day2 + 1500,
          model: 'model-x',
          usage: { input: 30, output: 30, totalTokens: 60 },
        },
      ],
    })

    // Session 3: proj-beta, model-y, day 2
    await service.set('sess-bg-3', {
      id: 'sess-bg-3',
      version: 2,
      projectId: 'proj-beta',
      entries: [
        {
          id: 'u-bg-3',
          kind: 'user',
          createdAt: day2,
          content: [{ type: 'text', text: 'Day 2 task in beta' }],
        },
        {
          id: 'a-bg-3',
          kind: 'assistant',
          createdAt: day2 + 100,
          completedAt: day2 + 2000,
          model: 'model-y',
          usage: { input: 50, output: 50, totalTokens: 100 },
        },
      ],
    })

    // 1. groupByProject + day granularity
    const projBucketsRes = await service.queryMetrics({
      groupByProject: true,
      timeGranularity: 'day',
    })

    expect(projBucketsRes.groups).toBeDefined()
    expect(projBucketsRes.groups).toHaveLength(2)

    const alphaGroup = projBucketsRes.groups!.find((g) => g.groupKey === 'proj-alpha')
    expect(alphaGroup).toBeDefined()
    expect(alphaGroup!.buckets).toBeDefined()
    expect(alphaGroup!.buckets).toHaveLength(2) // 2026-05-10 and 2026-05-11
    expect(alphaGroup!.buckets![0].metrics.totalChats).toBe(1)
    expect(alphaGroup!.buckets![0].metrics.totalTokens).toBe(20)
    expect(alphaGroup!.buckets![1].metrics.totalChats).toBe(1)
    expect(alphaGroup!.buckets![1].metrics.totalTokens).toBe(60)

    const betaGroup = projBucketsRes.groups!.find((g) => g.groupKey === 'proj-beta')
    expect(betaGroup).toBeDefined()
    expect(betaGroup!.buckets).toBeDefined()
    expect(betaGroup!.buckets).toHaveLength(1) // only 2026-05-11
    expect(betaGroup!.buckets![0].metrics.totalChats).toBe(1)
    expect(betaGroup!.buckets![0].metrics.totalTokens).toBe(100)

    // 2. groupByModel + day granularity
    const modelBucketsRes = await service.queryMetrics({
      groupByModel: true,
      timeGranularity: 'day',
    })

    expect(modelBucketsRes.groups).toBeDefined()
    expect(modelBucketsRes.groups).toHaveLength(2)

    const modelXGroup = modelBucketsRes.groups!.find((g) => g.groupKey === 'model-x')
    expect(modelXGroup).toBeDefined()
    expect(modelXGroup!.buckets).toBeDefined()
    expect(modelXGroup!.buckets).toHaveLength(2)

    const modelYGroup = modelBucketsRes.groups!.find((g) => g.groupKey === 'model-y')
    expect(modelYGroup).toBeDefined()
    expect(modelYGroup!.buckets).toBeDefined()
    expect(modelYGroup!.buckets).toHaveLength(1)
  })

  it('groups unassigned projects and unknown models under default fallback keys', async () => {
    // Session without projectId and without model
    await service.set('sess-fallback-test', {
      id: 'sess-fallback-test',
      version: 2,
      entries: [
        {
          id: 'u-fb-1',
          kind: 'user',
          createdAt: 1000,
          content: [{ type: 'text', text: 'Fallback task' }],
        },
        {
          id: 'a-fb-1',
          kind: 'assistant',
          createdAt: 1100,
          completedAt: 1500,
          usage: { input: 15, output: 15, totalTokens: 30 },
        },
      ],
    })

    // 1. groupByProject -> 'unassigned'
    const projRes = await service.queryMetrics({ groupByProject: true })
    expect(projRes.groups).toBeDefined()
    expect(projRes.groups).toHaveLength(1)
    expect(projRes.groups![0].groupKey).toBe('unassigned')
    expect(projRes.groups![0].summary.totalChats).toBe(1)
    expect(projRes.groups![0].summary.totalTokens).toBe(30)

    // 2. groupByModel -> 'unknown'
    const modelRes = await service.queryMetrics({ groupByModel: true })
    expect(modelRes.groups).toBeDefined()
    expect(modelRes.groups).toHaveLength(1)
    expect(modelRes.groups![0].groupKey).toBe('unknown')
    expect(modelRes.groups![0].summary.totalChats).toBe(1)
    expect(modelRes.groups![0].summary.totalTokens).toBe(30)
  })

  it('does not auto-migrate legacy JSON session files on get() and list()', async () => {
    const legacyDir = path.join(tempDir, 'sessions')
    await fs.mkdir(legacyDir, { recursive: true })

    const legacyPayload1 = {
      id: 'legacy-sess-1',
      version: 2,
      entries: [
        {
          id: 'u-leg-1',
          kind: 'user',
          createdAt: 1000,
          content: [{ type: 'text', text: 'Legacy user message' }],
        },
        {
          id: 'a-leg-1',
          kind: 'assistant',
          createdAt: 1100,
          completedAt: 1500,
          usage: { input: 25, output: 25, totalTokens: 50 },
        },
      ],
    }

    const legacyPayload2 = {
      id: 'legacy-sess-2',
      version: 2,
      entries: [
        {
          id: 'u-leg-2',
          kind: 'user',
          createdAt: 2000,
          content: [{ type: 'text', text: 'Legacy second message' }],
        },
      ],
    }

    await fs.writeFile(
      path.join(legacyDir, 'legacy-sess-1.json'),
      JSON.stringify(legacyPayload1, null, 2),
      'utf8',
    )
    await fs.writeFile(
      path.join(legacyDir, 'legacy-sess-2.json'),
      JSON.stringify(legacyPayload2, null, 2),
      'utf8',
    )

    // 1. list() does NOT find or auto-migrate legacy files
    const listResult = await service.list()
    expect(listResult).not.toContain('legacy-sess-1')
    expect(listResult).not.toContain('legacy-sess-2')

    // 2. get() does NOT load legacy files
    const getResult1 = await service.get('legacy-sess-1')
    expect(getResult1).toBeNull()
  })

  it('backfills child subagent turns when parent session is saved with subAgents and rolls up metrics', async () => {
    const parentId = 'parent-backfill-sess'
    const childId = 'child-backfill-sess'

    // 1. Child session saved first WITHOUT subagent/parent metadata
    await service.set(childId, {
      id: childId,
      version: 2,
      entries: [
        {
          id: 'u-child-1',
          kind: 'user',
          createdAt: 1000,
          content: [{ type: 'text', text: 'Child task' }],
        },
        {
          id: 'a-child-1',
          kind: 'assistant',
          createdAt: 1100,
          completedAt: 1500,
          usage: { input: 100, output: 50, totalTokens: 150 },
        },
      ],
    })

    const db = service.getDb()
    const childTurnBefore = db
      .prepare('SELECT is_subagent, parent_session_id, project_id FROM conversation_turns WHERE session_id = ?')
      .get(childId) as any

    expect(childTurnBefore.is_subagent).toBe(0)
    expect(childTurnBefore.parent_session_id).toBeNull()

    // 2. Parent session saved with subAgents metadata and projectId
    await service.set(parentId, {
      id: parentId,
      version: 2,
      projectId: 'proj-backfill-test',
      entries: [
        {
          id: 'u-parent-1',
          kind: 'user',
          createdAt: 2000,
          content: [{ type: 'text', text: 'Parent task' }],
        },
        {
          id: 'a-parent-1',
          kind: 'assistant',
          createdAt: 2100,
          completedAt: 2500,
          usage: { input: 200, output: 100, totalTokens: 300 },
        },
      ],
      subAgents: [
        {
          id: 'subagent-1',
          sessionId: childId,
          parentSessionId: parentId,
          name: 'Worker Subagent',
          status: 'completed',
        },
      ],
    })

    // Verify child turn was backfilled
    const childTurnAfter = db
      .prepare('SELECT is_subagent, parent_session_id, project_id FROM conversation_turns WHERE session_id = ?')
      .get(childId) as any

    expect(childTurnAfter.is_subagent).toBe(1)
    expect(childTurnAfter.parent_session_id).toBe(parentId)
    expect(childTurnAfter.project_id).toBe('proj-backfill-test')

    // 3. Roll up metrics with subAgentMode: 'session_id' (should include parent + child)
    const sessionModeRes = await service.queryMetrics({
      subAgentMode: 'session_id',
      sessionId: parentId,
    })
    expect(sessionModeRes.summary.totalChats).toBe(2)
    expect(sessionModeRes.summary.totalTokens).toBe(450)

    // 4. subAgentMode: 'subagent_only'
    const subOnlyRes = await service.queryMetrics({
      subAgentMode: 'subagent_only',
      projectId: 'proj-backfill-test',
    })
    expect(subOnlyRes.summary.totalChats).toBe(1)
    expect(subOnlyRes.summary.totalTokens).toBe(150)

    // 5. subAgentMode: 'main_only'
    const mainOnlyRes = await service.queryMetrics({
      subAgentMode: 'main_only',
      projectId: 'proj-backfill-test',
    })
    expect(mainOnlyRes.summary.totalChats).toBe(1)
    expect(mainOnlyRes.summary.totalTokens).toBe(300)
  })

  it('preserves historical per-turn speed and reasoning_effort across session updates', async () => {
    const sessId = 'sess-history-speed-test'

    const turn1User = {
      id: 'turn-1-u',
      kind: 'user',
      createdAt: 1000,
      content: [{ type: 'text', text: 'Turn 1 prompt' }],
    }
    const turn1Asst = {
      id: 'turn-1-a',
      kind: 'assistant',
      createdAt: 1100,
      completedAt: 1500,
      usage: { input: 10, output: 10, totalTokens: 20 },
    }

    // Step 1: Save with speed = 'standard' and reasoningEffort = 'low'
    await service.set(sessId, {
      id: sessId,
      version: 2,
      speed: 'standard',
      reasoningEffort: 'low',
      entries: [turn1User, turn1Asst],
    })

    const db = service.getDb()
    const turns1 = db
      .prepare('SELECT id, speed, reasoning_effort FROM conversation_turns WHERE session_id = ? ORDER BY started_at ASC')
      .all(sessId) as any[]
    expect(turns1).toHaveLength(1)
    expect(turns1[0].speed).toBe('standard')
    expect(turns1[0].reasoning_effort).toBe('low')

    // Step 2: Add turn 2 and save with speed = 'fast' and reasoningEffort = 'high'
    const turn2User = {
      id: 'turn-2-u',
      kind: 'user',
      createdAt: 2000,
      content: [{ type: 'text', text: 'Turn 2 prompt' }],
    }
    const turn2Asst = {
      id: 'turn-2-a',
      kind: 'assistant',
      createdAt: 2100,
      completedAt: 2500,
      usage: { input: 20, output: 20, totalTokens: 40 },
    }

    await service.set(sessId, {
      id: sessId,
      version: 2,
      speed: 'fast',
      reasoningEffort: 'high',
      entries: [turn1User, turn1Asst, turn2User, turn2Asst],
    })

    const turns2 = db
      .prepare('SELECT id, speed, reasoning_effort FROM conversation_turns WHERE session_id = ? ORDER BY started_at ASC')
      .all(sessId) as any[]
    expect(turns2).toHaveLength(2)

    // Turn 1 retains 'standard' and 'low'
    expect(turns2[0].id).toBe('turn-1-u')
    expect(turns2[0].speed).toBe('standard')
    expect(turns2[0].reasoning_effort).toBe('low')

    // Turn 2 gets 'fast' and 'high'
    expect(turns2[1].id).toBe('turn-2-u')
    expect(turns2[1].speed).toBe('fast')
    expect(turns2[1].reasoning_effort).toBe('high')
  })

  it('correctly calculates streaks across month, year, and leap-year boundaries', () => {
    // 1. Cross month boundary (Jan 30 - Feb 2: 4 days)
    const monthDates = ['2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02']
    const monthStreak = computeStreaks(monthDates)
    expect(monthStreak.longestStreakDays).toBe(4)

    // 2. Cross year boundary (Dec 30, 2025 - Jan 2, 2026: 4 days)
    const yearDates = ['2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02']
    const yearStreak = computeStreaks(yearDates)
    expect(yearStreak.longestStreakDays).toBe(4)

    // 3. Leap year boundary (Feb 28, 2024 - Mar 1, 2024 with Feb 29: 3 days)
    const leapDates = ['2024-02-28', '2024-02-29', '2024-03-01']
    const leapStreak = computeStreaks(leapDates)
    expect(leapStreak.longestStreakDays).toBe(3)

    // 4. Non-leap year gap (Feb 28, 2025 - Mar 1, 2025 without Feb 29 is not consecutive if fake 29 isn't used)
    const nonLeapDates = ['2025-02-28', '2025-03-01']
    const nonLeapStreak = computeStreaks(nonLeapDates)
    expect(nonLeapStreak.longestStreakDays).toBe(2)

    // 5. Gap across year
    const gapDates = ['2025-12-31', '2026-01-02']
    const gapStreak = computeStreaks(gapDates)
    expect(gapStreak.longestStreakDays).toBe(1)
  })

  it('triggers wal_checkpoint(TRUNCATE) on close() for file databases', () => {
    const db = service.getDb()
    const pragmaSpy = vi.spyOn(db, 'pragma')

    service.close()
    expect(pragmaSpy).toHaveBeenCalledWith('wal_checkpoint(TRUNCATE)')

    // In-memory db test
    const memService = new SessionDatabaseService({ dbPath: ':memory:' })
    const memDb = memService.getDb()
    const memPragmaSpy = vi.spyOn(memDb, 'pragma')
    memService.close()
    expect(memPragmaSpy).not.toHaveBeenCalledWith('wal_checkpoint(TRUNCATE)')
  })

  it('accumulates compaction token usage and cost in conversation turns', async () => {
    const sessId = 'sess-compaction-usage-test'

    await service.set(sessId, {
      id: sessId,
      version: 2,
      entries: [
        {
          id: 'u-compact-1',
          kind: 'user',
          createdAt: 1000,
          content: [{ type: 'text', text: 'Compact this turn' }],
        },
        {
          id: 'a-compact-1',
          kind: 'assistant',
          createdAt: 1100,
          completedAt: 1400,
          usage: {
            input: 100,
            output: 50,
            cacheRead: 10,
            cacheWrite: 5,
            reasoning: 20,
            totalTokens: 150,
            cost: {
              input: 0.001,
              output: 0.002,
              cacheRead: 0.0001,
              cacheWrite: 0.0002,
              total: 0.0033,
            },
          },
        },
        {
          id: 'c-compact-1',
          kind: 'compaction',
          createdAt: 1500,
          summary: 'Summary of earlier discussion',
          firstKeptEntryId: 'a-compact-1',
          usage: {
            input: 200,
            output: 80,
            cacheRead: 20,
            cacheWrite: 10,
            reasoning: 30,
            totalTokens: 280,
            cost: {
              input: 0.002,
              output: 0.003,
              cacheRead: 0.0002,
              cacheWrite: 0.0003,
              total: 0.0055,
            },
          },
        },
      ],
    })

    const metrics = await service.queryMetrics({ sessionId: sessId })
    expect(metrics.summary.totalChats).toBe(1)
    expect(metrics.summary.totalTokens).toBe(430) // 150 + 280
    expect(metrics.summary.totalTokensBreakdown.input).toBe(300) // 100 + 200
    expect(metrics.summary.totalTokensBreakdown.output).toBe(130) // 50 + 80
    expect(metrics.summary.totalTokensBreakdown.cacheRead).toBe(30) // 10 + 20
    expect(metrics.summary.totalTokensBreakdown.cacheWrite).toBe(15) // 5 + 10
    expect(metrics.summary.totalTokensBreakdown.reasoning).toBe(50) // 20 + 30
    expect(metrics.summary.totalCost).toBe(0.0088) // 0.0033 + 0.0055
  })

  describe('listSessions and setMeta', () => {
    it('creates, updates, and lists sessions with setMeta and listSessions', async () => {
      // 1. Initially empty
      expect(await service.listSessions()).toEqual([])

      // 2. Create session 1 via setMeta
      await service.setMeta({
        id: 'sess-1',
        title: 'First Chat',
        projectId: 'proj-a',
        branch: 'main',
        createdAt: 1000,
        updatedAt: 1000,
      })

      const list1 = await service.listSessions()
      expect(list1).toHaveLength(1)
      expect(list1[0]).toEqual({
        id: 'sess-1',
        title: 'First Chat',
        projectId: 'proj-a',
        branch: 'main',
        pinned: false,
        archivedAt: undefined,
        createdAt: 1000,
        updatedAt: 1000,
      })

      // 3. Create session 2 (unpinned, newer) and session 3 (pinned, older)
      await service.setMeta({
        id: 'sess-2',
        title: 'Second Chat',
        createdAt: 2000,
        updatedAt: 2000,
      })

      await service.setMeta({
        id: 'sess-3',
        title: 'Third Chat (Pinned)',
        pinned: true,
        createdAt: 500,
        updatedAt: 500,
      })

      // 4. Verify ordering: pinned sessions come first, then updated_at DESC
      const list2 = await service.listSessions()
      expect(list2).toHaveLength(3)
      expect(list2[0].id).toBe('sess-3') // pinned
      expect(list2[0].pinned).toBe(true)
      expect(list2[1].id).toBe('sess-2') // updated_at 2000
      expect(list2[2].id).toBe('sess-1') // updated_at 1000

      // 5. Update session 1: rename title, toggle pinned, set archive
      await service.setMeta({
        id: 'sess-1',
        title: 'Renamed Chat',
        pinned: true,
        archivedAt: 3000,
        updatedAt: 3500,
      })

      const list3 = await service.listSessions()
      expect(list3).toHaveLength(3)
      expect(list3[0].id).toBe('sess-1') // pinned, updated_at 3500
      expect(list3[0].title).toBe('Renamed Chat')
      expect(list3[0].pinned).toBe(true)
      expect(list3[0].archivedAt).toBe(3000)
      expect(list3[0].projectId).toBe('proj-a') // preserved
      expect(list3[0].branch).toBe('main') // preserved
      expect(list3[1].id).toBe('sess-3') // pinned, updated_at 500
      expect(list3[2].id).toBe('sess-2') // unpinned

      // 6. Unarchive and unpin session 1
      await service.setMeta({
        id: 'sess-1',
        pinned: false,
        archivedAt: undefined,
      })

      const list4 = await service.listSessions()
      const sess1 = list4.find((s) => s.id === 'sess-1')
      expect(sess1?.pinned).toBe(false)
      expect(sess1?.archivedAt).toBeUndefined()
    })

    it('excludes subagent sessions from listSessions()', async () => {
      const parentId = 'main-chat'
      const childId = 'child-chat'

      // Create main session
      await service.set(parentId, {
        id: parentId,
        version: 2,
        title: 'Main Chat',
        entries: [{ id: 'e1', kind: 'user', content: [{ type: 'text', text: 'hi' }] }],
        subAgents: [
          {
            id: 'sa-1',
            sessionId: childId,
            name: 'Sub Worker',
            status: 'completed',
          },
        ],
      })

      // Child session is created as subagent (is_subagent = 1)
      const list = await service.listSessions()
      expect(list).toHaveLength(1)
      expect(list[0].id).toBe(parentId)
      expect(list.some((s) => s.id === childId)).toBe(false)

      // Raw list() still includes child session for metrics/lifecycle
      const rawList = await service.list()
      expect(rawList).toContain(parentId)
      expect(rawList).toContain(childId)
    })

    it('creates default session metadata with setMeta if session does not exist', async () => {
      await service.setMeta({ id: 'brand-new-sess' })

      const sessions = await service.listSessions()
      expect(sessions).toHaveLength(1)
      expect(sessions[0].id).toBe('brand-new-sess')
      expect(sessions[0].title).toBe('New Session')
      expect(sessions[0].pinned).toBe(false)
      expect(sessions[0].projectId).toBeUndefined()
      expect(sessions[0].branch).toBeUndefined()
      expect(sessions[0].archivedAt).toBeUndefined()
      expect(typeof sessions[0].createdAt).toBe('number')
      expect(typeof sessions[0].updatedAt).toBe('number')
    })

    it('updates turns and skills project_id when project is updated via setMeta', async () => {
      const sessId = 'sess-project-update'
      await service.set(sessId, {
        id: sessId,
        version: 2,
        projectId: 'proj-old',
        entries: [
          {
            id: 'u-1',
            kind: 'user',
            text: 'test $skill1',
            createdAt: 1000,
          },
          {
            id: 'a-1',
            kind: 'assistant',
            usage: { totalTokens: 100 },
            createdAt: 2000,
          },
        ],
      })

      // Check metrics under old project
      const oldMetrics = await service.queryMetrics({ projectId: 'proj-old' })
      expect(oldMetrics.summary.totalChats).toBe(1)
      expect(oldMetrics.summary.uniqueSkillsCount).toBe(1)

      // Update project via setMeta
      await service.setMeta({
        id: sessId,
        projectId: 'proj-new',
      })

      const sessionItem = (await service.listSessions()).find((s) => s.id === sessId)
      expect(sessionItem?.projectId).toBe('proj-new')

      // Metrics should now reflect proj-new
      const oldMetricsAfter = await service.queryMetrics({ projectId: 'proj-old' })
      expect(oldMetricsAfter.summary.totalChats).toBe(0)

      const newMetrics = await service.queryMetrics({ projectId: 'proj-new' })
      expect(newMetrics.summary.totalChats).toBe(1)
      expect(newMetrics.summary.uniqueSkillsCount).toBe(1)
    })

    it('preserves all entries intact when setMeta updates title and pin after set()', async () => {
      const sessId = 'sess-preserve-entries'
      const initialEntries = [
        { id: 'e1', kind: 'user', content: [{ type: 'text', text: 'hello world' }] },
        { id: 'e2', kind: 'assistant', content: [{ type: 'text', text: 'how can I help?' }] },
      ]

      await service.set(sessId, {
        id: sessId,
        version: 2,
        title: 'Original Title',
        pinned: false,
        entries: initialEntries,
      })

      // Update metadata via setMeta
      await service.setMeta({
        id: sessId,
        title: 'Updated Meta Title',
        pinned: true,
      })

      // get() must return all original entries intact
      const fetched = await service.get(sessId)
      expect(fetched).not.toBeNull()
      expect(fetched?.id).toBe(sessId)
      expect(fetched?.entries).toEqual(initialEntries)

      // listSessions() must show updated title and pinned status
      const sessions = await service.listSessions()
      const item = sessions.find((s) => s.id === sessId)
      expect(item).toBeDefined()
      expect(item?.title).toBe('Updated Meta Title')
      expect(item?.pinned).toBe(true)
    })

    it('setMeta creates new metadata without migrating legacy JSON files', async () => {
      const legacyDir = path.join(tempDir, 'sessions')
      await fs.mkdir(legacyDir, { recursive: true })

      const legacyId = 'legacy-meta-sess'
      const legacyPayload = {
        id: legacyId,
        version: 2,
        title: 'Legacy Original Title',
        entries: [
          { id: 'lu1', kind: 'user', content: [{ type: 'text', text: 'legacy question' }] },
          { id: 'la1', kind: 'assistant', content: [{ type: 'text', text: 'legacy response' }] },
        ],
      }

      await fs.writeFile(
        path.join(legacyDir, `${legacyId}.json`),
        JSON.stringify(legacyPayload, null, 2),
        'utf8',
      )

      // Call setMeta on session ID without legacy migration
      await service.setMeta({
        id: legacyId,
        title: 'Migrated and Renamed Title',
        pinned: true,
      })

      // get() must return empty entries without reading legacy JSON file
      const fetched = await service.get(legacyId)
      expect(fetched).not.toBeNull()
      expect(fetched?.id).toBe(legacyId)
      expect(fetched?.entries).toEqual([])

      // listSessions() must show the session with updated metadata
      const sessions = await service.listSessions()
      const item = sessions.find((s) => s.id === legacyId)
      expect(item).toBeDefined()
      expect(item?.title).toBe('Migrated and Renamed Title')
      expect(item?.pinned).toBe(true)
    })

    it('propagates project_id to child sessions, child turns, and child skills when parent projectId is updated via setMeta', async () => {
      const parentId = 'parent-cascade-sess'
      const childId = 'child-cascade-sess'
      const oldProj = 'project-alpha'
      const newProj = 'project-beta'
      const db = service.getDb()

      // 1. Create parent session with subagent metadata
      await service.set(parentId, {
        id: parentId,
        version: 2,
        projectId: oldProj,
        entries: [
          {
            id: 'p-u1',
            kind: 'user',
            createdAt: 1000,
            content: [{ type: 'text', text: 'Parent prompt $parent-skill' }],
          },
          {
            id: 'p-a1',
            kind: 'assistant',
            createdAt: 1100,
            completedAt: 1500,
            model: 'gpt-4o',
            usage: { totalTokens: 100 },
          },
        ],
        subAgents: [
          {
            id: 'subagent-1',
            sessionId: childId,
            parentSessionId: parentId,
            name: 'Child Agent',
            status: 'completed',
          },
        ],
      })

      // 2. Create child session
      await service.set(childId, {
        id: childId,
        version: 2,
        parentSessionId: parentId,
        isSubagent: true,
        projectId: oldProj,
        entries: [
          {
            id: 'c-u1',
            kind: 'user',
            createdAt: 2000,
            content: [{ type: 'text', text: 'Child prompt $child-skill' }],
          },
          {
            id: 'c-a1',
            kind: 'assistant',
            createdAt: 2100,
            completedAt: 2500,
            model: 'gpt-4o-mini',
            usage: { totalTokens: 50 },
          },
        ],
      })

      // Verify initial state: all have oldProj
      const parentSessionBefore = db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(parentId) as any
      const childSessionBefore = db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(childId) as any
      const parentTurnBefore = db.prepare('SELECT project_id FROM conversation_turns WHERE session_id = ?').get(parentId) as any
      const childTurnBefore = db.prepare('SELECT project_id FROM conversation_turns WHERE session_id = ?').get(childId) as any
      const parentSkillBefore = db.prepare('SELECT project_id FROM skill_invocations WHERE session_id = ?').get(parentId) as any
      const childSkillBefore = db.prepare('SELECT project_id FROM skill_invocations WHERE session_id = ?').get(childId) as any

      expect(parentSessionBefore.project_id).toBe(oldProj)
      expect(childSessionBefore.project_id).toBe(oldProj)
      expect(parentTurnBefore.project_id).toBe(oldProj)
      expect(childTurnBefore.project_id).toBe(oldProj)
      expect(parentSkillBefore.project_id).toBe(oldProj)
      expect(childSkillBefore.project_id).toBe(oldProj)

      // 3. Update parent session projectId via setMeta
      await service.setMeta({
        id: parentId,
        projectId: newProj,
      })

      // Verify cascaded state: all have newProj
      const parentSessionAfter = db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(parentId) as any
      const childSessionAfter = db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(childId) as any
      const parentTurnAfter = db.prepare('SELECT project_id FROM conversation_turns WHERE session_id = ?').get(parentId) as any
      const childTurnAfter = db.prepare('SELECT project_id FROM conversation_turns WHERE session_id = ?').get(childId) as any
      const parentSkillAfter = db.prepare('SELECT project_id FROM skill_invocations WHERE session_id = ?').get(parentId) as any
      const childSkillAfter = db.prepare('SELECT project_id FROM skill_invocations WHERE session_id = ?').get(childId) as any

      expect(parentSessionAfter.project_id).toBe(newProj)
      expect(childSessionAfter.project_id).toBe(newProj)
      expect(parentTurnAfter.project_id).toBe(newProj)
      expect(childTurnAfter.project_id).toBe(newProj)
      expect(parentSkillAfter.project_id).toBe(newProj)
      expect(childSkillAfter.project_id).toBe(newProj)

      // Verify queryMetrics with newProj returns both parent and child metrics
      const oldMetrics = await service.queryMetrics({ projectId: oldProj })
      expect(oldMetrics.summary.totalChats).toBe(0)
      expect(oldMetrics.summary.totalSkillInvocations).toBe(0)

      const newMetrics = await service.queryMetrics({ projectId: newProj })
      expect(newMetrics.summary.totalChats).toBe(2)
      expect(newMetrics.summary.totalTokens).toBe(150)
      expect(newMetrics.summary.uniqueSkillsCount).toBe(2)
      expect(newMetrics.summary.topSkills.map((s) => s.name).sort()).toEqual(['child-skill', 'parent-skill'])
    })

    it('persists and updates unread status via setMeta and listSessions', async () => {
      // 1. Create session with unread: true
      await service.setMeta({
        id: 'sess-unread-1',
        title: 'Unread Chat',
        unread: true,
        createdAt: 1000,
        updatedAt: 1000,
      })

      const list1 = await service.listSessions()
      const sess1 = list1.find((s) => s.id === 'sess-unread-1')
      expect(sess1?.unread).toBe(true)

      // 2. Mark session as read (unread: false)
      await service.setMeta({
        id: 'sess-unread-1',
        unread: false,
      })

      const list2 = await service.listSessions()
      const sess1Read = list2.find((s) => s.id === 'sess-unread-1')
      expect(sess1Read?.unread).toBeUndefined()

      // 3. Mark session as unread again
      await service.setMeta({
        id: 'sess-unread-1',
        unread: true,
      })

      const list3 = await service.listSessions()
      const sess1UnreadAgain = list3.find((s) => s.id === 'sess-unread-1')
      expect(sess1UnreadAgain?.unread).toBe(true)

      // 4. Mark session with unread: 'error' (abnormal completion)
      await service.setMeta({
        id: 'sess-unread-1',
        unread: 'error',
      })

      const list4 = await service.listSessions()
      const sess1Error = list4.find((s) => s.id === 'sess-unread-1')
      expect(sess1Error?.unread).toBe('error')

      // 5. Mark session as read with unread: undefined
      await service.setMeta({
        id: 'sess-unread-1',
        unread: undefined,
      })

      const list5 = await service.listSessions()
      const sess1Cleared = list5.find((s) => s.id === 'sess-unread-1')
      expect(sess1Cleared?.unread).toBeUndefined()
    })

    it('persists unread status when saved via set()', async () => {
      await service.set('sess-unread-set', {
        id: 'sess-unread-set',
        version: 2,
        title: 'Unread via Set',
        unread: true,
        entries: [{ id: 'u1', kind: 'user', content: [{ type: 'text', text: 'hi' }] }],
      })

      const list = await service.listSessions()
      const sess = list.find((s) => s.id === 'sess-unread-set')
      expect(sess?.unread).toBe(true)
    })

    it('does not restore stale unread status when saving entries after setMeta marks a session read', async () => {
      const sessionId = 'sess-read-preserve'
      await service.set(sessionId, {
        id: sessionId,
        version: 2,
        unread: true,
        entries: [{ id: 'u1', kind: 'user', content: [{ type: 'text', text: 'hi' }] }],
      })
      await service.setMeta({ id: sessionId, unread: false })

      // Simulate a stale client saving conversation content after another client marked it read.
      await service.set(sessionId, {
        id: sessionId,
        version: 2,
        unread: true,
        entries: [
          { id: 'u1', kind: 'user', content: [{ type: 'text', text: 'hi' }] },
          { id: 'a1', kind: 'assistant', content: [{ type: 'text', text: 'done' }] },
        ],
      })

      service.close()
      service = new SessionDatabaseService({ customDir: tempDir })
      const restartedSession = (await service.listSessions()).find((s) => s.id === sessionId)
      expect(restartedSession?.unread).toBeUndefined()
    })

    it('does not overwrite customized title from setMeta with raw user prompt when saving entries via set()', async () => {
      const sessId = 'sess-title-preserve'

      // 1. Initial creation with prompt entries
      await service.set(sessId, {
        id: sessId,
        version: 2,
        entries: [
          {
            id: 'u-1',
            kind: 'user',
            content: [{ type: 'text', text: 'This is the original long user prompt that should not overwrite custom title' }],
            createdAt: 1000,
          },
        ],
      })

      // Initially it extracts user prompt
      let sessions = await service.listSessions()
      expect(sessions.find((s) => s.id === sessId)?.title).toBe(
        'This is the original long user prompt that should not overwrite custom title',
      )

      // 2. set_session_title / user renames the session via setMeta
      await service.setMeta({
        id: sessId,
        title: 'Concise Auto Title',
      })

      sessions = await service.listSessions()
      expect(sessions.find((s) => s.id === sessId)?.title).toBe('Concise Auto Title')

      // 3. Subsequent set() call with new assistant entry and NO explicit title in payload
      await service.set(sessId, {
        id: sessId,
        version: 2,
        entries: [
          {
            id: 'u-1',
            kind: 'user',
            content: [{ type: 'text', text: 'This is the original long user prompt that should not overwrite custom title' }],
            createdAt: 1000,
          },
          {
            id: 'a-1',
            kind: 'assistant',
            content: [{ type: 'text', text: 'Assistant response' }],
            createdAt: 2000,
          },
        ],
      })

      // Title MUST remain 'Concise Auto Title' and not revert to raw prompt
      sessions = await service.listSessions()
      expect(sessions.find((s) => s.id === sessId)?.title).toBe('Concise Auto Title')
    })

    it('migrates existing database missing unread column seamlessly', () => {
      const upgradeDir = path.join(tempDir, 'upgrade-test')
      fsSync.mkdirSync(upgradeDir, { recursive: true })
      const legacyDbPath = path.join(upgradeDir, 'data.db')

      // Create an old schema SQLite database without unread column
      const Database = (service.getDb().constructor as any)
      const rawDb = new Database(legacyDbPath)
      rawDb.exec(`
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            project_id TEXT,
            parent_session_id TEXT,
            is_subagent INTEGER NOT NULL DEFAULT 0,
            title TEXT NOT NULL,
            branch TEXT,
            pinned INTEGER NOT NULL DEFAULT 0,
            archived_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        INSERT INTO sessions (id, title, created_at, updated_at) VALUES ('legacy-sess', 'Legacy Title', 100, 100);
      `)
      rawDb.close()

      // Now open with SessionDatabaseService - should run migration without error
      const upgradedService = new SessionDatabaseService({ customDir: upgradeDir })
      try {
        const columns = upgradedService.getDb().prepare("PRAGMA table_info('sessions')").all() as any[]
        expect(columns.some((c) => c.name === 'unread')).toBe(true)
      } finally {
        upgradedService.close()
      }
    })

    it('persists and loads rightSidebar state via setMeta, getMeta, and listSessions', async () => {
      const sessionId = 'test-sidebar-sess'
      await service.set(sessionId, {
        title: 'Sidebar Test',
        entries: [],
      })

      const sidebarState: SessionRightSidebarState = {
        collapsed: false,
        maximized: true,
        width: 380,
        activeTab: 'file-manager',
        openTabs: ['terminal', 'file-manager'],
        tabParams: { 'file-manager': { activeFilePath: 'src/app.tsx' } },
      }

      await service.setMeta({
        id: sessionId,
        rightSidebar: sidebarState,
      })

      const sessions = await service.listSessions()
      const found = sessions.find((s) => s.id === sessionId)
      expect(found?.rightSidebar).toEqual(sidebarState)

      const meta = await service.getMeta(sessionId)
      expect(meta?.rightSidebar).toEqual(sidebarState)

      // Test getMeta for non-existent session
      const nonExistentMeta = await service.getMeta('non-existent-sess')
      expect(nonExistentMeta).toBeNull()
    })

    it('preserves existing rightSidebar when entries are updated via set() without rightSidebar', async () => {
      const sessionId = 'test-sidebar-preserve'
      const sidebarState: SessionRightSidebarState = {
        collapsed: false,
        maximized: false,
        width: 400,
        activeTab: 'terminal',
        openTabs: ['terminal'],
      }

      await service.setMeta({
        id: sessionId,
        title: 'Initial Title',
        rightSidebar: sidebarState,
      })

      // Update entries via set() without rightSidebar
      await service.set(sessionId, {
        id: sessionId,
        entries: [{ id: 'u1', kind: 'user', content: [{ type: 'text', text: 'hello' }] }],
      })

      const meta = await service.getMeta(sessionId)
      expect(meta?.rightSidebar).toEqual(sidebarState)
    })

    it('persists rightSidebar state via set() and loads via listSessions', async () => {
      const sessionId = 'test-sidebar-set-sess'
      const sidebarState: SessionRightSidebarState = {
        collapsed: true,
        maximized: false,
        width: 450,
        activeTab: 'code-review',
        openTabs: ['code-review'],
      }

      await service.set(sessionId, {
        id: sessionId,
        title: 'Sidebar Set Test',
        entries: [],
        rightSidebar: sidebarState,
      })

      const sessions = await service.listSessions()
      const found = sessions.find((s) => s.id === sessionId)
      expect(found?.rightSidebar).toEqual(sidebarState)
    })

    it('migrates existing database missing right_sidebar_json column seamlessly', () => {
      const upgradeDir = path.join(tempDir, 'upgrade-sidebar-test')
      fsSync.mkdirSync(upgradeDir, { recursive: true })
      const legacyDbPath = path.join(upgradeDir, 'data.db')

      // Create an old schema SQLite database without right_sidebar_json column
      const Database = (service.getDb().constructor as any)
      const rawDb = new Database(legacyDbPath)
      rawDb.exec(`
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            project_id TEXT,
            parent_session_id TEXT,
            is_subagent INTEGER NOT NULL DEFAULT 0,
            title TEXT NOT NULL,
            branch TEXT,
            pinned INTEGER NOT NULL DEFAULT 0,
            unread INTEGER DEFAULT 0,
            archived_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        INSERT INTO sessions (id, title, created_at, updated_at) VALUES ('legacy-sess', 'Legacy Title', 100, 100);
      `)
      rawDb.close()

      // Now open with SessionDatabaseService - should run migration without error
      const upgradedService = new SessionDatabaseService({ customDir: upgradeDir })
      try {
        const columns = upgradedService.getDb().prepare("PRAGMA table_info('sessions')").all() as any[]
        expect(columns.some((c) => c.name === 'right_sidebar_json')).toBe(true)
      } finally {
        upgradedService.close()
      }
    })

    it('validates and safely parses rightSidebar json with parseRightSidebar helper', () => {
      expect(parseRightSidebar(null)).toBeUndefined()
      expect(parseRightSidebar(undefined)).toBeUndefined()
      expect(parseRightSidebar('')).toBeUndefined()
      expect(parseRightSidebar('not-json')).toBeUndefined()
      expect(parseRightSidebar('123')).toBeUndefined()
      expect(parseRightSidebar('"string"')).toBeUndefined()
      expect(parseRightSidebar('true')).toBeUndefined()
      expect(parseRightSidebar('[]')).toBeUndefined()
      expect(parseRightSidebar('[1, 2, 3]')).toBeUndefined()

      const validJson = JSON.stringify({
        collapsed: true,
        maximized: false,
        width: 320,
        activeTab: 'terminal',
        openTabs: ['terminal'],
      })
      expect(parseRightSidebar(validJson)).toEqual({
        collapsed: true,
        maximized: false,
        width: 320,
        activeTab: 'terminal',
        openTabs: ['terminal'],
      })
    })

    it('setMeta clears rightSidebar when explicitly passed null and preserves when undefined', async () => {
      const sessionId = 'test-sidebar-clear-preserve'
      const sidebarState: SessionRightSidebarState = {
        collapsed: false,
        maximized: false,
        width: 360,
        activeTab: 'terminal',
        openTabs: ['terminal'],
      }

      // 1. Initial save with rightSidebar
      await service.setMeta({
        id: sessionId,
        title: 'Initial Title',
        rightSidebar: sidebarState,
      })

      let meta = await service.getMeta(sessionId)
      expect(meta?.rightSidebar).toEqual(sidebarState)

      // 2. setMeta with title only (rightSidebar is undefined) -> preserves existing rightSidebar
      await service.setMeta({
        id: sessionId,
        title: 'Renamed Title',
      })

      meta = await service.getMeta(sessionId)
      expect(meta?.title).toBe('Renamed Title')
      expect(meta?.rightSidebar).toEqual(sidebarState)

      // 3. setMeta with rightSidebar: null -> clears rightSidebar in database
      await service.setMeta({
        id: sessionId,
        rightSidebar: null,
      })

      meta = await service.getMeta(sessionId)
      expect(meta?.rightSidebar).toBeUndefined()

      const sessions = await service.listSessions()
      const found = sessions.find((s) => s.id === sessionId)
      expect(found?.rightSidebar).toBeUndefined()
    })

    it('safely handles corrupt or array right_sidebar_json in SQLite database', async () => {
      const sessCorrupt = 'sess-corrupt-sidebar'
      await service.set(sessCorrupt, { title: 'Corrupt Sidebar', entries: [] })

      const db = service.getDb()
      db.prepare("UPDATE sessions SET right_sidebar_json = '[1, 2, 3]' WHERE id = ?").run(sessCorrupt)

      const meta = await service.getMeta(sessCorrupt)
      expect(meta?.rightSidebar).toBeUndefined()

      const sessions = await service.listSessions()
      const found = sessions.find((s) => s.id === sessCorrupt)
      expect(found?.rightSidebar).toBeUndefined()
    })

    it('extracts firstPromptAt from entries and persists via set and setMeta', async () => {
      const sessWithUser = 'sess-first-prompt'
      await service.set(sessWithUser, {
        title: 'User Prompt Session',
        entries: [
          {
            id: 'u1',
            kind: 'user',
            createdAt: 12345,
            content: [{ type: 'text', text: 'First user prompt' }],
          },
          {
            id: 'a1',
            kind: 'assistant',
            createdAt: 13000,
            content: [{ type: 'text', text: 'Assistant reply' }],
          },
        ],
      })

      const meta = await service.getMeta(sessWithUser)
      expect(meta?.firstPromptAt).toBe(12345)

      const sessions = await service.listSessions()
      const item = sessions.find((s) => s.id === sessWithUser)
      expect(item?.firstPromptAt).toBe(12345)

      // Test manual override via setMeta
      await service.setMeta({
        id: sessWithUser,
        firstPromptAt: 99999,
      })

      const updatedMeta = await service.getMeta(sessWithUser)
      expect(updatedMeta?.firstPromptAt).toBe(99999)
    })

    it('updateSubAgent atomically inserts and updates subagent records directly', async () => {
      const parentId = 'parent-sess-subagent'
      await service.set(parentId, { title: 'Parent Session', entries: [] })

      const subAgentId = 'sa-atomic-1'
      // 1. Initial atomic insert as running
      await service.updateSubAgent({
        id: subAgentId,
        sessionId: subAgentId,
        parentSessionId: parentId,
        name: 'atomic-agent',
        modelId: 'grok-4.6',
        status: 'running',
        createdAt: 1000,
        updatedAt: 1000,
      })

      let loaded = await service.get(parentId)
      expect(loaded?.subAgents).toHaveLength(1)
      expect(loaded?.subAgents?.[0]).toMatchObject({
        id: subAgentId,
        name: 'atomic-agent',
        status: 'running',
        createdAt: 1000,
        updatedAt: 1000,
      })

      // 2. Atomic update to completed with lastMessage
      await service.updateSubAgent({
        id: subAgentId,
        status: 'completed',
        lastMessage: 'Finished task successfully',
        updatedAt: 2500,
      })

      loaded = await service.get(parentId)
      expect(loaded?.subAgents).toHaveLength(1)
      expect(loaded?.subAgents?.[0]).toMatchObject({
        id: subAgentId,
        name: 'atomic-agent',
        status: 'completed',
        lastMessage: 'Finished task successfully',
        createdAt: 1000,
        updatedAt: 2500,
      })
    })

    it('persists and restores subagent role metadata (roleId, roleName, rolePrompt)', async () => {
      const parentId = 'session-parent-role-test'
      const subAgentId = 'subagent-role-test-1'

      await service.set(parentId, {
        id: parentId,
        version: 2,
        entries: [],
        subAgents: [
          {
            id: subAgentId,
            sessionId: subAgentId,
            parentSessionId: parentId,
            name: 'ReviewerBot',
            modelId: 'gpt-5.5',
            reasoningEffort: 'high',
            status: 'completed',
            roleId: 'reviewer-id',
            roleName: '代码审查员',
            rolePrompt: '负责严格的代码规范审查与安全审计指令。',
            depth: 2,
            parentAgentId: 'agent-parent-1',
            createdAt: 1000,
            updatedAt: 1000,
          },
        ],
      })

      const loaded = await service.get(parentId)
      expect(loaded?.subAgents).toHaveLength(1)
      expect(loaded?.subAgents?.[0]).toMatchObject({
        id: subAgentId,
        roleId: 'reviewer-id',
        roleName: '代码审查员',
        rolePrompt: '负责严格的代码规范审查与安全审计指令。',
        depth: 2,
        parentAgentId: 'agent-parent-1',
      })
    })

    it('searches sessions by title (prioritized) and content snippet', async () => {
      const now = Date.now()
      // Session 1: title matches "shell"
      await service.set('s-1', {
        id: 's-1',
        title: 'Learn shell scripting',
        updatedAt: now - 1000,
        entries: [
          {
            id: 'e-1',
            kind: 'user',
            content: [{ type: 'text', text: 'Hello there' }],
          },
        ],
      })

      // Session 2: content matches "shell", title does not
      await service.set('s-2', {
        id: 's-2',
        title: 'Project Setup Guide',
        updatedAt: now,
        entries: [
          {
            id: 'e-2',
            kind: 'assistant',
            content: [
              {
                type: 'text',
                text: 'We are running a CPA-style shell to execute commands.',
              },
            ],
          },
        ],
      })

      // Session 3: unrelated
      await service.set('s-3', {
        id: 's-3',
        title: 'Unrelated conversation',
        updatedAt: now - 500,
        entries: [
          {
            id: 'e-3',
            kind: 'user',
            content: [{ type: 'text', text: 'Nothing here' }],
          },
        ],
      })

      const results = await service.search('shell')
      expect(results).toHaveLength(2)

      // Title match must be prioritized first
      expect(results[0]).toMatchObject({
        sessionId: 's-1',
        title: 'Learn shell scripting',
        matchType: 'title',
      })

      // Content match comes next and includes snippet
      expect(results[1]).toMatchObject({
        sessionId: 's-2',
        title: 'Project Setup Guide',
        matchType: 'content',
      })
      expect(results[1]?.snippet).toContain('shell')
    })

    it('persists and restores workLocation, worktreePath, environmentId, and worktreeSetup in SQLite', async () => {
      const failedSetup = {
        sessionId: 'sess-wt-failed',
        status: 'error' as const,
        stepWorkspace: 'done' as const,
        stepCheckout: 'done' as const,
        stepEnvironment: 'error' as const,
        worktreePath: '/worktrees/proj-failed',
        sourceTreePath: '/projects/proj-main',
        branch: 'codex/fix-bug',
        environmentId: 'env-1',
        environmentName: 'My Env',
        logs: 'Error: script exited with code 1\nCommand failed: make install',
        exitCode: 1,
        error: 'Script exited with code 1',
        expandedDetails: true,
      }

      await service.set('sess-wt-failed', {
        id: 'sess-wt-failed',
        title: 'Worktree Failed Session',
        workLocation: 'worktree',
        worktreePath: '/worktrees/proj-failed',
        environmentId: 'env-1',
        worktreeSetup: failedSetup,
        entries: [
          {
            id: 'e-1',
            kind: 'user',
            content: [{ type: 'text', text: 'Hello worktree' }],
          },
        ],
      })

      // 1. Check get()
      const loaded = await service.get('sess-wt-failed')
      expect(loaded).not.toBeNull()
      expect(loaded?.workLocation).toBe('worktree')
      expect(loaded?.worktreePath).toBe('/worktrees/proj-failed')
      expect(loaded?.environmentId).toBe('env-1')
      expect(loaded?.worktreeSetup).toEqual(failedSetup)

      // 2. Check getMeta() and listSessions()
      const meta = await service.getMeta('sess-wt-failed')
      expect(meta).not.toBeNull()
      expect(meta?.workLocation).toBe('worktree')
      expect(meta?.worktreePath).toBe('/worktrees/proj-failed')
      expect(meta?.environmentId).toBe('env-1')
      expect(meta?.worktreeSetup).toEqual(failedSetup)

      const allSessions = await service.listSessions()
      const found = allSessions.find((s) => s.id === 'sess-wt-failed')
      expect(found?.worktreeSetup?.status).toBe('error')
      expect(found?.worktreeSetup?.logs).toContain('Command failed: make install')

      // 3. Test setMeta updates
      const readySetup = {
        ...failedSetup,
        status: 'ready' as const,
        stepEnvironment: 'done' as const,
        exitCode: 0,
        error: undefined,
      }
      await service.setMeta({
        id: 'sess-wt-failed',
        worktreeSetup: readySetup,
      })

      const updatedMeta = await service.getMeta('sess-wt-failed')
      expect(updatedMeta?.worktreeSetup?.status).toBe('ready')
      expect(updatedMeta?.worktreeSetup?.stepEnvironment).toBe('done')
      expect(updatedMeta).toMatchObject({
        workLocation: 'worktree',
        worktreePath: '/worktrees/proj-failed',
        worktreeSetup: {
          status: 'ready',
          worktreePath: '/worktrees/proj-failed',
          sourceTreePath: '/projects/proj-main',
        },
      })
    })
  })

  describe('Plugin Storage Table and Methods', () => {
    it('supports get, set, delete, and list keys for plugin storage', () => {
      expect(service.getPluginStorage('my-plugin', 1, 'key1')).toBeUndefined()
      expect(service.listPluginStorageKeys('my-plugin', 1)).toEqual([])

      service.setPluginStorage('my-plugin', 1, 'key1', { foo: 'bar' })
      service.setPluginStorage('my-plugin', 1, 'key2', [1, 2, 3])
      service.setPluginStorage('my-plugin', 2, 'key1', { version: 2 })

      expect(service.getPluginStorage('my-plugin', 1, 'key1')).toEqual({ foo: 'bar' })
      expect(service.getPluginStorage('my-plugin', 1, 'key2')).toEqual([1, 2, 3])
      expect(service.getPluginStorage('my-plugin', 2, 'key1')).toEqual({ version: 2 })
      expect(service.listPluginStorageKeys('my-plugin', 1)).toEqual(['key1', 'key2'])

      service.deletePluginStorage('my-plugin', 1, 'key1')
      expect(service.getPluginStorage('my-plugin', 1, 'key1')).toBeUndefined()
      expect(service.listPluginStorageKeys('my-plugin', 1)).toEqual(['key2'])
    })

    it('supports atomic transaction runner', () => {
      const result = service.runTransaction(() => {
        service.setPluginStorage('tx-plugin', 1, 'count', 10)
        return service.getPluginStorage<number>('tx-plugin', 1, 'count')
      })
      expect(result).toBe(10)

      expect(() => {
        service.runTransaction(() => {
          service.setPluginStorage('tx-plugin', 1, 'count', 99)
          throw new Error('Rollback test')
        })
      }).toThrow('Rollback test')

      expect(service.getPluginStorage('tx-plugin', 1, 'count')).toBe(10)
    })
  })
})

