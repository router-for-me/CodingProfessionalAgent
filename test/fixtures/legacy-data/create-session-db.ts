import Database from 'better-sqlite3'
import * as fsSync from 'node:fs'
import * as path from 'node:path'

/**
 * Creates a legacy SQLite database file for testing migration and data retention.
 */
export function createLegacySessionDb(dbFilePath: string): Database.Database {
  const dir = path.dirname(dbFilePath)
  fsSync.mkdirSync(dir, { recursive: true })

  const db = new Database(dbFilePath)

  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        schedule_id TEXT,
        parent_session_id TEXT,
        is_subagent INTEGER NOT NULL DEFAULT 0,
        title TEXT NOT NULL,
        branch TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        unread INTEGER DEFAULT 0,
        archived_at INTEGER,
        right_sidebar_json TEXT,
        first_prompt_at INTEGER,
        model_id TEXT,
        reasoning_effort TEXT,
        speed TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at);

    CREATE TABLE IF NOT EXISTS session_entries (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        entry_index INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_entries_session_order ON session_entries(session_id, entry_index ASC);

    CREATE TABLE IF NOT EXISTS subagents (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        parent_session_id TEXT NOT NULL,
        parent_tool_call_id TEXT,
        name TEXT NOT NULL,
        model_id TEXT,
        reasoning_effort TEXT,
        status TEXT NOT NULL,
        color TEXT,
        icon TEXT,
        last_message TEXT,
        error_message TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (parent_session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_subagents_parent ON subagents(parent_session_id);

    CREATE TABLE IF NOT EXISTS conversation_turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        project_id TEXT,
        parent_session_id TEXT,
        is_subagent INTEGER NOT NULL DEFAULT 0,
        model_id TEXT,
        speed TEXT NOT NULL DEFAULT 'standard',
        reasoning_effort TEXT,
        started_at INTEGER NOT NULL,
        completed_at INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        tokens_input INTEGER NOT NULL DEFAULT 0,
        tokens_output INTEGER NOT NULL DEFAULT 0,
        tokens_cache_read INTEGER NOT NULL DEFAULT 0,
        tokens_cache_write INTEGER NOT NULL DEFAULT 0,
        tokens_reasoning INTEGER NOT NULL DEFAULT 0,
        tokens_total INTEGER NOT NULL DEFAULT 0,
        cost_input REAL NOT NULL DEFAULT 0.0,
        cost_output REAL NOT NULL DEFAULT 0.0,
        cost_cache_read REAL NOT NULL DEFAULT 0.0,
        cost_cache_write REAL NOT NULL DEFAULT 0.0,
        cost_total REAL NOT NULL DEFAULT 0.0,
        status TEXT NOT NULL DEFAULT 'done',
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_turns_stats_agg ON conversation_turns(started_at, project_id, model_id, is_subagent);
    CREATE INDEX IF NOT EXISTS idx_turns_parent_stats ON conversation_turns(parent_session_id, started_at);

    CREATE TABLE IF NOT EXISTS skill_invocations (
        id TEXT PRIMARY KEY,
        turn_id TEXT,
        session_id TEXT NOT NULL,
        project_id TEXT,
        model_id TEXT,
        skill_name TEXT NOT NULL,
        invoked_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_skills_stats ON skill_invocations(invoked_at, skill_name, project_id, model_id);
  `)

  // Insert seed data
  const insertSession = db.prepare(`
    INSERT INTO sessions (
      id, project_id, schedule_id, parent_session_id, is_subagent, title, branch, pinned, unread, archived_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  insertSession.run(
    'sess-legacy-1',
    'proj-legacy-1',
    'sched-legacy-1',
    null,
    0,
    'Legacy Main Session',
    'main',
    1,
    0,
    null,
    1000000,
    2000000,
  )

  insertSession.run(
    'sess-legacy-child',
    'proj-legacy-1',
    null,
    'sess-legacy-1',
    1,
    'Legacy Child Subagent',
    'main',
    0,
    0,
    null,
    1100000,
    1900000,
  )

  const insertEntry = db.prepare(`
    INSERT INTO session_entries (
      id, session_id, kind, version, created_at, entry_index, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `)

  insertEntry.run(
    'entry-1',
    'sess-legacy-1',
    'user',
    1,
    1000000,
    0,
    JSON.stringify({
      id: 'entry-1',
      kind: 'user',
      createdAt: 1000000,
      content: [{ type: 'text', text: 'Legacy prompt $superpower' }],
    }),
  )

  insertEntry.run(
    'entry-2',
    'sess-legacy-1',
    'assistant',
    1,
    1001000,
    1,
    JSON.stringify({
      id: 'entry-2',
      kind: 'assistant',
      createdAt: 1001000,
      completedAt: 1005000,
      model: 'gpt-4o',
      status: 'done',
      content: [{ type: 'text', text: 'Legacy response' }],
      usage: {
        input: 100,
        output: 50,
        totalTokens: 150,
        cost: { input: 0.001, output: 0.002, total: 0.003 },
      },
    }),
  )

  const insertSubagent = db.prepare(`
    INSERT INTO subagents (
      id, session_id, parent_session_id, name, model_id, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)

  insertSubagent.run(
    'sub-1',
    'sess-legacy-child',
    'sess-legacy-1',
    'Legacy Subagent',
    'gpt-4o-mini',
    'completed',
    1100000,
    1900000,
  )

  const insertTurn = db.prepare(`
    INSERT INTO conversation_turns (
      id, session_id, project_id, parent_session_id, is_subagent,
      model_id, speed, reasoning_effort, started_at, completed_at,
      duration_ms, tokens_input, tokens_output, tokens_cache_read,
      tokens_cache_write, tokens_reasoning, tokens_total,
      cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total,
      status
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?
    )
  `)

  insertTurn.run(
    'entry-1',
    'sess-legacy-1',
    'proj-legacy-1',
    null,
    0,
    'gpt-4o',
    'standard',
    null,
    1000000,
    1005000,
    5000,
    100,
    50,
    0,
    0,
    0,
    150,
    0.001,
    0.002,
    0,
    0,
    0.003,
    'done',
  )

  const insertSkill = db.prepare(`
    INSERT INTO skill_invocations (
      id, turn_id, session_id, project_id, model_id, skill_name, invoked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `)

  insertSkill.run(
    'skill-1',
    'entry-1',
    'sess-legacy-1',
    'proj-legacy-1',
    'gpt-4o',
    'superpower',
    1000000,
  )

  return db
}
