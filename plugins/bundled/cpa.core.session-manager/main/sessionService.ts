import * as path from 'node:path'
import {
  SessionDatabaseService,
  type SessionDatabaseOptions,
} from './sessionDatabaseService.js'
import type { QueryMetricsOptions, QueryMetricsResult, SessionItem, SessionSearchResultItem, SubAgentItem, WorktreeSessionSetup } from '../../../../src/shared/types.js'

export interface SessionServiceOptions extends SessionDatabaseOptions {}

export class SessionService {
  private readonly dbService: SessionDatabaseService

  constructor(optionsOrDir?: string | SessionServiceOptions) {
    this.dbService = new SessionDatabaseService(optionsOrDir)
  }

  getSessionsDir(): string {
    const dbPath = this.dbService.getDbPath()
    if (dbPath === ':memory:') {
      return ':memory:'
    }
    return path.dirname(dbPath)
  }

  async get(
    sessionId: string,
  ): Promise<{
    id: string
    version: number
    entriesRevision: string
    entries: any[]
    subAgents?: any[]
    workLocation?: 'local' | 'worktree'
    worktreePath?: string
    environmentId?: string | null
    worktreeSetup?: WorktreeSessionSetup
  } | null> {
    return this.dbService.get(sessionId)
  }

  async set(sessionId: string, data: unknown): Promise<string> {
    return this.dbService.set(sessionId, data)
  }

  async delete(sessionId: string): Promise<void> {
    return this.dbService.delete(sessionId)
  }

  async list(): Promise<string[]> {
    return this.dbService.list()
  }

  async listSessions(): Promise<SessionItem[]> {
    return this.dbService.listSessions()
  }

  async listSessionsByScheduleId(scheduleId: string): Promise<SessionItem[]> {
    return this.dbService.listSessionsByScheduleId(scheduleId)
  }

  async getMeta(sessionId: string): Promise<SessionItem | null> {
    return this.dbService.getMeta(sessionId)
  }

  async setMeta(session: Partial<SessionItem> & { id: string }): Promise<void> {
    return this.dbService.setMeta(session)
  }

  async updateSubAgent(subAgent: SubAgentItem): Promise<void> {
    return this.dbService.updateSubAgent(subAgent)
  }

  async queryMetrics(options?: QueryMetricsOptions): Promise<QueryMetricsResult> {
    return this.dbService.queryMetrics(options)
  }

  async search(query: string, limit?: number): Promise<SessionSearchResultItem[]> {
    return this.dbService.search(query, limit)
  }

  getDatabaseService(): SessionDatabaseService {
    return this.dbService
  }

  getPluginStorage<T>(pluginId: string, namespaceVersion: number, key: string): T | undefined {
    return this.dbService.getPluginStorage<T>(pluginId, namespaceVersion, key)
  }

  setPluginStorage<T>(pluginId: string, namespaceVersion: number, key: string, value: T): void {
    this.dbService.setPluginStorage<T>(pluginId, namespaceVersion, key, value)
  }

  deletePluginStorage(pluginId: string, namespaceVersion: number, key: string): void {
    this.dbService.deletePluginStorage(pluginId, namespaceVersion, key)
  }

  listPluginStorageKeys(pluginId: string, namespaceVersion: number): string[] {
    return this.dbService.listPluginStorageKeys(pluginId, namespaceVersion)
  }

  close(): void {
    this.dbService.close()
  }
}

