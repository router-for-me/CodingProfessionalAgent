import Database, { type Database as DatabaseType, type Statement } from 'better-sqlite3'
import * as fsSync from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import * as crypto from 'node:crypto'
import type {
  QueryMetricsOptions,
  QueryMetricsResult,
  AggregateMetrics,
  GranularBucketMetrics,
  GroupedMetricsItem,
  MetricTimeGranularity,
  SessionItem,
  SessionRightSidebarState,
  SessionSearchResultItem,
  SessionUnreadState,
  SubAgentItem,
  WorktreeSessionSetup,
} from '../../../../src/shared/types.js'
import {
  type SessionRow,
  applySessionSchemaAndMigrations,
  encodeUnread,
  mapSessionRow,
  parseRightSidebar,
  parseWorktreeSetup,
} from './sessionSqliteSchema.js'
import { getAppConfigDirName } from '@cpa/plugin-api'

export { parseRightSidebar, parseWorktreeSetup }

export interface SessionDatabaseOptions {
  dbPath?: string
  customDir?: string
  getHomeDir?: () => string
  configDirName?: string
  isDev?: boolean
}

const SKILL_DIR_REGEX = /(?:^|\/)([a-zA-Z0-9_-]+)\/(?:SKILL|skill)\.md$/i
const SKILLS_FILE_REGEX = /(?:^|\/)skills\/([a-zA-Z0-9_-]+)\.md$/i

export interface SessionFilePayload {
  id: string
  version?: number
  entries: any[]
  subAgents?: any[]
  projectId?: string | null
  scheduleId?: string | null
  parentSessionId?: string | null
  isSubagent?: boolean | number
  title?: string
  branch?: string | null
  pinned?: boolean | number
  unread?: SessionUnreadState | number
  archivedAt?: number | null
  rightSidebar?: SessionRightSidebarState | null
  firstPromptAt?: number | null
  workLocation?: 'local' | 'worktree'
  worktreePath?: string
  environmentId?: string | null
  worktreeSetup?: WorktreeSessionSetup | null
  pinnedSummaryVisible?: boolean | number | null
  createdAt?: number
  updatedAt?: number
  speed?: string
  reasoningEffort?: string
  modelId?: string
  model?: string
}

export class SessionDatabaseService {
  private db: DatabaseType | null = null
  private dbPath: string
  private readonly customDir?: string
  private readonly getHomeDir: () => string
  private statementCache = new Map<string, Statement>()

  private getStatement(sql: string): Statement {
    let stmt = this.statementCache.get(sql)
    if (!stmt) {
      stmt = this.getDb().prepare(sql)
      this.statementCache.set(sql, stmt)
    }
    return stmt
  }

  constructor(optionsOrDir?: string | SessionDatabaseOptions) {
    const options: SessionDatabaseOptions =
      typeof optionsOrDir === 'string'
        ? (optionsOrDir === ':memory:' || optionsOrDir.endsWith('.db')
            ? { dbPath: optionsOrDir }
            : { customDir: optionsOrDir })
        : optionsOrDir ?? {}

    this.getHomeDir = options.getHomeDir ?? (() => os.homedir())
    this.customDir = options.customDir

    if (options.dbPath) {
      this.dbPath = options.dbPath
    } else if (options.customDir) {
      this.dbPath = path.join(options.customDir, 'data.db')
    } else {
      const homeDir = this.getHomeDir()
      const configDirName = options.configDirName || getAppConfigDirName(options.isDev)
      this.dbPath = path.join(homeDir, configDirName, 'sessions', 'data.db')
    }

    this.initDatabase()
  }

  getDbPath(): string {
    return this.dbPath
  }

  getDb(): DatabaseType {
    if (!this.db || !this.db.open) {
      this.initDatabase()
    }
    return this.db!
  }

  private initDatabase(): void {
    if (this.db && this.db.open) {
      return
    }

    this.statementCache.clear()

    if (this.dbPath !== ':memory:') {
      const dir = path.dirname(this.dbPath)
      fsSync.mkdirSync(dir, { recursive: true })
    }

    this.db = new Database(this.dbPath)

    // SQLite Configurations
    try {
      this.db.pragma('journal_mode = WAL')
    } catch {
      // Memory or special filesystems may ignore WAL
    }
    this.db.pragma('busy_timeout = 5000')
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('synchronous = NORMAL')

    // Create Tables and Indexes
    this.createTables()
  }

  private createTables(): void {
    if (!this.db) return
    applySessionSchemaAndMigrations(this.db)
  }

  async get(
    sessionId: string,
  ): Promise<{
    id: string
    version: number
    entries: any[]
    subAgents?: any[]
    modelId?: string
    reasoningEffort?: string
    speed?: 'standard' | 'fast' | 'max'
    workLocation?: 'local' | 'worktree'
    worktreePath?: string
    environmentId?: string | null
    worktreeSetup?: WorktreeSessionSetup
  } | null> {
    if (!sessionId || typeof sessionId !== 'string') return null
    const db = this.getDb()

    const sessionRow = this.getStatement(
        'SELECT id, schedule_id, model_id, reasoning_effort, speed, work_location, worktree_path, environment_id, worktree_setup_json FROM sessions WHERE id = ?',
      ).get(sessionId) as
      | {
          id: string
          schedule_id?: string | null
          model_id?: string | null
          reasoning_effort?: string | null
          speed?: string | null
          work_location?: string | null
          worktree_path?: string | null
          environment_id?: string | null
          worktree_setup_json?: string | null
        }
      | undefined

    if (!sessionRow) {
      return null
    }

    const entryRows = this.getStatement(
        'SELECT payload_json FROM session_entries WHERE session_id = ? ORDER BY entry_index ASC',
      ).all(sessionId) as Array<{ payload_json: string }>

    const entries: any[] = []
    for (const row of entryRows) {
      try {
        entries.push(JSON.parse(row.payload_json))
      } catch {
        // Ignore corrupt JSON payload
      }
    }

    const subAgentRows = this.getStatement(
        'SELECT id, session_id, parent_session_id, parent_tool_call_id, name, model_id, reasoning_effort, status, color, icon, last_message, error_message, role_id, role_name, role_prompt, depth, parent_agent_id, created_at, updated_at FROM subagents WHERE parent_session_id = ? ORDER BY created_at ASC',
      ).all(sessionId) as Array<{
        id: string
        session_id: string
        parent_session_id: string
        parent_tool_call_id: string | null
        name: string
        model_id: string | null
        reasoning_effort: string | null
        status: string
        color: string | null
        icon: string | null
        last_message: string | null
        error_message: string | null
        role_id: string | null
        role_name: string | null
        role_prompt: string | null
        depth: number | null
        parent_agent_id: string | null
        created_at: number
        updated_at: number
      }>

    const subAgents = subAgentRows.map((row) => ({
      id: row.id,
      name: row.name,
      color: row.color ?? undefined,
      icon: row.icon ?? undefined,
      parentSessionId: row.parent_session_id,
      sessionId: row.session_id,
      modelId: row.model_id ?? undefined,
      ...(row.reasoning_effort ? { reasoningEffort: row.reasoning_effort } : {}),
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.parent_tool_call_id ? { parentToolCallId: row.parent_tool_call_id } : {}),
      ...(row.last_message ? { lastMessage: row.last_message } : {}),
      ...(row.error_message ? { errorMessage: row.error_message } : {}),
      ...(row.role_id ? { roleId: row.role_id } : {}),
      ...(row.role_name ? { roleName: row.role_name } : {}),
      ...(row.role_prompt ? { rolePrompt: row.role_prompt } : {}),
      ...(typeof row.depth === 'number' ? { depth: row.depth } : {}),
      ...(row.parent_agent_id ? { parentAgentId: row.parent_agent_id } : {}),
    }))

    const workLocation =
      sessionRow.work_location === 'worktree'
        ? 'worktree'
        : sessionRow.work_location === 'local'
          ? 'local'
          : undefined
    const worktreeSetup = parseWorktreeSetup(sessionRow.worktree_setup_json)

