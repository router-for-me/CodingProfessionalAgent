import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as fsSync from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import Database from 'better-sqlite3'
import { MainPluginStorage } from '../src/main/plugins/storage/MainPluginStorage.js'
import { SessionDatabaseService } from '../plugins/bundled/cpa.core.session-manager/main/sessionDatabaseService.js'
import type { SessionItem } from '../packages/plugin-api/src/services.js'

describe('Session Storage Fallback & Parity Contract', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cpa-storage-parity-test-'))
  })

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore
    }
  })

  it('SessionDatabaseService creates tables first -> MainPluginStorage writes plugin storage without errors', async () => {
    const dbPath = path.join(tempDir, 'sessions', 'data.db')
    const sessionDb = new SessionDatabaseService({ dbPath })
    sessionDb.close()

    // Open via generic MainPluginStorage
    const mainStorage = new MainPluginStorage({ baseDir: tempDir })
    const pluginNs = await mainStorage.openNamespace('com.test.alpha', 1)

    // Plugin storage write
    await pluginNs.set('config', { theme: 'dark', retries: 3 })
    const readConfig = await pluginNs.get('config')
    expect(readConfig).toEqual({ theme: 'dark', retries: 3 })

    // Verify read via SessionDatabaseService
    const reopenedSessionDb = new SessionDatabaseService({ dbPath })
    const pluginValueInSdb = reopenedSessionDb.getPluginStorage('com.test.alpha', 1, 'config')
    expect(pluginValueInSdb).toEqual({ theme: 'dark', retries: 3 })

    reopenedSessionDb.close()
  })

  it('MainPluginStorage creates tables first -> SessionDatabaseService writes plugin storage and metadata without errors', async () => {
    const dbPath = path.join(tempDir, 'sessions', 'data.db')
    const mainStorage = new MainPluginStorage({ baseDir: tempDir })

    const pluginNs = await mainStorage.openNamespace('com.test.beta', 1)
    await pluginNs.set('state', { active: true })

    // Now open via SessionDatabaseService
    const sessionDb = new SessionDatabaseService({ dbPath })

    const testSessionMeta: SessionItem = {
      id: 'sess-first-fallback',
      title: 'Created by SessionDatabaseService',
      projectId: 'proj-2',
      scheduleId: 'sched-2',
      parentSessionId: undefined,
      branch: 'main',
      pinned: false,
      unread: true,
      archivedAt: undefined,
      rightSidebar: undefined,
      firstPromptAt: 1700000010000,
      modelId: 'claude-3-5-sonnet',
      reasoningEffort: 'medium',
      speed: 'standard',
      workLocation: 'local',
      worktreePath: undefined,
      environmentId: null,
      worktreeSetup: undefined,
      pinnedSummaryVisible: false,
      createdAt: 1700000009000,
      updatedAt: 1700000012000,
    }
    await sessionDb.setMeta(testSessionMeta)

    // SessionDatabaseService can read metadata
    const readMeta = await sessionDb.getMeta('sess-first-fallback')
    expect(readMeta).toMatchObject({
      id: 'sess-first-fallback',
      title: 'Created by SessionDatabaseService',
      projectId: 'proj-2',
      scheduleId: 'sched-2',
      branch: 'main',
      pinned: false,
      unread: true,
      firstPromptAt: 1700000010000,
      modelId: 'claude-3-5-sonnet',
      reasoningEffort: 'medium',
      speed: 'standard',
      workLocation: 'local',
      pinnedSummaryVisible: false,
    })

    // SessionDatabaseService can write plugin storage
    sessionDb.setPluginStorage('com.test.beta', 1, 'sdb-key', { fromSdb: true })
    const readFromMainStorage = await pluginNs.get('sdb-key')
    expect(readFromMainStorage).toEqual({ fromSdb: true })

    // SessionDatabaseService can write subagent
    await sessionDb.updateSubAgent({
      id: 'sub-1',
      sessionId: 'sess-first-fallback',
      parentSessionId: 'sess-first-fallback',
      parentToolCallId: 'call-1',
      name: 'Explore Agent',
      modelId: 'gpt-4o',
      reasoningEffort: 'low',
      status: 'running',
      color: '#ff0000',
      icon: 'bot',
      lastMessage: 'Thinking...',
      errorMessage: undefined,
      createdAt: 1700000013000,
      updatedAt: 1700000014000,
    })

    const fullSession = await sessionDb.get('sess-first-fallback')
    expect(fullSession?.subAgents).toHaveLength(1)
    expect(fullSession?.subAgents?.[0]).toMatchObject({
      id: 'sub-1',
      name: 'Explore Agent',
      status: 'running',
    })

    sessionDb.close()
  })

  it('supports backwards compatibility with legacy plugin_storage table containing created_at column', async () => {
    const dbPath = path.join(tempDir, 'sessions', 'data.db')
    await fs.mkdir(path.dirname(dbPath), { recursive: true })

    // Create legacy table with created_at NOT NULL
    const rawDb = new Database(dbPath)
    rawDb.exec(`
      CREATE TABLE plugin_storage (
        plugin_id TEXT NOT NULL,
        namespace_version INTEGER NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (plugin_id, namespace_version, key)
      );
      INSERT INTO plugin_storage VALUES ('legacy.plugin', 1, 'seedKey', '{"seeded":true}', 100, 100);
    `)
    rawDb.close()

    // 1. Generic MainPluginStorage can read and write to this DB without error
    const mainStorage = new MainPluginStorage({ baseDir: tempDir })
    const legacyNs = await mainStorage.openNamespace('legacy.plugin', 1)
    expect(await legacyNs.get('seedKey')).toEqual({ seeded: true })
    await legacyNs.set('newKey', { writtenBy: 'mainStorage' })
    expect(await legacyNs.get('newKey')).toEqual({ writtenBy: 'mainStorage' })

    // 2. SessionDatabaseService can also read and write to this DB without error
    const sessionDb = new SessionDatabaseService({ dbPath })
    expect(sessionDb.getPluginStorage('legacy.plugin', 1, 'seedKey')).toEqual({ seeded: true })
    expect(sessionDb.getPluginStorage('legacy.plugin', 1, 'newKey')).toEqual({ writtenBy: 'mainStorage' })

    sessionDb.setPluginStorage('legacy.plugin', 1, 'sdbKey', { writtenBy: 'sdb' })
    expect(sessionDb.getPluginStorage('legacy.plugin', 1, 'sdbKey')).toEqual({ writtenBy: 'sdb' })
    expect(await legacyNs.get('sdbKey')).toEqual({ writtenBy: 'sdb' })

    sessionDb.close()
  })

  it('ensures full metadata roundtrip fidelity directly on SessionDatabaseService', async () => {
    const dbPath = path.join(tempDir, 'sessions', 'data.db')
    const sessionDb = new SessionDatabaseService({ dbPath })

    const complexSession: SessionItem = {
      id: 'sess-complex-parity',
      title: 'Full Parity Verification Session',
      projectId: 'proj-omega',
      scheduleId: 'sched-nightly',
      parentSessionId: 'sess-root',
      branch: 'refactor/universal-plugin-closure',
      pinned: true,
      unread: 'error',
      archivedAt: 1710000000000,
      rightSidebar: {
        activeTab: 'subagents',
        width: 360,
        collapsed: false,
      } as any,
      firstPromptAt: 1709999900000,
      modelId: 'gpt-5-preview',
      reasoningEffort: 'high',
      speed: 'max',
      workLocation: 'worktree',
      worktreePath: '/data/worktrees/cpa-task9',
      environmentId: 'env-custom-sandbox',
      worktreeSetup: {
        branch: 'refactor/universal-plugin-closure',
        baseBranch: 'main',
        mode: 'isolated',
      } as any,
      pinnedSummaryVisible: true,
      createdAt: 1709999000000,
      updatedAt: 1710000050000,
    }

    // Write full metadata via SessionDatabaseService
    await sessionDb.setMeta(complexSession)

    // Read back and assert full match
    const readSdb = await sessionDb.getMeta('sess-complex-parity')
    expect(readSdb).toEqual(complexSession)

    // Update via SessionDatabaseService
    const updatedMeta: SessionItem = {
      ...complexSession,
      title: 'Updated via SessionDatabaseService',
      pinned: false,
      unread: true,
      workLocation: 'local',
      worktreePath: undefined,
      worktreeSetup: {
        branch: 'feat/updated',
        baseBranch: 'main',
        mode: 'reuse',
      } as any,
      pinnedSummaryVisible: false,
      updatedAt: 1710000099000,
    }
    await sessionDb.setMeta(updatedMeta)

    // Read back
    const readAfterUpdate = await sessionDb.getMeta('sess-complex-parity')
    expect(readAfterUpdate).toEqual(updatedMeta)

    // Clear worktreeSetup via null
    await sessionDb.setMeta({ id: 'sess-complex-parity', worktreeSetup: null as any })
    const readAfterClear = await sessionDb.getMeta('sess-complex-parity')
    expect(readAfterClear?.worktreeSetup).toBeUndefined()

    sessionDb.close()
  })

  it('maintains strict plugin_storage column and index schema parity between SessionDatabaseService and MainPluginStorage', () => {
    const sdbPath = path.join(tempDir, 'sdb-only.db')
    const mainStorePath = path.join(tempDir, 'main-store-only.db')

    const sdb = new SessionDatabaseService({ dbPath: sdbPath })
    sdb.close()

    const mainStorage = new MainPluginStorage({
      baseDir: path.join(tempDir, 'main-store'),
    })
    void mainStorage.openNamespace('com.test.parity', 1)

    const dbSdb = new Database(sdbPath)
    const dbMain = new Database(path.join(tempDir, 'main-store', 'sessions', 'data.db'))

    const sdbCols = (dbSdb.prepare('PRAGMA table_info(plugin_storage)').all() as Array<{ name: string; type: string; notnull: number; pk: number }>)
      .map((c) => ({ name: c.name, type: c.type.toUpperCase(), notnull: c.notnull, pk: c.pk }))
      .sort((a, b) => a.name.localeCompare(b.name))

    const mainCols = (dbMain.prepare('PRAGMA table_info(plugin_storage)').all() as Array<{ name: string; type: string; notnull: number; pk: number }>)
      .map((c) => ({ name: c.name, type: c.type.toUpperCase(), notnull: c.notnull, pk: c.pk }))
      .sort((a, b) => a.name.localeCompare(b.name))

    expect(mainCols, 'Column schema mismatch in table: plugin_storage').toEqual(sdbCols)

    dbSdb.close()
    dbMain.close()
  })

  it('statically enforces MainPluginStorage has no sessions/subagents/session-plugin-id and session-manager main has no src/main imports', () => {
    const mainPluginStorageFile = path.resolve(__dirname, '../src/main/plugins/storage/MainPluginStorage.ts')
    const storageContent = fsSync.readFileSync(mainPluginStorageFile, 'utf8')

    // 1. Assert MainPluginStorage does NOT contain session schemas or session manager ID
    expect(storageContent).not.toContain('cpa.core.session-manager')
    expect(storageContent).not.toContain('CREATE TABLE IF NOT EXISTS sessions')
    expect(storageContent).not.toContain('CREATE TABLE IF NOT EXISTS subagents')
    expect(storageContent).not.toContain('CREATE TABLE IF NOT EXISTS session_entries')
    expect(storageContent).not.toContain('sessionDatabaseService')
    expect(storageContent).not.toContain('sessionSqliteSchema')

    // 2. Assert src/main/plugins/storage/sessionSqliteSchema.ts does not exist
    const hostSchemaFile = path.resolve(__dirname, '../src/main/plugins/storage/sessionSqliteSchema.ts')
    expect(fsSync.existsSync(hostSchemaFile)).toBe(false)

    // 3. Assert plugins/bundled/cpa.core.session-manager/main/ has zero imports from src/main
    const sessionManagerMainDir = path.resolve(__dirname, '../plugins/bundled/cpa.core.session-manager/main')
    const files = fsSync.readdirSync(sessionManagerMainDir)
    for (const file of files) {
      if (file.endsWith('.ts') && !file.endsWith('.test.ts')) {
        const filePath = path.join(sessionManagerMainDir, file)
        const content = fsSync.readFileSync(filePath, 'utf8')
        const matches = content.match(/from\s+['"][^'"]*src\/main\/[^'"]*['"]/g)
        expect(matches, `File ${file} should not import from src/main`).toBeNull()
      }
    }
  })
})

