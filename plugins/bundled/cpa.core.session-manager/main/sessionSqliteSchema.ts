import type { Database as DatabaseType } from 'better-sqlite3'
import type {
  SessionItem,
  SessionRightSidebarState,
  SessionUnreadState,
  WorktreeSessionSetup,
} from '@cpa/plugin-api'

export interface SessionRow {
  id: string
  project_id: string | null
  schedule_id?: string | null
  parent_session_id?: string | null
  is_subagent?: number
  branch: string | null
  title: string
  pinned: number
  unread: number | null
  archived_at: number | null
  right_sidebar_json: string | null
  first_prompt_at: number | null
  model_id?: string | null
  reasoning_effort?: string | null
  speed?: string | null
  work_location?: string | null
  worktree_path?: string | null
  environment_id?: string | null
  worktree_setup_json?: string | null
  pinned_summary_visible?: number | null
  created_at: number
  updated_at: number
}

export interface SessionEntryRow {
  id: string
  session_id: string
  kind: string
  version: number
  created_at: number
  entry_index: number
  payload_json: string
}

export interface SubAgentRow {
  id: string
  session_id: string
  parent_session_id: string
  parent_tool_call_id?: string | null
  name: string
  model_id?: string | null
  reasoning_effort?: string | null
  status: string
  color?: string | null
  icon?: string | null
  last_message?: string | null
  error_message?: string | null
  created_at: number
  updated_at: number
}

export interface PluginStorageRow {
  plugin_id: string
  namespace_version: number
  key: string
  value_json: string
  updated_at: number
}

export const SESSIONS_TABLE_SQL = `
-- Session IDs are never reused. Tombstones reject delayed writes across restarts and clients.
CREATE TABLE IF NOT EXISTS session_tombstones (
    id TEXT PRIMARY KEY,
    deleted_at INTEGER NOT NULL
);

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
    work_location TEXT,
    worktree_path TEXT,
    environment_id TEXT,
    worktree_setup_json TEXT,
    pinned_summary_visible INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
`

export const SESSION_ENTRIES_TABLE_SQL = `
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
`

export const SUBAGENTS_TABLE_SQL = `
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
    role_id TEXT,
    role_name TEXT,
    role_prompt TEXT,
    depth INTEGER NOT NULL DEFAULT 1,
    parent_agent_id TEXT,
    FOREIGN KEY (parent_session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
`

export const CONVERSATION_TURNS_TABLE_SQL = `
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
`

export const SKILL_INVOCATIONS_TABLE_SQL = `
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
`

/**
 * Usage produced by model calls made inside a tool execution. These are not
 * conversation turns, but must remain independently attributable by model.
 */