    return {
      id: sessionId,
      version: 2,
      entries,
      ...(subAgents.length > 0 ? { subAgents } : {}),
      ...(sessionRow.schedule_id ? { scheduleId: sessionRow.schedule_id } : {}),
      ...(sessionRow.model_id ? { modelId: sessionRow.model_id } : {}),
      ...(sessionRow.reasoning_effort
        ? { reasoningEffort: sessionRow.reasoning_effort }
        : {}),
      ...(sessionRow.speed === 'standard' ||
      sessionRow.speed === 'fast' ||
      sessionRow.speed === 'max'
        ? { speed: sessionRow.speed }
        : {}),
      ...(workLocation ? { workLocation } : {}),
      ...(sessionRow.worktree_path ? { worktreePath: sessionRow.worktree_path } : {}),
      ...(sessionRow.environment_id !== undefined && sessionRow.environment_id !== null
        ? { environmentId: sessionRow.environment_id }
        : {}),
      ...(worktreeSetup ? { worktreeSetup } : {}),
    }
  }

  async set(sessionId: string, data: unknown): Promise<void> {
    if (!sessionId || typeof sessionId !== 'string') return
    const db = this.getDb()

    let entries: any[] = []
    let subAgents: any[] | undefined = undefined
    let projectId: string | null = null
    let scheduleId: string | null = null
    let parentSessionId: string | null = null
    let isSubagent: number | null = null
    let explicitTitle: string | null = null
    let branch: string | null = null
    let pinned: number | null = null
    let unread: number | null = null
    let archivedAt: number | null = null
    let rightSidebarJson: string | null = null
    let firstPromptAt: number | null = null
    const now = Date.now()
    let createdAt: number | null = null
    let updatedAt: number | null = null
    let speed: string | null = null
    let reasoningEffort: string | null = null
    let modelId: string | null = null
    let workLocation: string | null = null
    let worktreePath: string | null = null
    let environmentId: string | null = null
    let worktreeSetupJson: string | null = null
    let pinnedSummaryVisible: number | null = null

    if (Array.isArray(data)) {
      entries = data
    } else if (data && typeof data === 'object') {
      const record = data as Record<string, any>
      if (Array.isArray(record.entries)) {
        entries = record.entries
      }
      if (Array.isArray(record.subAgents)) {
        subAgents = record.subAgents
      }
      if (typeof record.projectId === 'string') {
        projectId = record.projectId
      }
      if (typeof record.scheduleId === 'string') {
        scheduleId = record.scheduleId
      } else if (typeof record.schedule_id === 'string') {
        scheduleId = record.schedule_id
      }
      if (typeof record.parentSessionId === 'string') {
        parentSessionId = record.parentSessionId
      }
      if (typeof record.isSubagent === 'boolean') {
        isSubagent = record.isSubagent ? 1 : 0
      } else if (typeof record.isSubagent === 'number') {
        isSubagent = record.isSubagent ? 1 : 0
      }
      if (typeof record.title === 'string' && record.title.trim()) {
        explicitTitle = record.title.trim()
      }
      if (typeof record.branch === 'string') {
        branch = record.branch
      }
      if (typeof record.pinned === 'boolean') {
        pinned = record.pinned ? 1 : 0
      } else if (typeof record.pinned === 'number') {
        pinned = record.pinned ? 1 : 0
      }
      if (record.unread !== undefined) {
        unread = encodeUnread(record.unread)
      }
      if (typeof record.archivedAt === 'number') {
        archivedAt = record.archivedAt
      }
      if (record.rightSidebar && typeof record.rightSidebar === 'object') {
        rightSidebarJson = JSON.stringify(record.rightSidebar)
      } else if (typeof record.right_sidebar_json === 'string') {
        rightSidebarJson = record.right_sidebar_json
      }
      if (typeof record.firstPromptAt === 'number' && record.firstPromptAt > 0) {
        firstPromptAt = record.firstPromptAt
      }
      if (typeof record.workLocation === 'string') {
        workLocation = record.workLocation
      } else if (typeof record.work_location === 'string') {
        workLocation = record.work_location
      }
      if (typeof record.worktreePath === 'string') {
        worktreePath = record.worktreePath
      } else if (typeof record.worktree_path === 'string') {
        worktreePath = record.worktree_path
      }
      if (typeof record.environmentId === 'string') {
        environmentId = record.environmentId
      } else if (typeof record.environment_id === 'string') {
        environmentId = record.environment_id
      }
      if (record.worktreeSetup && typeof record.worktreeSetup === 'object') {
        worktreeSetupJson = JSON.stringify(record.worktreeSetup)
      } else if (typeof record.worktree_setup_json === 'string') {
        worktreeSetupJson = record.worktree_setup_json
      }
      let pinnedSummaryVisible: number | null = null
      if (typeof record.pinnedSummaryVisible === 'boolean') {
        pinnedSummaryVisible = record.pinnedSummaryVisible ? 1 : 0
      } else if (typeof record.pinnedSummaryVisible === 'number') {
        pinnedSummaryVisible = record.pinnedSummaryVisible ? 1 : 0
      } else if (typeof record.pinned_summary_visible === 'number') {
        pinnedSummaryVisible = record.pinned_summary_visible ? 1 : 0
      }
      if (typeof record.createdAt === 'number') {
        createdAt = record.createdAt
      }
      if (typeof record.updatedAt === 'number') {
        updatedAt = record.updatedAt
      }
      if (typeof record.speed === 'string') {
        speed = record.speed
      }
      if (typeof record.reasoningEffort === 'string') {
        reasoningEffort = record.reasoningEffort
      }
      if (typeof record.modelId === 'string') {
        modelId = record.modelId
      } else if (typeof record.model === 'string') {
        modelId = record.model
      }
    }

    if (!firstPromptAt && Array.isArray(entries)) {
      const firstUser = entries.find(
        (e: any) => e && (e.kind === 'user' || e.role === 'user'),
      )
      if (firstUser && typeof firstUser.createdAt === 'number' && firstUser.createdAt > 0) {
        firstPromptAt = firstUser.createdAt
      }
    }

    const initialTitle =
      explicitTitle ||
      this.extractTitleFromEntries(entries) ||
      (isSubagent === 1 ? 'Subagent' : 'New Session')

    const upsertSessionStmt = this.getStatement(`
      INSERT INTO sessions (
        id, project_id, schedule_id, parent_session_id, is_subagent, title, branch, pinned, unread, archived_at, right_sidebar_json, first_prompt_at, model_id, reasoning_effort, speed, work_location, worktree_path, environment_id, worktree_setup_json, pinned_summary_visible, created_at, updated_at
      ) VALUES (
        @id,
        @project_id,
        @schedule_id,
        @parent_session_id,
        COALESCE(@is_subagent, 0),
        COALESCE(@initial_title, CASE WHEN @is_subagent = 1 THEN 'Subagent' ELSE 'New Session' END),
        @branch,
        COALESCE(@pinned, 0),
        COALESCE(@unread, 0),
        @archived_at,
        @right_sidebar_json,
        @first_prompt_at,
        @model_id,
        @reasoning_effort,
        @speed,
        @work_location,
        @worktree_path,
        @environment_id,
        @worktree_setup_json,
        @pinned_summary_visible,
        COALESCE(@created_at, @now),
        COALESCE(@updated_at, @now)
      ) ON CONFLICT(id) DO UPDATE SET
        project_id = CASE WHEN @project_id IS NOT NULL THEN @project_id ELSE sessions.project_id END,
        schedule_id = CASE WHEN @schedule_id IS NOT NULL THEN @schedule_id ELSE sessions.schedule_id END,
        parent_session_id = CASE WHEN @parent_session_id IS NOT NULL THEN @parent_session_id ELSE sessions.parent_session_id END,
        is_subagent = CASE WHEN @is_subagent IS NOT NULL THEN @is_subagent ELSE sessions.is_subagent END,
        title = CASE WHEN @explicit_title IS NOT NULL AND @explicit_title != '' THEN @explicit_title ELSE sessions.title END,
        branch = CASE WHEN @branch IS NOT NULL THEN @branch ELSE sessions.branch END,
        pinned = CASE WHEN @pinned IS NOT NULL THEN @pinned ELSE sessions.pinned END,
        -- Content saves must not overwrite read state managed by setMeta.
        unread = sessions.unread,
        archived_at = CASE WHEN @archived_at IS NOT NULL THEN @archived_at ELSE sessions.archived_at END,
        right_sidebar_json = CASE WHEN @right_sidebar_json IS NOT NULL THEN @right_sidebar_json ELSE sessions.right_sidebar_json END,
        first_prompt_at = CASE WHEN @first_prompt_at IS NOT NULL THEN @first_prompt_at ELSE sessions.first_prompt_at END,
        model_id = CASE WHEN @model_id IS NOT NULL THEN @model_id ELSE sessions.model_id END,
        reasoning_effort = CASE WHEN @reasoning_effort IS NOT NULL THEN @reasoning_effort ELSE sessions.reasoning_effort END,
        speed = CASE WHEN @speed IS NOT NULL THEN @speed ELSE sessions.speed END,
        work_location = CASE WHEN @work_location IS NOT NULL THEN @work_location ELSE sessions.work_location END,
        worktree_path = CASE WHEN @worktree_path IS NOT NULL THEN @worktree_path ELSE sessions.worktree_path END,
        environment_id = CASE WHEN @environment_id IS NOT NULL THEN @environment_id ELSE sessions.environment_id END,
        worktree_setup_json = CASE WHEN @worktree_setup_json IS NOT NULL THEN @worktree_setup_json ELSE sessions.worktree_setup_json END,
        pinned_summary_visible = CASE WHEN @pinned_summary_visible IS NOT NULL THEN @pinned_summary_visible ELSE sessions.pinned_summary_visible END,
        updated_at = COALESCE(@updated_at, @now)
    `)

    const getSessionMetaStmt = this.getStatement(`
      SELECT project_id, parent_session_id, is_subagent FROM sessions WHERE id = ?
    `)

    const deleteEntriesStmt = this.getStatement(`DELETE FROM session_entries WHERE session_id = ?`)

    const insertEntryStmt = this.getStatement(`
      INSERT INTO session_entries (
        id, session_id, kind, version, created_at, entry_index, payload_json
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?
      ) ON CONFLICT(id) DO UPDATE SET
        session_id = excluded.session_id,
        kind = excluded.kind,
        version = excluded.version,
        created_at = excluded.created_at,
        entry_index = excluded.entry_index,
        payload_json = excluded.payload_json
    `)

    const upsertSubAgentStmt = this.getStatement(`
      INSERT INTO subagents (
        id, session_id, parent_session_id, parent_tool_call_id, name, model_id, reasoning_effort, status, color, icon, last_message, error_message, role_id, role_name, role_prompt, depth, parent_agent_id, created_at, updated_at
      ) VALUES (
        @id, @session_id, @parent_session_id, @parent_tool_call_id, @name, @model_id, @reasoning_effort, @status, @color, @icon, @last_message, @error_message, @role_id, @role_name, @role_prompt, @depth, @parent_agent_id, @created_at, @updated_at
      ) ON CONFLICT(id) DO UPDATE SET
        session_id = excluded.session_id,
        parent_session_id = excluded.parent_session_id,
        parent_tool_call_id = excluded.parent_tool_call_id,
        name = excluded.name,
        model_id = excluded.model_id,
        reasoning_effort = excluded.reasoning_effort,
        status = excluded.status,
        color = excluded.color,
        icon = excluded.icon,
        last_message = excluded.last_message,
        error_message = excluded.error_message,
        role_id = excluded.role_id,
        role_name = excluded.role_name,
        role_prompt = excluded.role_prompt,
        depth = excluded.depth,
        parent_agent_id = excluded.parent_agent_id,
        updated_at = excluded.updated_at
    `)

    const upsertChildSessionStmt = this.getStatement(`
      INSERT INTO sessions (
        id, project_id, parent_session_id, is_subagent, title, created_at, updated_at
      ) VALUES (
        @id, @project_id, @parent_session_id, 1, COALESCE(@title, 'Subagent'), @created_at, @updated_at
      ) ON CONFLICT(id) DO UPDATE SET
        project_id = COALESCE(@project_id, sessions.project_id),
        parent_session_id = excluded.parent_session_id,
        is_subagent = 1,
        updated_at = excluded.updated_at
    `)

    const updateChildTurnsStmt = this.getStatement(`
      UPDATE conversation_turns
      SET is_subagent = 1, parent_session_id = @parentId, project_id = COALESCE(@projectId, project_id)
      WHERE session_id = @childSessionId
    `)

    const updateChildSkillsStmt = this.getStatement(`
      UPDATE skill_invocations
      SET project_id = COALESCE(@projectId, project_id)
      WHERE session_id = @childSessionId
    `)

    const deleteTurnsStmt = this.getStatement(`DELETE FROM conversation_turns WHERE session_id = ?`)
    const deleteSkillsStmt = this.getStatement(`DELETE FROM skill_invocations WHERE session_id = ?`)

    const insertTurnStmt = this.getStatement(`
      INSERT INTO conversation_turns (
        id, session_id, project_id, parent_session_id, is_subagent,
        model_id, speed, reasoning_effort, started_at, completed_at,
        duration_ms, tokens_input, tokens_output, tokens_cache_read,
        tokens_cache_write, tokens_reasoning, tokens_total,
        cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total,
        status
      ) VALUES (
        @id, @session_id, @project_id, @parent_session_id, @is_subagent,
        @model_id, @speed, @reasoning_effort, @started_at, @completed_at,
        @duration_ms, @tokens_input, @tokens_output, @tokens_cache_read,
        @tokens_cache_write, @tokens_reasoning, @tokens_total,
        @cost_input, @cost_output, @cost_cache_read, @cost_cache_write, @cost_total,
        @status
      )
    `)

    const insertSkillStmt = this.getStatement(`
      INSERT INTO skill_invocations (
        id, turn_id, session_id, project_id, model_id, skill_name, invoked_at
      ) VALUES (
        @id, @turn_id, @session_id, @project_id, @model_id, @skill_name, @invoked_at
      )
    `)

    const saveTransaction = db.transaction(() => {
      // 1. Upsert session row
      upsertSessionStmt.run({
        id: sessionId,
        project_id: projectId,
        schedule_id: scheduleId,
        parent_session_id: parentSessionId,
        is_subagent: isSubagent,
        initial_title: initialTitle,
        explicit_title: explicitTitle,
        branch,
        pinned,
        unread,
        archived_at: archivedAt,
        right_sidebar_json: rightSidebarJson,
        first_prompt_at: firstPromptAt,
        model_id: modelId,
        reasoning_effort: reasoningEffort,
        speed,
        work_location: workLocation,
        worktree_path: worktreePath,
        environment_id: environmentId,
        worktree_setup_json: worktreeSetupJson,
        pinned_summary_visible: pinnedSummaryVisible,
        created_at: createdAt,
        updated_at: updatedAt,
        now,
      })

      // Query actual persisted session metadata
      const sessionMeta = getSessionMetaStmt.get(sessionId) as
        | {
            project_id: string | null
            parent_session_id: string | null
            is_subagent: number
          }
        | undefined

      const effectiveProjectId = sessionMeta?.project_id ?? projectId ?? null
      const effectiveParentSessionId = sessionMeta?.parent_session_id ?? parentSessionId ?? null
      const effectiveIsSubagent = sessionMeta?.is_subagent ?? isSubagent ?? 0

      // 2. Refresh session entries
      deleteEntriesStmt.run(sessionId)
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]
        const entryId =
          entry?.id ||
          `${sessionId}-entry-${i}-${now}-${Math.random().toString(36).slice(2, 6)}`
        const kind = entry?.kind || entry?.type || 'unknown'
        const version = typeof entry?.version === 'number' ? entry.version : 1
        const entryCreatedAt = entry?.createdAt || entry?.timestamp || now
        insertEntryStmt.run(
          entryId,
          sessionId,
          kind,
          version,
          entryCreatedAt,
          i,
          JSON.stringify(entry),
        )
      }

      // 3. Upsert subagents if provided
      if (subAgents !== undefined) {
        const validSubAgents = (subAgents as any[]).map((sa) => {
          const saId = sa?.id || crypto.randomUUID()
          return {
            id: saId,
            sessionId: sa?.sessionId || sa?.session_id || saId,
            parentSessionId: sa?.parentSessionId || sa?.parent_session_id || sessionId,
            parentToolCallId: sa?.parentToolCallId || sa?.parent_tool_call_id || null,
            name: sa?.name || 'Subagent',
            modelId: sa?.modelId || sa?.model_id || null,
            reasoningEffort: sa?.reasoningEffort || sa?.reasoning_effort || null,
            status: sa?.status || 'completed',
            color: sa?.color || null,
            icon: sa?.icon || null,
            lastMessage: sa?.lastMessage || sa?.last_message || null,
            errorMessage: sa?.errorMessage || sa?.error_message || null,
            roleId: sa?.roleId || sa?.role_id || null,
            roleName: sa?.roleName || sa?.role_name || null,
            rolePrompt: sa?.rolePrompt || sa?.role_prompt || null,
            depth: typeof sa?.depth === 'number' ? sa.depth : 1,
            parentAgentId: sa?.parentAgentId || sa?.parent_agent_id || null,
            createdAt:
              typeof sa?.createdAt === 'number'
                ? sa.createdAt
                : typeof sa?.created_at === 'number'
                  ? sa.created_at
                  : now,
            updatedAt:
              typeof sa?.updatedAt === 'number'
                ? sa.updatedAt
                : typeof sa?.updated_at === 'number'
                  ? sa.updated_at
                  : now,
          }
        })

        const saIds = validSubAgents.map((sa) => sa.id)
        if (saIds.length === 0) {
          this.getStatement('DELETE FROM subagents WHERE parent_session_id = ?').run(sessionId)
        } else {
          const existingSaRows = this.getStatement(
            'SELECT id FROM subagents WHERE parent_session_id = ?',
          ).all(sessionId) as Array<{ id: string }>
          const saIdSet = new Set(saIds)
          const deleteSaStmt = this.getStatement('DELETE FROM subagents WHERE id = ?')
          for (const row of existingSaRows) {
            if (!saIdSet.has(row.id)) {
              deleteSaStmt.run(row.id)
            }
          }
        }

        for (const sa of validSubAgents) {
          upsertSubAgentStmt.run({
            id: sa.id,
            session_id: sa.sessionId,
            parent_session_id: sa.parentSessionId,
            parent_tool_call_id: sa.parentToolCallId,
            name: sa.name,
            model_id: sa.modelId,
            reasoning_effort: sa.reasoningEffort,
            status: sa.status,
            color: sa.color,
            icon: sa.icon,
            last_message: sa.lastMessage,
            error_message: sa.errorMessage,
            role_id: sa.roleId,
            role_name: sa.roleName,
            role_prompt: sa.rolePrompt,
            depth: sa.depth,
            parent_agent_id: sa.parentAgentId,
            created_at: sa.createdAt,
            updated_at: sa.updatedAt,
          })

          // Ensure corresponding child session row exists
          if (sa.sessionId && sa.sessionId !== sessionId) {
            upsertChildSessionStmt.run({
              id: sa.sessionId,
              project_id: effectiveProjectId,
              parent_session_id: sa.parentSessionId,
              title: sa.name,
              created_at: sa.createdAt,
              updated_at: sa.updatedAt,
            })

            // Backfill child conversation_turns and skill_invocations
            updateChildTurnsStmt.run({
              parentId: sa.parentSessionId,
              projectId: effectiveProjectId,
              childSessionId: sa.sessionId,
            })

            updateChildSkillsStmt.run({
              projectId: effectiveProjectId,
              childSessionId: sa.sessionId,
            })
          }
        }
      }

      // Query existing turns before deleting to preserve per-turn historical speed and reasoning_effort
      const existingTurnRows = this.getStatement(
        'SELECT id, speed, reasoning_effort FROM conversation_turns WHERE session_id = ?',
      ).all(sessionId) as Array<{ id: string; speed: string; reasoning_effort: string | null }>
      const existingTurnMap = new Map<string, { speed: string; reasoning_effort: string | null }>()
      for (const row of existingTurnRows) {
        existingTurnMap.set(row.id, {
          speed: row.speed,
          reasoning_effort: row.reasoning_effort,
        })
      }

      // 4. Refresh conversation turns and skill invocations
      deleteSkillsStmt.run(sessionId)
      deleteTurnsStmt.run(sessionId)

      const turns = this.extractTurnsFromEntries(entries)
      for (let tIdx = 0; tIdx < turns.length; tIdx++) {
        const turn = turns[tIdx]
        const userEntry = turn.userEntry
        const turnId = userEntry?.id || `${sessionId}-turn-${tIdx}`
        const existingTurn = existingTurnMap.get(turnId)

        const assistantEntries = turn.entries.filter(
          (e) => e && (e.kind === 'assistant' || e.type === 'assistant'),
        )
        const lastAssistant =
          assistantEntries.length > 0 ? assistantEntries[assistantEntries.length - 1] : null

        const turnModelId =
          lastAssistant?.model || lastAssistant?.modelId || modelId || null

        const turnSpeed = existingTurn?.speed || speed || 'standard'
        const turnReasoningEffort =
          existingTurn &&
          existingTurn.reasoning_effort !== undefined &&
          existingTurn.reasoning_effort !== null
            ? existingTurn.reasoning_effort
            : lastAssistant?.reasoningEffort ||
              lastAssistant?.reasoning_effort ||
              reasoningEffort ||
              null

        const startedAt =
          typeof userEntry?.createdAt === 'number'
            ? userEntry.createdAt
            : typeof userEntry?.timestamp === 'number'
              ? userEntry.timestamp
              : now

        let completedAt = startedAt
        for (const entry of turn.entries) {
          if (
            entry &&
            (entry.kind === 'assistant' ||
              entry.type === 'assistant' ||
              entry.kind === 'compaction' ||
              entry.type === 'compaction')
          ) {
            const ts =
              typeof entry.completedAt === 'number'
                ? entry.completedAt
                : typeof entry.createdAt === 'number'
                  ? entry.createdAt
                  : typeof entry.timestamp === 'number'
                    ? entry.timestamp
                    : 0
            if (ts > completedAt) {
              completedAt = ts
            }
          }
        }

        const durationMs = Math.max(0, completedAt - startedAt)
        const turnStatus =
          (lastAssistant && typeof lastAssistant.status === 'string' && lastAssistant.status) ||
          'done'

        let tokensInput = 0
        let tokensOutput = 0
        let tokensCacheRead = 0
        let tokensCacheWrite = 0
        let tokensReasoning = 0
        let tokensTotal = 0

        let costInput = 0.0
        let costOutput = 0.0
        let costCacheRead = 0.0
        let costCacheWrite = 0.0
        let costTotal = 0.0

        const usageEntries = turn.entries.filter(
          (e) =>
            e &&
            (e.kind === 'assistant' ||
              e.type === 'assistant' ||
              e.kind === 'compaction' ||
              e.type === 'compaction'),
        )

        for (const entryWithUsage of usageEntries) {
          const u = entryWithUsage?.usage
          if (u && typeof u === 'object') {
            const inp = Number(u.input ?? u.prompt_tokens ?? u.inputTokens) || 0
            const out = Number(u.output ?? u.completion_tokens ?? u.outputTokens) || 0
            const cr =
              Number(u.cacheRead ?? u.cache_read ?? u.cached_tokens ?? u.cacheReadTokens) || 0
            const cw = Number(u.cacheWrite ?? u.cache_write ?? u.cacheWriteTokens) || 0
            const r = Number(u.reasoning ?? u.reasoning_tokens ?? u.reasoningTokens) || 0
            const tot =
              typeof u.totalTokens === 'number'
                ? u.totalTokens
                : typeof u.total_tokens === 'number'
                  ? u.total_tokens
                  : inp + out

            tokensInput += inp
            tokensOutput += out
            tokensCacheRead += cr
            tokensCacheWrite += cw
            tokensReasoning += r
            tokensTotal += tot

            if (u.cost && typeof u.cost === 'object') {
              const c = u.cost
              const cinp = Number(c.input) || 0.0
              const cout = Number(c.output) || 0.0
              const ccr = Number(c.cacheRead ?? c.cache_read) || 0.0
              const ccw = Number(c.cacheWrite ?? c.cache_write) || 0.0
              const ctot =
                typeof c.total === 'number' ? c.total : cinp + cout + ccr + ccw

              costInput += cinp
              costOutput += cout
              costCacheRead += ccr
              costCacheWrite += ccw
              costTotal += ctot
            }
          }
        }

        insertTurnStmt.run({
          id: turnId,
          session_id: sessionId,
          project_id: effectiveProjectId,
          parent_session_id: effectiveParentSessionId,
          is_subagent: effectiveIsSubagent,
          model_id: turnModelId,
          speed: turnSpeed,
          reasoning_effort: turnReasoningEffort,
          started_at: startedAt,
          completed_at: completedAt,
          duration_ms: durationMs,
          tokens_input: tokensInput,
          tokens_output: tokensOutput,
          tokens_cache_read: tokensCacheRead,
          tokens_cache_write: tokensCacheWrite,
          tokens_reasoning: tokensReasoning,
          tokens_total: tokensTotal,
          cost_input: costInput,
          cost_output: costOutput,
          cost_cache_read: costCacheRead,
          cost_cache_write: costCacheWrite,
          cost_total: costTotal,
          status: turnStatus,
        })

        // Extract skills for this turn
        const turnSkills = this.extractSkillsFromTurn(userEntry, turn.entries)
        for (let sIdx = 0; sIdx < turnSkills.length; sIdx++) {
          const skillName = turnSkills[sIdx]
          insertSkillStmt.run({
            id: `${turnId}-skill-${sIdx}`,
            turn_id: turnId,
            session_id: sessionId,
            project_id: effectiveProjectId,
            model_id: turnModelId,
            skill_name: skillName,
            invoked_at: startedAt,
          })
        }
      }
    })

    saveTransaction()
  }

  async delete(sessionId: string): Promise<void> {
    if (!sessionId || typeof sessionId !== 'string') return
    const db = this.getDb()

    const selectChildStmt = this.getStatement('SELECT id FROM sessions WHERE parent_session_id = ?')
    const deleteSessionStmt = this.getStatement('DELETE FROM sessions WHERE id = ?')

    const deleteTx = db.transaction(() => {
      // Find all child sessions where parent_session_id = sessionId and delete them first
      const childSessions = selectChildStmt.all(sessionId) as Array<{ id: string }>
      for (const child of childSessions) {
        deleteSessionStmt.run(child.id)
      }

      // Delete the main session (cascades to session_entries, subagents, turns, skills)
      deleteSessionStmt.run(sessionId)
    })

    deleteTx()
  }

  async list(): Promise<string[]> {
    try {
      const finalRows = this.getStatement('SELECT id FROM sessions ORDER BY updated_at DESC')
        .all() as Array<{ id: string }>
      return finalRows.map((r) => r.id)
    } catch {
      return []
    }
  }

  async listSessions(): Promise<SessionItem[]> {
    try {
      const rows = this.getStatement(`
          SELECT id, project_id, schedule_id, parent_session_id, branch, title, pinned, unread, archived_at, right_sidebar_json, first_prompt_at, model_id, reasoning_effort, speed, work_location, worktree_path, environment_id, worktree_setup_json, pinned_summary_visible, created_at, updated_at
          FROM sessions
          WHERE is_subagent = 0
          ORDER BY pinned DESC, updated_at DESC
        `)
        .all() as SessionRow[]

      return rows.map(mapSessionRow)
    } catch {
      return []
    }
  }

  async getMeta(sessionId: string): Promise<SessionItem | null> {
    if (!sessionId || typeof sessionId !== 'string') return null
    const db = this.getDb()
    const row = this.getStatement(`
        SELECT id, project_id, schedule_id, parent_session_id, branch, title, pinned, unread, archived_at, right_sidebar_json, first_prompt_at, model_id, reasoning_effort, speed, work_location, worktree_path, environment_id, worktree_setup_json, pinned_summary_visible, created_at, updated_at
        FROM sessions
        WHERE id = ?
      `)
      .get(sessionId) as SessionRow | undefined

    if (!row) return null
    return mapSessionRow(row)
  }

  async listSessionsByScheduleId(scheduleId: string): Promise<SessionItem[]> {
    if (!scheduleId || typeof scheduleId !== 'string') return []
    try {
      const rows = this.getStatement(`
          SELECT id, project_id, schedule_id, parent_session_id, branch, title, pinned, unread, archived_at, right_sidebar_json, first_prompt_at, model_id, reasoning_effort, speed, work_location, worktree_path, environment_id, worktree_setup_json, pinned_summary_visible, created_at, updated_at
          FROM sessions
          WHERE schedule_id = ? AND is_subagent = 0
          ORDER BY created_at DESC
        `)
        .all(scheduleId) as SessionRow[]

      return rows.map(mapSessionRow)
    } catch {
      return []
    }
  }

  async setMeta(meta: Partial<SessionItem> & { id: string }): Promise<void> {
    if (!meta || !meta.id || typeof meta.id !== 'string') return
    const db = this.getDb()
    const now = Date.now()

    const existing = this.getStatement(
        'SELECT id, project_id, schedule_id, parent_session_id, branch, title, pinned, unread, archived_at, right_sidebar_json, first_prompt_at, model_id, reasoning_effort, speed, work_location, worktree_path, environment_id, worktree_setup_json, pinned_summary_visible, created_at, updated_at FROM sessions WHERE id = ?',
      )
      .get(meta.id) as SessionRow | undefined

    const setMetaTx = db.transaction(() => {
      if (existing) {
        const newTitle =
          'title' in meta && meta.title !== undefined && meta.title !== ''
            ? meta.title
            : existing.title
        const newProjectId =
          'projectId' in meta
            ? meta.projectId || null
            : existing.project_id
        const newScheduleId =
          'scheduleId' in meta
            ? meta.scheduleId || null
            : existing.schedule_id ?? null
        const newParentSessionId =
          'parentSessionId' in meta
            ? meta.parentSessionId || null
            : existing.parent_session_id ?? null
        const newBranch =
          'branch' in meta
            ? meta.branch || null
            : existing.branch
        const newPinned =
          'pinned' in meta
            ? (meta.pinned ? 1 : 0)
            : existing.pinned
        const newUnread =
          'unread' in meta
            ? encodeUnread(meta.unread)
            : (existing.unread ?? 0)
        const newArchivedAt =
          'archivedAt' in meta
            ? (typeof meta.archivedAt === 'number' && meta.archivedAt > 0 ? meta.archivedAt : null)
            : existing.archived_at
        let newRightSidebarJson: string | null = existing.right_sidebar_json
        if (meta.rightSidebar === null) {
          newRightSidebarJson = null
        } else if (meta.rightSidebar !== undefined && typeof meta.rightSidebar === 'object') {
          newRightSidebarJson = JSON.stringify(meta.rightSidebar)
        }
        const newFirstPromptAt =
          'firstPromptAt' in meta
            ? (typeof meta.firstPromptAt === 'number' && meta.firstPromptAt > 0 ? meta.firstPromptAt : null)
            : existing.first_prompt_at
        const newModelId =
          'modelId' in meta ? meta.modelId || null : existing.model_id ?? null
        const newReasoningEffort =
          'reasoningEffort' in meta
            ? meta.reasoningEffort || null
            : existing.reasoning_effort ?? null
        const newSpeed =
          'speed' in meta ? meta.speed || null : existing.speed ?? null
        const newWorkLocation =
          'workLocation' in meta
            ? meta.workLocation || null
            : existing.work_location ?? null
        const newWorktreePath =
          'worktreePath' in meta
            ? meta.worktreePath || null
            : existing.worktree_path ?? null
        const newEnvironmentId =
          'environmentId' in meta
            ? meta.environmentId || null
            : existing.environment_id ?? null
        let newWorktreeSetupJson: string | null = existing.worktree_setup_json ?? null
        if (meta.worktreeSetup === null) {
          newWorktreeSetupJson = null
        } else if (meta.worktreeSetup !== undefined && typeof meta.worktreeSetup === 'object') {
          newWorktreeSetupJson = JSON.stringify(meta.worktreeSetup)
        }
        const newPinnedSummaryVisible =
          'pinnedSummaryVisible' in meta
            ? (meta.pinnedSummaryVisible !== undefined && meta.pinnedSummaryVisible !== null ? (meta.pinnedSummaryVisible ? 1 : 0) : null)
            : existing.pinned_summary_visible
        const newUpdatedAt =
          typeof meta.updatedAt === 'number' ? meta.updatedAt : now

        this.getStatement(`
          UPDATE sessions
          SET title = ?, project_id = ?, schedule_id = ?, parent_session_id = ?, branch = ?, pinned = ?, unread = ?, archived_at = ?, right_sidebar_json = ?, first_prompt_at = ?, model_id = ?, reasoning_effort = ?, speed = ?, work_location = ?, worktree_path = ?, environment_id = ?, worktree_setup_json = ?, pinned_summary_visible = ?, updated_at = ?
          WHERE id = ?
        `).run(newTitle, newProjectId, newScheduleId, newParentSessionId, newBranch, newPinned, newUnread, newArchivedAt, newRightSidebarJson, newFirstPromptAt, newModelId, newReasoningEffort, newSpeed, newWorkLocation, newWorktreePath, newEnvironmentId, newWorktreeSetupJson, newPinnedSummaryVisible, newUpdatedAt, meta.id)

        if ('projectId' in meta) {
          const effectiveProj = meta.projectId || null
          this.getStatement('UPDATE sessions SET project_id = ? WHERE parent_session_id = ?').run(
            effectiveProj,
            meta.id,
          )
          this.getStatement(
            'UPDATE conversation_turns SET project_id = ? WHERE session_id = ? OR parent_session_id = ?',
          ).run(effectiveProj, meta.id, meta.id)
          this.getStatement(
            'UPDATE skill_invocations SET project_id = ? WHERE session_id = ? OR session_id IN (SELECT id FROM sessions WHERE parent_session_id = ?)',
          ).run(effectiveProj, meta.id, meta.id)
        }
      } else {
        const title = meta.title || 'New Session'
        const projectId = meta.projectId || null
        const scheduleId = meta.scheduleId || null
        const parentSessionId = meta.parentSessionId || null
        const isSubagent = parentSessionId ? 1 : 0
        const branch = meta.branch || null
        const pinned = meta.pinned ? 1 : 0
        const unread = encodeUnread(meta.unread)
        const archivedAt =
          typeof meta.archivedAt === 'number' && meta.archivedAt > 0 ? meta.archivedAt : null
        let rightSidebarJson: string | null = null
        if (meta.rightSidebar && typeof meta.rightSidebar === 'object') {
          rightSidebarJson = JSON.stringify(meta.rightSidebar)
        }
        const firstPromptAt =
          typeof meta.firstPromptAt === 'number' && meta.firstPromptAt > 0 ? meta.firstPromptAt : null
        const modelId = meta.modelId || null
        const reasoningEffort = meta.reasoningEffort || null
        const speed = meta.speed || null
        const workLocation = meta.workLocation || null
        const worktreePath = meta.worktreePath || null
        const environmentId = meta.environmentId || null
        let worktreeSetupJson: string | null = null
        if (meta.worktreeSetup && typeof meta.worktreeSetup === 'object') {
          worktreeSetupJson = JSON.stringify(meta.worktreeSetup)
        }
        const pinnedSummaryVisible =
          meta.pinnedSummaryVisible !== undefined && meta.pinnedSummaryVisible !== null
            ? (meta.pinnedSummaryVisible ? 1 : 0)
            : null
        const createdAt = typeof meta.createdAt === 'number' ? meta.createdAt : now
        const updatedAt = typeof meta.updatedAt === 'number' ? meta.updatedAt : now

        this.getStatement(`
          INSERT INTO sessions (
            id, project_id, schedule_id, parent_session_id, is_subagent, title, branch, pinned, unread, archived_at, right_sidebar_json, first_prompt_at, model_id, reasoning_effort, speed, work_location, worktree_path, environment_id, worktree_setup_json, pinned_summary_visible, created_at, updated_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          )
        `).run(meta.id, projectId, scheduleId, parentSessionId, isSubagent, title, branch, pinned, unread, archivedAt, rightSidebarJson, firstPromptAt, modelId, reasoningEffort, speed, workLocation, worktreePath, environmentId, worktreeSetupJson, pinnedSummaryVisible, createdAt, updatedAt)
      }
    })

    setMetaTx()
  }

  async updateSubAgent(subAgent: SubAgentItem): Promise<void> {
    if (!subAgent || !subAgent.id || typeof subAgent.id !== 'string') return
    const db = this.getDb()
    const now = Date.now()

    const stmt = this.getStatement(`
      INSERT INTO subagents (
        id, session_id, parent_session_id, parent_tool_call_id, name, model_id, reasoning_effort, status, color, icon, last_message, error_message, created_at, updated_at
      ) VALUES (
        @id,
        COALESCE(@session_id, @id),
        COALESCE(@parent_session_id, ''),
        @parent_tool_call_id,
        COALESCE(@name, 'Subagent'),
        @model_id,
        @reasoning_effort,
        COALESCE(@status, 'completed'),
        @color,
        @icon,
        @last_message,
        @error_message,
        COALESCE(@created_at, @now),
        COALESCE(@updated_at, @now)
      ) ON CONFLICT(id) DO UPDATE SET
        session_id = COALESCE(excluded.session_id, subagents.session_id),
        parent_session_id = CASE WHEN excluded.parent_session_id != '' THEN excluded.parent_session_id ELSE subagents.parent_session_id END,
        parent_tool_call_id = CASE WHEN excluded.parent_tool_call_id IS NOT NULL THEN excluded.parent_tool_call_id ELSE subagents.parent_tool_call_id END,
        name = CASE WHEN excluded.name != 'Subagent' THEN excluded.name ELSE subagents.name END,
        model_id = CASE WHEN excluded.model_id IS NOT NULL THEN excluded.model_id ELSE subagents.model_id END,
        reasoning_effort = CASE WHEN excluded.reasoning_effort IS NOT NULL THEN excluded.reasoning_effort ELSE subagents.reasoning_effort END,
        status = excluded.status,
        color = CASE WHEN excluded.color IS NOT NULL THEN excluded.color ELSE subagents.color END,
        icon = CASE WHEN excluded.icon IS NOT NULL THEN excluded.icon ELSE subagents.icon END,
        last_message = CASE WHEN excluded.last_message IS NOT NULL THEN excluded.last_message ELSE subagents.last_message END,
        error_message = CASE WHEN excluded.error_message IS NOT NULL THEN excluded.error_message ELSE subagents.error_message END,
        updated_at = excluded.updated_at
    `)

    stmt.run({
      id: subAgent.id,
      session_id: subAgent.sessionId ?? null,
      parent_session_id: subAgent.parentSessionId ?? null,
      parent_tool_call_id: subAgent.parentToolCallId ?? null,
      name: subAgent.name ?? null,
      model_id: subAgent.modelId ?? null,
      reasoning_effort: subAgent.reasoningEffort ?? null,
      status: subAgent.status ?? null,
      color: subAgent.color ?? null,
      icon: subAgent.icon ?? null,
      last_message: subAgent.lastMessage ?? null,
      error_message: subAgent.errorMessage ?? null,
      created_at: typeof subAgent.createdAt === 'number' ? subAgent.createdAt : null,
      updated_at: typeof subAgent.updatedAt === 'number' ? subAgent.updatedAt : now,
      now,
    })
  }

  async queryMetrics(options: QueryMetricsOptions = {}): Promise<QueryMetricsResult> {
    const db = this.getDb()
    const topSkillsLimit =
      typeof options.topSkillsLimit === 'number' && options.topSkillsLimit > 0
        ? options.topSkillsLimit
        : 10
    const topModelsLimit =
      typeof options.topModelsLimit === 'number' && options.topModelsLimit > 0
        ? options.topModelsLimit
        : 10

    const { whereSql: turnWhereSql, params: turnParams } = this.buildTurnFilter(options)
    const { whereSql: skillWhereSql, params: skillParams } = this.buildSkillFilter(options)

    // Summary calculation
    const summary = this.calculateAggregateMetrics(
      db,
      turnWhereSql,
      turnParams,
      skillWhereSql,
      skillParams,
      topSkillsLimit,
      topModelsLimit,
    )

    let buckets: GranularBucketMetrics[] | undefined = undefined
    if (options.timeGranularity && options.timeGranularity !== 'all') {
      buckets = this.calculateGranularBuckets(
        db,
        options.timeGranularity,
        turnWhereSql,
        turnParams,
        skillWhereSql,
        skillParams,
        topSkillsLimit,
        topModelsLimit,
      )
    }

    let groups: GroupedMetricsItem[] | undefined = undefined
    if (options.groupByProject) {
      groups = this.calculateGroups(
        db,
        'project',
        options,
        turnWhereSql,
        turnParams,
        skillWhereSql,
        skillParams,
        topSkillsLimit,
        topModelsLimit,
      )
    } else if (options.groupByModel) {
      groups = this.calculateGroups(
        db,
        'model',
        options,
        turnWhereSql,
        turnParams,
        skillWhereSql,
        skillParams,
        topSkillsLimit,
        topModelsLimit,
      )
    }

    return {
      summary,
      ...(buckets !== undefined ? { buckets } : {}),
      ...(groups !== undefined ? { groups } : {}),
    }
  }

  private calculateGroups(
    db: DatabaseType,
    groupType: 'project' | 'model',
    options: QueryMetricsOptions,
    turnWhereSql: string,
    turnParams: any[],
    skillWhereSql: string,
    skillParams: any[],
    topSkillsLimit: number,
    topModelsLimit: number = 10,
  ): GroupedMetricsItem[] {
    const column = groupType === 'project' ? 'project_id' : 'model_id'
    const defaultVal = groupType === 'project' ? 'unassigned' : 'unknown'

    const distinctQuery = `
      SELECT DISTINCT COALESCE(NULLIF(${column}, ''), '${defaultVal}') as group_key
      FROM conversation_turns
      ${turnWhereSql}
      UNION
      SELECT DISTINCT COALESCE(NULLIF(${column}, ''), '${defaultVal}') as group_key
      FROM skill_invocations
      ${skillWhereSql}
      ORDER BY group_key ASC
    `

    const distinctRows = this.getStatement(distinctQuery)
      .all(...turnParams, ...skillParams) as Array<{ group_key: string }>

    const groups: GroupedMetricsItem[] = []

    for (const row of distinctRows) {
      const groupKey = row.group_key
      if (!groupKey) continue

      const { whereSql: groupTurnWhereSql, params: groupTurnParams } = this.buildTurnFilter(
        options,
        { groupType, groupKey },
      )
      const { whereSql: groupSkillWhereSql, params: groupSkillParams } = this.buildSkillFilter(
        options,
        { groupType, groupKey },
      )

      const groupSummary = this.calculateAggregateMetrics(
        db,
        groupTurnWhereSql,
        groupTurnParams,
        groupSkillWhereSql,
        groupSkillParams,
        topSkillsLimit,
        topModelsLimit,
      )

      let groupBuckets: GranularBucketMetrics[] | undefined = undefined
      if (options.timeGranularity && options.timeGranularity !== 'all') {
        groupBuckets = this.calculateGranularBuckets(
          db,
          options.timeGranularity,
          groupTurnWhereSql,
          groupTurnParams,
          groupSkillWhereSql,
          groupSkillParams,
          topSkillsLimit,
          topModelsLimit,
        )
      }

      groups.push({
        groupKey,
        summary: groupSummary,
        ...(groupBuckets !== undefined ? { buckets: groupBuckets } : {}),
      })
    }

    return groups
  }

  private calculateAggregateMetrics(
    db: DatabaseType,
    turnWhereSql: string,
    turnParams: any[],
    skillWhereSql: string,
    skillParams: any[],
    topSkillsLimit: number,
    topModelsLimit: number = 10,
  ): AggregateMetrics {
    // 1. Turn stats
    const turnStatsRow = this.getStatement(`
        SELECT
          COUNT(*) as total_chats,
          COALESCE(SUM(tokens_input), 0) as total_tokens_input,
          COALESCE(SUM(tokens_output), 0) as total_tokens_output,
          COALESCE(SUM(tokens_cache_read), 0) as total_tokens_cache_read,
          COALESCE(SUM(tokens_cache_write), 0) as total_tokens_cache_write,
          COALESCE(SUM(tokens_reasoning), 0) as total_tokens_reasoning,
          COALESCE(SUM(tokens_total), 0) as total_tokens,
          COALESCE(SUM(cost_total), 0.0) as total_cost,
          COALESCE(MAX(duration_ms), 0) as max_task_duration_ms,
          COALESCE(SUM(CASE WHEN speed = 'fast' THEN 1 ELSE 0 END), 0) as fast_mode_count
        FROM conversation_turns
        ${turnWhereSql}
      `)
      .get(...turnParams) as
      | {
          total_chats: number
          total_tokens_input: number
          total_tokens_output: number
          total_tokens_cache_read: number
          total_tokens_cache_write: number
          total_tokens_reasoning: number
          total_tokens: number
          total_cost: number
          max_task_duration_ms: number
          fast_mode_count: number
        }
      | undefined

    const totalChats = Number(turnStatsRow?.total_chats) || 0
    const totalTokens = Number(turnStatsRow?.total_tokens) || 0
    const tokensInput = Number(turnStatsRow?.total_tokens_input) || 0
    const tokensOutput = Number(turnStatsRow?.total_tokens_output) || 0
    const tokensCacheRead = Number(turnStatsRow?.total_tokens_cache_read) || 0
    const tokensCacheWrite = Number(turnStatsRow?.total_tokens_cache_write) || 0
    const tokensReasoning = Number(turnStatsRow?.total_tokens_reasoning) || 0
    const totalCost = Number(Number(turnStatsRow?.total_cost || 0).toFixed(6))
    const maxTaskDurationMs = Number(turnStatsRow?.max_task_duration_ms) || 0
    const fastCount = Number(turnStatsRow?.fast_mode_count) || 0
    const fastPercentage =
      totalChats > 0 ? Number(((fastCount / totalChats) * 100).toFixed(2)) : 0

    // 2. Top reasoning effort
    let topReasoningEffort: { level: string; count: number; percentage: number } | null = null
    if (totalChats > 0) {
      const reasoningWhere = turnWhereSql
        ? `${turnWhereSql} AND reasoning_effort IS NOT NULL AND TRIM(reasoning_effort) != ''`
        : `WHERE reasoning_effort IS NOT NULL AND TRIM(reasoning_effort) != ''`

      const topReasoningRow = this.getStatement(`
          SELECT
            reasoning_effort as level,
            COUNT(*) as count
          FROM conversation_turns
          ${reasoningWhere}
          GROUP BY reasoning_effort
          ORDER BY count DESC, level ASC
          LIMIT 1
        `)
        .get(...turnParams) as { level: string; count: number } | undefined

      if (topReasoningRow) {
        const rCount = Number(topReasoningRow.count)
        topReasoningEffort = {
          level: topReasoningRow.level,
          count: rCount,
          percentage: Number(((rCount / totalChats) * 100).toFixed(2)),
        }
      }
    }

    // 3. Streak calculation
    const dateRows = this.getStatement(`
        SELECT DISTINCT
          strftime('%Y-%m-%d', started_at / 1000, 'unixepoch', 'localtime') as active_date
        FROM conversation_turns
        ${turnWhereSql}
        ORDER BY active_date ASC
      `)
      .all(...turnParams) as Array<{ active_date: string }>

    const activeDates = dateRows.map((r) => r.active_date).filter(Boolean)
    const streaks = computeStreaks(activeDates)

    // 4. Skills summary
    const skillStatsRow = this.getStatement(`
        SELECT
          COUNT(DISTINCT skill_name) as unique_skills_count,
          COUNT(*) as total_skill_invocations
        FROM skill_invocations
        ${skillWhereSql}
      `)
      .get(...skillParams) as
      | { unique_skills_count: number; total_skill_invocations: number }
      | undefined

    const uniqueSkillsCount = Number(skillStatsRow?.unique_skills_count) || 0
    const totalSkillInvocations = Number(skillStatsRow?.total_skill_invocations) || 0

    // 5. Top skills
    const topSkillsRows = this.getStatement(`
        SELECT
          skill_name as name,
          COUNT(*) as count
        FROM skill_invocations
        ${skillWhereSql}
        GROUP BY skill_name
        ORDER BY count DESC, name ASC
        LIMIT ?
      `)
      .all(...skillParams, topSkillsLimit) as Array<{ name: string; count: number }>

    const topSkills = topSkillsRows.map((r) => ({
      name: r.name,
      count: Number(r.count),
    }))

    // 6. Top models
    const topModelsRows = this.getStatement(`
        SELECT
          COALESCE(NULLIF(TRIM(model_id), ''), 'unknown') as model_id,
          COUNT(*) as count,
          COALESCE(SUM(tokens_total), 0) as total_tokens
        FROM conversation_turns
        ${turnWhereSql}
        GROUP BY COALESCE(NULLIF(TRIM(model_id), ''), 'unknown')
        ORDER BY count DESC, total_tokens DESC, model_id ASC
        LIMIT ?
      `)
      .all(...turnParams, topModelsLimit) as Array<{
        model_id: string
        count: number
        total_tokens: number
      }>

    const topModels = topModelsRows.map((r) => {
      const count = Number(r.count)
      return {
        modelId: r.model_id,
        count,
        totalTokens: Number(r.total_tokens),
        percentage: totalChats > 0 ? Number(((count / totalChats) * 100).toFixed(1)) : 0,
      }
    })

    return {
      totalTokens,
      totalTokensBreakdown: {
        input: tokensInput,
        output: tokensOutput,
        cacheRead: tokensCacheRead,
        cacheWrite: tokensCacheWrite,
        reasoning: tokensReasoning,
      },
      totalCost,
      maxTaskDurationMs,
      currentStreakDays: streaks.currentStreakDays,
      longestStreakDays: streaks.longestStreakDays,
      fastMode: {
        count: fastCount,
        percentage: fastPercentage,
      },
      topReasoningEffort,
      uniqueSkillsCount,
      totalSkillInvocations,
      totalChats,
      topSkills,
      topModels,
    }
  }

  private calculateGranularBuckets(
    db: DatabaseType,
    granularity: MetricTimeGranularity,
    turnWhereSql: string,
    turnParams: any[],
    skillWhereSql: string,
    skillParams: any[],
    topSkillsLimit: number,
    topModelsLimit: number = 10,
  ): GranularBucketMetrics[] {
    const strftimePattern = GRANULARITY_FORMATS[granularity]
    if (!strftimePattern) {
      return []
    }

    // 1. Group turns by bucketKey
    const bucketTurnRows = this.getStatement(`
        SELECT
          strftime('${strftimePattern}', started_at / 1000, 'unixepoch', 'localtime') as bucket_key,
          COUNT(*) as total_chats,
          COALESCE(SUM(tokens_input), 0) as total_tokens_input,
          COALESCE(SUM(tokens_output), 0) as total_tokens_output,
          COALESCE(SUM(tokens_cache_read), 0) as total_tokens_cache_read,
          COALESCE(SUM(tokens_cache_write), 0) as total_tokens_cache_write,
          COALESCE(SUM(tokens_reasoning), 0) as total_tokens_reasoning,
          COALESCE(SUM(tokens_total), 0) as total_tokens,
          COALESCE(SUM(cost_total), 0.0) as total_cost,
          COALESCE(MAX(duration_ms), 0) as max_task_duration_ms,
          COALESCE(SUM(CASE WHEN speed = 'fast' THEN 1 ELSE 0 END), 0) as fast_mode_count,
          MIN(started_at) as min_started_at,
          MAX(completed_at) as max_completed_at
        FROM conversation_turns
        ${turnWhereSql}
        GROUP BY bucket_key
        ORDER BY bucket_key ASC
      `)
      .all(...turnParams) as Array<{
        bucket_key: string
        total_chats: number
        total_tokens_input: number
        total_tokens_output: number
        total_tokens_cache_read: number
        total_tokens_cache_write: number
        total_tokens_reasoning: number
        total_tokens: number
        total_cost: number
        max_task_duration_ms: number
        fast_mode_count: number
        min_started_at: number
        max_completed_at: number
      }>

    // 2. Reasoning effort per bucket
    const reasoningWhere = turnWhereSql
      ? `${turnWhereSql} AND reasoning_effort IS NOT NULL AND TRIM(reasoning_effort) != ''`
      : `WHERE reasoning_effort IS NOT NULL AND TRIM(reasoning_effort) != ''`

    const bucketReasoningRows = this.getStatement(`
        SELECT
          strftime('${strftimePattern}', started_at / 1000, 'unixepoch', 'localtime') as bucket_key,
          reasoning_effort as level,
          COUNT(*) as count
        FROM conversation_turns
        ${reasoningWhere}
        GROUP BY bucket_key, reasoning_effort
        ORDER BY bucket_key ASC, count DESC, level ASC
      `)
      .all(...turnParams) as Array<{
        bucket_key: string
        level: string
        count: number
      }>

    const bucketTopReasoningMap = new Map<string, { level: string; count: number }>()
    for (const row of bucketReasoningRows) {
      if (row.bucket_key && !bucketTopReasoningMap.has(row.bucket_key)) {
        bucketTopReasoningMap.set(row.bucket_key, {
          level: row.level,
          count: Number(row.count),
        })
      }
    }

    // 3. Active dates per bucket
    const bucketDateRows = this.getStatement(`
        SELECT DISTINCT
          strftime('${strftimePattern}', started_at / 1000, 'unixepoch', 'localtime') as bucket_key,
          strftime('%Y-%m-%d', started_at / 1000, 'unixepoch', 'localtime') as active_date
        FROM conversation_turns
        ${turnWhereSql}
        ORDER BY bucket_key ASC, active_date ASC
      `)
      .all(...turnParams) as Array<{
        bucket_key: string
        active_date: string
      }>

    const bucketDatesMap = new Map<string, string[]>()
    for (const row of bucketDateRows) {
      if (!row.bucket_key) continue
      if (!bucketDatesMap.has(row.bucket_key)) {
        bucketDatesMap.set(row.bucket_key, [])
      }
      bucketDatesMap.get(row.bucket_key)!.push(row.active_date)
    }

    // 4. Skills summary per bucket
    const bucketSkillStatsRows = this.getStatement(`
        SELECT
          strftime('${strftimePattern}', invoked_at / 1000, 'unixepoch', 'localtime') as bucket_key,
          COUNT(DISTINCT skill_name) as unique_skills_count,
          COUNT(*) as total_skill_invocations,
          MIN(invoked_at) as min_invoked_at,
          MAX(invoked_at) as max_invoked_at
        FROM skill_invocations
        ${skillWhereSql}
        GROUP BY bucket_key
        ORDER BY bucket_key ASC
      `)
      .all(...skillParams) as Array<{
        bucket_key: string
        unique_skills_count: number
        total_skill_invocations: number
        min_invoked_at: number
        max_invoked_at: number
      }>

    const bucketSkillStatsMap = new Map<
      string,
      {
        uniqueSkillsCount: number
        totalSkillInvocations: number
        minInvokedAt: number
        maxInvokedAt: number
      }
    >()

    for (const row of bucketSkillStatsRows) {
      if (!row.bucket_key) continue
      bucketSkillStatsMap.set(row.bucket_key, {
        uniqueSkillsCount: Number(row.unique_skills_count) || 0,
        totalSkillInvocations: Number(row.total_skill_invocations) || 0,
        minInvokedAt: Number(row.min_invoked_at) || 0,
        maxInvokedAt: Number(row.max_invoked_at) || 0,
      })
    }

    // 5. Top skills per bucket
    const bucketTopSkillRows = this.getStatement(`
        SELECT
          strftime('${strftimePattern}', invoked_at / 1000, 'unixepoch', 'localtime') as bucket_key,
          skill_name as name,
          COUNT(*) as count
        FROM skill_invocations
        ${skillWhereSql}
        GROUP BY bucket_key, skill_name
        ORDER BY bucket_key ASC, count DESC, name ASC
      `)
      .all(...skillParams) as Array<{
        bucket_key: string
        name: string
        count: number
      }>

    const bucketTopSkillsMap = new Map<string, Array<{ name: string; count: number }>>()
    for (const row of bucketTopSkillRows) {
      if (!row.bucket_key) continue
      if (!bucketTopSkillsMap.has(row.bucket_key)) {
        bucketTopSkillsMap.set(row.bucket_key, [])
      }
      const list = bucketTopSkillsMap.get(row.bucket_key)!
      if (list.length < topSkillsLimit) {
        list.push({ name: row.name, count: Number(row.count) })
      }
    }

    const turnMap = new Map(bucketTurnRows.map((r) => [r.bucket_key, r]))

    // 6. Top models per bucket
    const bucketTopModelRows = this.getStatement(`
        SELECT
          strftime('${strftimePattern}', started_at / 1000, 'unixepoch', 'localtime') as bucket_key,
          COALESCE(NULLIF(TRIM(model_id), ''), 'unknown') as model_id,
          COUNT(*) as count,
          COALESCE(SUM(tokens_total), 0) as total_tokens
        FROM conversation_turns
        ${turnWhereSql}
        GROUP BY bucket_key, COALESCE(NULLIF(TRIM(model_id), ''), 'unknown')
        ORDER BY bucket_key ASC, count DESC, total_tokens DESC, model_id ASC
      `)
      .all(...turnParams) as Array<{
        bucket_key: string
        model_id: string
        count: number
        total_tokens: number
      }>

    const bucketTopModelsMap = new Map<
      string,
      Array<{ modelId: string; count: number; totalTokens: number; percentage: number }>
    >()
    for (const row of bucketTopModelRows) {
      if (!row.bucket_key) continue
      if (!bucketTopModelsMap.has(row.bucket_key)) {
        bucketTopModelsMap.set(row.bucket_key, [])
      }
      const list = bucketTopModelsMap.get(row.bucket_key)!
      if (list.length < topModelsLimit) {
        const turnData = turnMap.get(row.bucket_key)
        const bChats = Number(turnData?.total_chats) || 0
        const count = Number(row.count)
        list.push({
          modelId: row.model_id,
          count,
          totalTokens: Number(row.total_tokens),
          percentage: bChats > 0 ? Number(((count / bChats) * 100).toFixed(1)) : 0,
        })
      }
    }

    // 7. Merge all bucket keys
    const allBucketKeysSet = new Set<string>()
    for (const t of bucketTurnRows) {
      if (t.bucket_key) allBucketKeysSet.add(t.bucket_key)
    }
    for (const s of bucketSkillStatsRows) {
      if (s.bucket_key) allBucketKeysSet.add(s.bucket_key)
    }

    const sortedBucketKeys = Array.from(allBucketKeysSet).sort()

    const buckets: GranularBucketMetrics[] = []
    for (const bKey of sortedBucketKeys) {
      const turnData = turnMap.get(bKey)
      const skillData = bucketSkillStatsMap.get(bKey)

      const bTotalChats = Number(turnData?.total_chats) || 0
      const bTotalTokens = Number(turnData?.total_tokens) || 0
      const bTokensInput = Number(turnData?.total_tokens_input) || 0
      const bTokensOutput = Number(turnData?.total_tokens_output) || 0
      const bTokensCacheRead = Number(turnData?.total_tokens_cache_read) || 0
      const bTokensCacheWrite = Number(turnData?.total_tokens_cache_write) || 0
      const bTokensReasoning = Number(turnData?.total_tokens_reasoning) || 0
      const bTotalCost = Number(Number(turnData?.total_cost || 0).toFixed(6))
      const bMaxDuration = Number(turnData?.max_task_duration_ms) || 0
      const bFastCount = Number(turnData?.fast_mode_count) || 0
      const bFastPct =
        bTotalChats > 0 ? Number(((bFastCount / bTotalChats) * 100).toFixed(2)) : 0

      let bTopReasoning: { level: string; count: number; percentage: number } | null = null
      const topR = bucketTopReasoningMap.get(bKey)
      if (topR && bTotalChats > 0) {
        bTopReasoning = {
          level: topR.level,
          count: topR.count,
          percentage: Number(((topR.count / bTotalChats) * 100).toFixed(2)),
        }
      }

      const bDates = bucketDatesMap.get(bKey) || []
      const bStreaks = computeStreaks(bDates)

      const bUniqueSkills = skillData?.uniqueSkillsCount ?? 0
      const bTotalSkillInvocations = skillData?.totalSkillInvocations ?? 0
      const bTopSkills = bucketTopSkillsMap.get(bKey) || []

      let startTimeMs = 0
      let endTimeMs = 0

      const hasTurnTime = turnData && typeof turnData.min_started_at === 'number'
      const hasSkillTime =
        skillData && typeof skillData.minInvokedAt === 'number' && skillData.minInvokedAt > 0

      if (hasTurnTime && hasSkillTime) {
        startTimeMs = Math.min(turnData!.min_started_at, skillData!.minInvokedAt)
        endTimeMs = Math.max(turnData!.max_completed_at, skillData!.maxInvokedAt)
      } else if (hasTurnTime) {
        startTimeMs = turnData!.min_started_at
        endTimeMs = turnData!.max_completed_at
      } else if (hasSkillTime) {
        startTimeMs = skillData!.minInvokedAt
        endTimeMs = skillData!.maxInvokedAt
      }

      buckets.push({
        bucketKey: bKey,
        startTimeMs,
        endTimeMs,
        metrics: {
          totalTokens: bTotalTokens,
          totalTokensBreakdown: {
            input: bTokensInput,
            output: bTokensOutput,
            cacheRead: bTokensCacheRead,
            cacheWrite: bTokensCacheWrite,
            reasoning: bTokensReasoning,
          },
          totalCost: bTotalCost,
          maxTaskDurationMs: bMaxDuration,
          currentStreakDays: bStreaks.currentStreakDays,
          longestStreakDays: bStreaks.longestStreakDays,
          fastMode: {
            count: bFastCount,
            percentage: bFastPct,
          },
          topReasoningEffort: bTopReasoning,
          uniqueSkillsCount: bUniqueSkills,
          totalSkillInvocations: bTotalSkillInvocations,
          totalChats: bTotalChats,
          topSkills: bTopSkills,
          topModels: bucketTopModelsMap.get(bKey) || [],
        },
      })
    }

    return buckets
  }

  private buildTurnFilter(
    options: QueryMetricsOptions,
    ctx?: { groupType?: 'project' | 'model'; groupKey?: string },
  ): { whereSql: string; params: any[] } {
    const conditions: string[] = []
    const params: any[] = []

    if (
      options.timeRange &&
      Array.isArray(options.timeRange) &&
      options.timeRange.length === 2 &&
      typeof options.timeRange[0] === 'number' &&
      typeof options.timeRange[1] === 'number'
    ) {
      conditions.push('started_at >= ? AND started_at <= ?')
      params.push(options.timeRange[0], options.timeRange[1])
    }

    if (options.subAgentMode === 'main_only') {
      conditions.push('is_subagent = 0')
    } else if (options.subAgentMode === 'subagent_only') {
      conditions.push('is_subagent = 1')
    } else if (options.subAgentMode === 'session_id') {
      if (options.sessionId && options.sessionId.trim()) {
        conditions.push('(session_id = ? OR parent_session_id = ?)')
        params.push(options.sessionId.trim(), options.sessionId.trim())
      } else {
        conditions.push('1 = 0')
      }
    } else if (options.sessionId && options.sessionId.trim()) {
      conditions.push('(session_id = ? OR parent_session_id = ?)')
      params.push(options.sessionId.trim(), options.sessionId.trim())
    }

    if (ctx?.groupType === 'project') {
      if (ctx.groupKey === 'unassigned') {
        conditions.push("(project_id IS NULL OR project_id = '' OR project_id = 'unassigned')")
      } else if (ctx.groupKey !== undefined) {
        conditions.push('project_id = ?')
        params.push(ctx.groupKey)
      }
      if (typeof options.modelId === 'string' && options.modelId.trim()) {
        conditions.push('model_id = ?')
        params.push(options.modelId.trim())
      }
    } else if (ctx?.groupType === 'model') {
      if (ctx.groupKey === 'unknown') {
        conditions.push("(model_id IS NULL OR model_id = '' OR model_id = 'unknown')")
      } else if (ctx.groupKey !== undefined) {
        conditions.push('model_id = ?')
        params.push(ctx.groupKey)
      }
      if (typeof options.projectId === 'string' && options.projectId.trim()) {
        conditions.push('project_id = ?')
        params.push(options.projectId.trim())
      }
    } else {
      if (typeof options.projectId === 'string' && options.projectId.trim()) {
        conditions.push('project_id = ?')
        params.push(options.projectId.trim())
      }
      if (typeof options.modelId === 'string' && options.modelId.trim()) {
        conditions.push('model_id = ?')
        params.push(options.modelId.trim())
      }
    }

    const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    return { whereSql, params }
  }

  private buildSkillFilter(
    options: QueryMetricsOptions,
    ctx?: { groupType?: 'project' | 'model'; groupKey?: string },
  ): { whereSql: string; params: any[] } {
    const conditions: string[] = []
    const params: any[] = []

    if (
      options.timeRange &&
      Array.isArray(options.timeRange) &&
      options.timeRange.length === 2 &&
      typeof options.timeRange[0] === 'number' &&
      typeof options.timeRange[1] === 'number'
    ) {
      conditions.push('invoked_at >= ? AND invoked_at <= ?')
      params.push(options.timeRange[0], options.timeRange[1])
    }

    if (options.subAgentMode === 'main_only') {
      conditions.push('session_id IN (SELECT id FROM sessions WHERE is_subagent = 0)')
    } else if (options.subAgentMode === 'subagent_only') {
      conditions.push('session_id IN (SELECT id FROM sessions WHERE is_subagent = 1)')
    } else if (options.subAgentMode === 'session_id') {
      if (options.sessionId && options.sessionId.trim()) {
        conditions.push(
          'session_id IN (SELECT id FROM sessions WHERE id = ? OR parent_session_id = ?)',
        )
        params.push(options.sessionId.trim(), options.sessionId.trim())
      } else {
        conditions.push('1 = 0')
      }
    } else if (options.sessionId && options.sessionId.trim()) {
      conditions.push(
        'session_id IN (SELECT id FROM sessions WHERE id = ? OR parent_session_id = ?)',
      )
      params.push(options.sessionId.trim(), options.sessionId.trim())
    }

    if (ctx?.groupType === 'project') {
      if (ctx.groupKey === 'unassigned') {
        conditions.push("(project_id IS NULL OR project_id = '' OR project_id = 'unassigned')")
      } else if (ctx.groupKey !== undefined) {
        conditions.push('project_id = ?')
        params.push(ctx.groupKey)
      }
      if (typeof options.modelId === 'string' && options.modelId.trim()) {
        conditions.push('model_id = ?')
        params.push(options.modelId.trim())
      }
    } else if (ctx?.groupType === 'model') {
      if (ctx.groupKey === 'unknown') {
        conditions.push("(model_id IS NULL OR model_id = '' OR model_id = 'unknown')")
      } else if (ctx.groupKey !== undefined) {
        conditions.push('model_id = ?')
        params.push(ctx.groupKey)
      }
      if (typeof options.projectId === 'string' && options.projectId.trim()) {
        conditions.push('project_id = ?')
        params.push(options.projectId.trim())
      }
    } else {
      if (typeof options.projectId === 'string' && options.projectId.trim()) {
        conditions.push('project_id = ?')
        params.push(options.projectId.trim())
      }
      if (typeof options.modelId === 'string' && options.modelId.trim()) {
        conditions.push('model_id = ?')
        params.push(options.modelId.trim())
      }
    }

    const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    return { whereSql, params }
  }

  async search(
    query: string,
    limit: number = 50,
  ): Promise<SessionSearchResultItem[]> {
    const trimmed = query.trim()
    if (!trimmed) {
      return []
    }

    const db = this.getDb()
    const results: SessionSearchResultItem[] = []
    const seenSessionIds = new Set<string>()

    // 1. Search in session titles (Title matches first)
    const titleStmt = this.getStatement(`
      SELECT id, project_id, branch, title, updated_at
      FROM sessions
      WHERE archived_at IS NULL AND title LIKE ?
      ORDER BY updated_at DESC
      LIMIT ?
    `)
    const titleRows = titleStmt.all(`%${trimmed}%`, limit) as Array<{
      id: string
      project_id: string | null
      branch: string | null
      title: string
      updated_at: number
    }>

    for (const row of titleRows) {
      seenSessionIds.add(row.id)
      results.push({
        sessionId: row.id,
        title: row.title,
        projectId: row.project_id || undefined,
        branch: row.branch || undefined,
        updatedAt: row.updated_at,
        matchType: 'title',
      })
    }

    if (results.length >= limit) {
      return results.slice(0, limit)
    }

    // 2. Search in session entries payload_json
    const remainingLimit = limit - results.length
    const contentStmt = this.getStatement(`
      SELECT se.session_id, se.payload_json, s.project_id, s.branch, s.title, s.updated_at
      FROM session_entries se
      JOIN sessions s ON se.session_id = s.id
      WHERE s.archived_at IS NULL AND se.payload_json LIKE ?
      ORDER BY s.updated_at DESC
    `)
    const contentRows = contentStmt.all(`%${trimmed}%`) as Array<{
      session_id: string
      payload_json: string
      project_id: string | null
      branch: string | null
      title: string
      updated_at: number
    }>

    const contentMatches = new Map<string, SessionSearchResultItem>()
    for (const row of contentRows) {
      if (seenSessionIds.has(row.session_id)) {
        continue
      }
      if (contentMatches.has(row.session_id)) {
        continue
      }

      try {
        const parsed = JSON.parse(row.payload_json)
        const text = extractTextFromEntry(parsed)
        const snippet = extractSnippet(text, trimmed)
        if (snippet) {
          contentMatches.set(row.session_id, {
            sessionId: row.session_id,
            title: row.title,
            projectId: row.project_id || undefined,
            branch: row.branch || undefined,
            updatedAt: row.updated_at,
            matchType: 'content',
            snippet,
          })
          if (contentMatches.size >= remainingLimit) {
            break
          }
        }
      } catch {
        // Ignore JSON parse errors in payload
      }
    }

    results.push(...contentMatches.values())
    return results.slice(0, limit)
  }

  getPluginStorage<T>(pluginId: string, namespaceVersion: number, key: string): T | undefined {
    if (!pluginId || typeof namespaceVersion !== 'number' || !key) return undefined
    const row = this.getStatement(
      'SELECT value_json FROM plugin_storage WHERE plugin_id = ? AND namespace_version = ? AND key = ?',
    ).get(pluginId, namespaceVersion, key) as { value_json: string } | undefined
    if (!row) return undefined
    try {
      return JSON.parse(row.value_json) as T
    } catch {
      return undefined
    }
  }

  setPluginStorage<T>(pluginId: string, namespaceVersion: number, key: string, value: T): void {
    if (!pluginId || typeof namespaceVersion !== 'number' || !key) return
    const now = Date.now()
    const valueJson = JSON.stringify(value)
    this.getStatement(`
      INSERT INTO plugin_storage (
        plugin_id, namespace_version, key, value_json, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?
      ) ON CONFLICT(plugin_id, namespace_version, key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `).run(pluginId, namespaceVersion, key, valueJson, now)
  }

  deletePluginStorage(pluginId: string, namespaceVersion: number, key: string): void {
    if (!pluginId || typeof namespaceVersion !== 'number' || !key) return
    this.getStatement(
      'DELETE FROM plugin_storage WHERE plugin_id = ? AND namespace_version = ? AND key = ?',
    ).run(pluginId, namespaceVersion, key)
  }

  listPluginStorageKeys(pluginId: string, namespaceVersion: number): string[] {
    if (!pluginId || typeof namespaceVersion !== 'number') return []
    const rows = this.getStatement(
      'SELECT key FROM plugin_storage WHERE plugin_id = ? AND namespace_version = ? ORDER BY key ASC',
    ).all(pluginId, namespaceVersion) as Array<{ key: string }>
    return rows.map((r) => r.key)
  }

  runTransaction<T>(fn: () => T): T {
    const db = this.getDb()
    return db.transaction(fn)()
  }

  close(): void {
    if (this.db) {
      try {
        this.statementCache.clear()
        if (this.db.open) {
          if (this.dbPath !== ':memory:') {
            try {
              this.db.pragma('wal_checkpoint(TRUNCATE)')
            } catch {
              // Ignore WAL checkpoint error during close
            }
          }
          this.db.close()
        }
      } catch {
        // Ignore close errors
      } finally {
        this.db = null
        this.statementCache.clear()
      }
    }
  }

  private extractTitleFromEntries(entries: any[]): string | null {
    for (const entry of entries) {
      if (entry && (entry.kind === 'user' || entry.type === 'user')) {
        if (typeof entry.text === 'string' && entry.text.trim()) {
          return entry.text.trim().slice(0, 80)
        }
        if (Array.isArray(entry.content)) {
          for (const item of entry.content) {
            if (item && item.type === 'text' && typeof item.text === 'string' && item.text.trim()) {
              return item.text.trim().slice(0, 80)
            }
          }
        }
      }
    }
    return null
  }

  private extractTurnsFromEntries(
    entries: any[],
  ): Array<{ userEntry: any; entries: any[] }> {
    const turns: Array<{ userEntry: any; entries: any[] }> = []
    let currentTurn: { userEntry: any; entries: any[] } | null = null

    for (const entry of entries) {
      if (entry && (entry.kind === 'user' || entry.type === 'user')) {
        currentTurn = { userEntry: entry, entries: [entry] }
        turns.push(currentTurn)
      } else if (currentTurn) {
        currentTurn.entries.push(entry)
      } else if (entry && (entry.kind === 'compaction' || entry.type === 'compaction')) {
        currentTurn = { userEntry: entry, entries: [entry] }
        turns.push(currentTurn)
      }
    }

    return turns
  }

  private extractSkillsFromTurn(userEntry: any, turnEntries: any[]): string[] {
    const skills = new Set<string>()

    // Source A: User Entry text
    const userTexts: string[] = []
    if (typeof userEntry?.text === 'string') {
      userTexts.push(userEntry.text)
    }
    if (Array.isArray(userEntry?.content)) {
      for (const block of userEntry.content) {
        if (block && block.type === 'text' && typeof block.text === 'string') {
          userTexts.push(block.text)
        }
      }
    }

    for (const text of userTexts) {
      const dollarMatches = Array.from(text.matchAll(/\$([a-zA-Z0-9_-]+)/g))
      for (const match of dollarMatches) {
        const name = match[1]
        if (name && !/^\d+$/.test(name)) {
          skills.add(name)
        }
      }

      const slashMatches = Array.from(text.matchAll(/\/skill:([a-zA-Z0-9_-]+)/g))
      for (const match of slashMatches) {
        const name = match[1]
        if (name) {
          skills.add(name)
        }
      }
    }

    // Source B: Assistant Tool Calls
    for (const entry of turnEntries) {
      if (!entry) continue
      if (Array.isArray(entry.content)) {
        for (const block of entry.content) {
          if (!block) continue
          const isToolCall = block.type === 'toolCall' || block.type === 'tool_call'
          if (isToolCall) {
            const toolName = block.name || block.toolName || block.tool_name
            if (toolName === 'read') {
              let args = block.arguments ?? block.args
              if (typeof args === 'string') {
                if (args.toLowerCase().includes('.md')) {
                  try {
                    args = JSON.parse(args)
                  } catch {
                    args = null
                  }
                } else {
                  args = null
                }
              }
              const filePath = args?.path || args?.filePath || args?.file_path
              if (typeof filePath === 'string') {
                const skillName = this.extractSkillFromPath(filePath)
                if (skillName) {
                  skills.add(skillName)
                }
              }
            }
          }
        }
      }

      const rawToolCalls = Array.isArray(entry.toolCalls)
        ? entry.toolCalls
        : Array.isArray(entry.tool_calls)
          ? entry.tool_calls
          : []

      for (const tc of rawToolCalls) {
        if (!tc) continue
        const toolName = tc.name || tc.toolName || tc.function?.name
        if (toolName === 'read') {
          let args = tc.arguments ?? tc.args ?? tc.function?.arguments
          if (typeof args === 'string') {
            if (args.toLowerCase().includes('.md')) {
              try {
                args = JSON.parse(args)
              } catch {
                args = null
              }
            } else {
              args = null
            }
          }
          const filePath = args?.path || args?.filePath || args?.file_path
          if (typeof filePath === 'string') {
            const skillName = this.extractSkillFromPath(filePath)
            if (skillName) {
              skills.add(skillName)
            }
          }
        }
      }
    }

    return Array.from(skills)
  }

  private extractSkillFromPath(filePath: string): string | null {
    if (typeof filePath !== 'string' || !filePath.trim()) return null
    const normalized = filePath.trim().replace(/\\/g, '/')

    const skillDirMatch = normalized.match(SKILL_DIR_REGEX)
    if (
      skillDirMatch &&
      skillDirMatch[1] &&
      skillDirMatch[1] !== 'skills' &&
      skillDirMatch[1] !== '.cpa'
    ) {
      return skillDirMatch[1]
    }

    const skillsFileMatch = normalized.match(SKILLS_FILE_REGEX)
    if (skillsFileMatch && skillsFileMatch[1]) {
      return skillsFileMatch[1]
    }

    return null
  }
}

const GRANULARITY_FORMATS: Record<MetricTimeGranularity, string | null> = {
  minute: '%Y-%m-%d %H:%M',
  hour: '%Y-%m-%d %H:00',
  day: '%Y-%m-%d',
  week: '%Y-W%W',
  month: '%Y-%m',
  year: '%Y',
  all: null,
}

export function computeStreaks(
  dates: string[],
): { currentStreakDays: number; longestStreakDays: number } {
  if (!dates || dates.length === 0) {
    return { currentStreakDays: 0, longestStreakDays: 0 }
  }

  const toEpochDay = (dStr: string): number => {
    const [y, m, d] = dStr.split('-').map(Number)
    return Math.round(Date.UTC(y, m - 1, d) / 86400000)
  }

  const epochDays = Array.from(new Set(dates.map(toEpochDay))).sort((a, b) => a - b)
  if (epochDays.length === 0) {
    return { currentStreakDays: 0, longestStreakDays: 0 }
  }

  // Longest streak
  let longestStreak = 1
  let currentRun = 1
  for (let i = 1; i < epochDays.length; i++) {
    if (epochDays[i] === epochDays[i - 1] + 1) {
      currentRun++
      if (currentRun > longestStreak) {
        longestStreak = currentRun
      }
    } else {
      currentRun = 1
    }
  }

  // Current streak: check if latest date is today or yesterday in local time
  const now = new Date()
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const todayEpochDay = toEpochDay(todayStr)
  const yesterdayEpochDay = todayEpochDay - 1

  const lastEpochDay = epochDays[epochDays.length - 1]
  let currentStreak = 0

  if (lastEpochDay === todayEpochDay || lastEpochDay === yesterdayEpochDay) {
    currentStreak = 1
    for (let i = epochDays.length - 1; i > 0; i--) {
      if (epochDays[i] === epochDays[i - 1] + 1) {
        currentStreak++
      } else {
        break
      }
    }
  }

  return { currentStreakDays: currentStreak, longestStreakDays: longestStreak }
}