export const ISOLATED_MODEL_INVOCATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS isolated_model_invocations (
    invocation_id TEXT PRIMARY KEY,
    turn_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    project_id TEXT,
    parent_session_id TEXT,
    is_subagent INTEGER NOT NULL DEFAULT 0,
    parent_tool_call_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    invoked_at INTEGER NOT NULL,
    tokens_input INTEGER NOT NULL,
    tokens_output INTEGER NOT NULL,
    tokens_cache_read INTEGER NOT NULL,
    tokens_cache_write INTEGER NOT NULL,
    tokens_reasoning INTEGER NOT NULL,
    tokens_total INTEGER NOT NULL,
    cost_input REAL,
    cost_output REAL,
    cost_cache_read REAL,
    cost_cache_write REAL,
    cost_total REAL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
`

export const USAGE_METRICS_VIEW_SQL = `
CREATE VIEW IF NOT EXISTS usage_metrics AS
SELECT
    id AS usage_id, session_id, project_id, parent_session_id, is_subagent,
    model_id, speed, reasoning_effort, started_at, completed_at, duration_ms,
    tokens_input, tokens_output, tokens_cache_read, tokens_cache_write,
    tokens_reasoning, tokens_total, cost_input, cost_output, cost_cache_read,
    cost_cache_write, cost_total, 1 AS is_chat
FROM conversation_turns
UNION ALL
SELECT
    invocation_id AS usage_id, session_id, project_id, parent_session_id, is_subagent,
    model_id, NULL AS speed, NULL AS reasoning_effort, invoked_at AS started_at,
    invoked_at AS completed_at, 0 AS duration_ms, tokens_input, tokens_output,
    tokens_cache_read, tokens_cache_write, tokens_reasoning, tokens_total,
    cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total,
    0 AS is_chat
FROM isolated_model_invocations;
`

export const PLUGIN_STORAGE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS plugin_storage (
    plugin_id TEXT NOT NULL,
    namespace_version INTEGER NOT NULL,
    key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (plugin_id, namespace_version, key)
);
`

export const INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_schedule ON sessions(schedule_id);

CREATE INDEX IF NOT EXISTS idx_entries_session_order ON session_entries(session_id, entry_index ASC);

CREATE INDEX IF NOT EXISTS idx_subagents_parent ON subagents(parent_session_id);

CREATE INDEX IF NOT EXISTS idx_turns_stats_agg ON conversation_turns(started_at, project_id, model_id, is_subagent);
CREATE INDEX IF NOT EXISTS idx_turns_parent_stats ON conversation_turns(parent_session_id, started_at);

CREATE INDEX IF NOT EXISTS idx_skills_stats ON skill_invocations(invoked_at, skill_name, project_id, model_id);
CREATE INDEX IF NOT EXISTS idx_isolated_model_usage_stats ON isolated_model_invocations(invoked_at, project_id, model_id, is_subagent, session_id);
CREATE INDEX IF NOT EXISTS idx_isolated_model_usage_session ON isolated_model_invocations(session_id, turn_id);
CREATE INDEX IF NOT EXISTS idx_isolated_model_usage_parent ON isolated_model_invocations(parent_session_id, invoked_at);

CREATE INDEX IF NOT EXISTS idx_plugin_storage_lookup ON plugin_storage(plugin_id, namespace_version);
`

export const ALL_BASE_TABLES_SQL = `
${SESSIONS_TABLE_SQL}
${SESSION_ENTRIES_TABLE_SQL}
${SUBAGENTS_TABLE_SQL}
${CONVERSATION_TURNS_TABLE_SQL}
${SKILL_INVOCATIONS_TABLE_SQL}
${ISOLATED_MODEL_INVOCATIONS_TABLE_SQL}
${PLUGIN_STORAGE_TABLE_SQL}
`

export function parseJsonField<T>(json: string | null | undefined): T | undefined {
  if (!json || typeof json !== 'string') return undefined
  try {
    const parsed = JSON.parse(json)
    if (parsed && typeof parsed === 'object') {
      return parsed as T
    }
  } catch {
    // Ignore JSON error
  }
  return undefined
}

export function parseRightSidebar(
  json: string | null | undefined,
): SessionRightSidebarState | undefined {
  if (!json || typeof json !== 'string') return undefined
  try {
    const parsed = JSON.parse(json)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as SessionRightSidebarState
    }
  } catch {
    // Ignore JSON parse error
  }
  return undefined
}

export function parseWorktreeSetup(
  json: string | null | undefined,
): WorktreeSessionSetup | undefined {
  if (!json || typeof json !== 'string') return undefined
  try {
    const parsed = JSON.parse(json)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as WorktreeSessionSetup
    }
  } catch {
    // Ignore JSON parse error
  }
  return undefined
}

export function encodeUnread(unread: unknown): number {
  if (unread === 'error' || unread === 2) return 2
  if (unread === true || unread === 'unread' || unread === 1) return 1
  return 0
}

export function mapSessionRow(row: SessionRow): SessionItem {
  let unread: SessionUnreadState | undefined
  if (row.unread === 1) {
    unread = true
  } else if (row.unread === 2) {
    unread = 'error'
  }
  return {
    id: row.id,
    title: row.title,
    projectId: row.project_id || undefined,
    scheduleId: row.schedule_id || undefined,
    parentSessionId: row.parent_session_id || undefined,
    branch: row.branch || undefined,
    pinned: Boolean(row.pinned),
    unread,
    archivedAt: row.archived_at ?? undefined,
    rightSidebar: parseRightSidebar(row.right_sidebar_json),
    firstPromptAt: row.first_prompt_at ?? undefined,
    modelId: row.model_id || undefined,
    reasoningEffort: row.reasoning_effort || undefined,
    speed:
      row.speed === 'standard' || row.speed === 'fast' || row.speed === 'max'
        ? row.speed
        : undefined,
    workLocation:
      row.work_location === 'worktree'
        ? 'worktree'
        : row.work_location === 'local'
          ? 'local'
          : undefined,
    worktreePath: row.worktree_path || undefined,
    environmentId: row.environment_id !== null ? row.environment_id : undefined,
    worktreeSetup: parseWorktreeSetup(row.worktree_setup_json),
    pinnedSummaryVisible:
      row.pinned_summary_visible !== null && row.pinned_summary_visible !== undefined
        ? Boolean(row.pinned_summary_visible)
        : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Applies neutral schema and migrations across any SQLite database instance for session manager.
 */
export function applySessionSchemaAndMigrations(db: DatabaseType): void {
  // 1. Create base tables
  db.exec(ALL_BASE_TABLES_SQL)

  // 2. Normalize plugin_storage: drop legacy created_at column if present to ensure 100% parity
  try {
    const tableInfo = db.prepare("PRAGMA table_info('plugin_storage')").all() as Array<{ name: string }>
    if (tableInfo.some((col) => col.name === 'created_at')) {
      db.exec('ALTER TABLE plugin_storage DROP COLUMN created_at')
    }
  } catch {
    // Column might not exist or already dropped
  }

  // 3. Ensure all sessions columns exist for older database upgrades
  const sessionColumns = [
    'unread INTEGER DEFAULT 0',
    'right_sidebar_json TEXT',
    'first_prompt_at INTEGER',
    'schedule_id TEXT',
    'model_id TEXT',
    'reasoning_effort TEXT',
    'speed TEXT',
    'work_location TEXT',
    'worktree_path TEXT',
    'environment_id TEXT',
    'worktree_setup_json TEXT',
    'pinned_summary_visible INTEGER',
  ]
  for (const col of sessionColumns) {
    try {
      db.exec(`ALTER TABLE sessions ADD COLUMN ${col}`)
    } catch {
      // Column already exists or table freshly created
    }
  }

  // 4. Ensure all subagents columns exist for older database upgrades
  const subagentColumns = [
    'parent_tool_call_id TEXT',
    'model_id TEXT',
    'reasoning_effort TEXT',
    'color TEXT',
    'icon TEXT',
    'last_message TEXT',
    'error_message TEXT',
    'role_id TEXT',
    'role_name TEXT',
    'role_prompt TEXT',
    'depth INTEGER NOT NULL DEFAULT 1',
    'parent_agent_id TEXT',
  ]
  for (const col of subagentColumns) {
    try {
      db.exec(`ALTER TABLE subagents ADD COLUMN ${col}`)
    } catch {
      // Column already exists or table freshly created
    }
  }

  // 5. Create indexes and the additive metrics view now that all columns exist.
  try {
    db.exec(INDEXES_SQL)
    db.exec(USAGE_METRICS_VIEW_SQL)
  } catch {
    // Ignore creation errors if a partially migrated database is read-only.
  }

  // 6. Backfill first_prompt_at from existing user session_entries if null
  try {
    db.exec(`
      UPDATE sessions
      SET first_prompt_at = (
        SELECT MIN(created_at) FROM session_entries
        WHERE session_entries.session_id = sessions.id AND session_entries.kind = 'user'
      )
      WHERE first_prompt_at IS NULL AND EXISTS (
        SELECT 1 FROM session_entries
        WHERE session_entries.session_id = sessions.id AND session_entries.kind = 'user'
      )
    `)
  } catch {
    // Ignore initial backfill errors if tables are empty
  }

  // 7. Backfill session models/speed from conversation_turns if null
  try {
    db.exec(`
      UPDATE sessions
      SET
        model_id = COALESCE(model_id, (
          SELECT model_id
          FROM conversation_turns
          WHERE conversation_turns.session_id = sessions.id
            AND model_id IS NOT NULL
            AND model_id != ''
          ORDER BY started_at DESC
          LIMIT 1
        )),
        reasoning_effort = COALESCE(reasoning_effort, (
          SELECT reasoning_effort
          FROM conversation_turns
          WHERE conversation_turns.session_id = sessions.id
            AND reasoning_effort IS NOT NULL
            AND reasoning_effort != ''
          ORDER BY started_at DESC
          LIMIT 1
        )),
        speed = COALESCE(speed, (
          SELECT speed
          FROM conversation_turns
          WHERE conversation_turns.session_id = sessions.id
          ORDER BY started_at DESC
          LIMIT 1
        ))
      WHERE model_id IS NULL OR reasoning_effort IS NULL OR speed IS NULL
    `)
  } catch {
    // Ignore initial backfill errors if tables are empty
  }
}