export function extractTextFromEntry(entry: unknown): string {
  if (!entry || typeof entry !== 'object') return ''
  const parts: string[] = []
  const obj = entry as Record<string, any>

  if (typeof obj.text === 'string') parts.push(obj.text)
  if (typeof obj.thought === 'string') parts.push(obj.thought)
  if (typeof obj.errorMessage === 'string') parts.push(obj.errorMessage)

  if (Array.isArray(obj.content)) {
    for (const block of obj.content) {
      if (typeof block === 'string') {
        parts.push(block)
      } else if (block && typeof block === 'object') {
        if (typeof block.text === 'string') parts.push(block.text)
        if (typeof block.thinking === 'string') parts.push(block.thinking)
        if (block.type === 'toolCall' && block.name) {
          parts.push(String(block.name))
          if (block.arguments) {
            try {
              parts.push(
                typeof block.arguments === 'string'
                  ? block.arguments
                  : JSON.stringify(block.arguments),
              )
            } catch {
              // Ignore serialization error
            }
          }
        }
      }
    }
  } else if (typeof obj.content === 'string') {
    parts.push(obj.content)
  }

  if (Array.isArray(obj.parts)) {
    for (const part of obj.parts) {
      if (typeof part === 'string') {
        parts.push(part)
      } else if (part && typeof part === 'object' && typeof part.text === 'string') {
        parts.push(part.text)
      }
    }
  }

  return parts.join(' ')
}

export function extractSnippet(
  fullText: string,
  query: string,
  maxContext = 40,
): string | undefined {
  if (!fullText || !query) return undefined
  const normalized = fullText.replace(/\s+/g, ' ').trim()
  const lowerText = normalized.toLowerCase()
  const lowerQuery = query.toLowerCase().trim()
  if (!lowerQuery) return undefined

  const index = lowerText.indexOf(lowerQuery)
  if (index === -1) return undefined

  const start = Math.max(0, index - maxContext)
  const end = Math.min(normalized.length, index + lowerQuery.length + maxContext)

  let snippet = normalized.slice(start, end)
  if (start > 0) snippet = '... ' + snippet
  if (end < normalized.length) snippet = snippet + ' ...'

  return snippet
}

