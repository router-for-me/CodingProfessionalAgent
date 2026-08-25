import * as path from 'node:path'
import * as os from 'node:os'
import * as fsSync from 'node:fs'
import Database, { type Database as DatabaseType } from 'better-sqlite3'
import type {
  PluginStorageContribution,
  PluginStorageNamespace,
  PluginStorageTransaction,
} from '@cpa/plugin-api'

export type {
  PluginStorageContribution,
  PluginStorageNamespace,
  PluginStorageTransaction,
}

export class PluginSqliteStorage {
  private readonly db: DatabaseType

  constructor(dbPath: string | DatabaseType) {
    if (typeof dbPath === 'string') {
      if (dbPath !== ':memory:') {
        fsSync.mkdirSync(path.dirname(dbPath), { recursive: true })
      }
      this.db = new Database(dbPath)
    } else {
      this.db = dbPath
    }

    try {
      this.db.pragma('journal_mode = WAL')
    } catch {
      // Memory or special filesystems may ignore WAL
    }
    this.db.pragma('busy_timeout = 5000')
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('synchronous = NORMAL')

    this.ensureSchema()
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plugin_storage (
        plugin_id TEXT NOT NULL,
        namespace_version INTEGER NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (plugin_id, namespace_version, key)
      );
      CREATE INDEX IF NOT EXISTS idx_plugin_storage_lookup ON plugin_storage(plugin_id, namespace_version);
    `)

    try {
      const tableInfo = this.db.prepare("PRAGMA table_info('plugin_storage')").all() as Array<{ name: string }>
      if (tableInfo.some((col) => col.name === 'created_at')) {
        this.db.exec('ALTER TABLE plugin_storage DROP COLUMN created_at')
      }
    } catch {
      // Column might not exist or already dropped
    }
  }

  get<T>(pluginId: string, namespaceVersion: number, key: string): T | undefined {
    if (!pluginId || typeof namespaceVersion !== 'number' || !key) return undefined
    const row = this.db
      .prepare(
        'SELECT value_json FROM plugin_storage WHERE plugin_id = ? AND namespace_version = ? AND key = ?',
      )
      .get(pluginId, namespaceVersion, key) as { value_json: string } | undefined
    if (!row) return undefined
    try {
      return JSON.parse(row.value_json) as T
    } catch {
      return undefined
    }
  }

  set<T>(pluginId: string, namespaceVersion: number, key: string, value: T): void {
    if (!pluginId || typeof namespaceVersion !== 'number' || !key) return
    const now = Date.now()
    const valueJson = JSON.stringify(value)
    this.db
      .prepare(
        `INSERT INTO plugin_storage (
          plugin_id, namespace_version, key, value_json, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?
        ) ON CONFLICT (plugin_id, namespace_version, key)
        DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(pluginId, namespaceVersion, key, valueJson, now)
  }

  delete(pluginId: string, namespaceVersion: number, key: string): void {
    if (!pluginId || typeof namespaceVersion !== 'number' || !key) return
    this.db
      .prepare(
        'DELETE FROM plugin_storage WHERE plugin_id = ? AND namespace_version = ? AND key = ?',
      )
      .run(pluginId, namespaceVersion, key)
  }

  listKeys(pluginId: string, namespaceVersion: number): string[] {
    if (!pluginId || typeof namespaceVersion !== 'number') return []
    const rows = this.db
      .prepare(
        'SELECT key FROM plugin_storage WHERE plugin_id = ? AND namespace_version = ? ORDER BY key ASC',
      )
      .all(pluginId, namespaceVersion) as Array<{ key: string }>
    return rows.map((r) => r.key)
  }

  runTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  close(): void {
    this.db.close()
  }
}

export interface MainPluginStorageOptions {
  sqliteStorage?: PluginSqliteStorage
  dbPath?: string
  baseDir?: string
  getHomeDir?: () => string
}

/**
 * MainPluginStorage manages generic namespaced plugin storage, persisting plugin
 * private KV data in the SQLite `plugin_storage` table with WAL mode.
 */
export class MainPluginStorage implements PluginStorageContribution {
  private readonly sqliteStorage: PluginSqliteStorage

  constructor(options: MainPluginStorageOptions = {}) {
    const getHomeDir = options.getHomeDir ?? (() => os.homedir())
    const baseDir = options.baseDir

    if (options.sqliteStorage) {
      this.sqliteStorage = options.sqliteStorage
    } else if (options.dbPath) {
      this.sqliteStorage = new PluginSqliteStorage(options.dbPath)
    } else if (baseDir) {
      this.sqliteStorage = new PluginSqliteStorage(
        path.join(baseDir, 'sessions', 'data.db'),
      )
    } else {
      const home = getHomeDir()
      this.sqliteStorage = new PluginSqliteStorage(
        path.join(home, '.coding-professional-agent', 'sessions', 'data.db'),
      )
    }
  }

  /**
   * Opens a namespaced storage interface for a given plugin ID and namespace version.
   */
  async openNamespace(
    pluginId: string,
    namespaceVersion: number = 1,
  ): Promise<PluginStorageNamespace> {
    if (!pluginId || typeof pluginId !== 'string') {
      throw new Error('pluginId must be a non-empty string')
    }
    if (typeof namespaceVersion !== 'number' || Number.isNaN(namespaceVersion)) {
      throw new Error('namespaceVersion must be a valid number')
    }

    return this.createGenericPluginNamespace(pluginId, namespaceVersion)
  }

  private createGenericPluginNamespace(
    pluginId: string,
    namespaceVersion: number,
  ): PluginStorageNamespace {
    const sqlite = this.sqliteStorage

    return {
      async get<T>(key: string): Promise<T | undefined> {
        return sqlite.get<T>(pluginId, namespaceVersion, key)
      },

      async set<T>(key: string, value: T): Promise<void> {
        sqlite.set<T>(pluginId, namespaceVersion, key, value)
      },

      async delete(key: string): Promise<void> {
        sqlite.delete(pluginId, namespaceVersion, key)
      },

      async transaction<T>(run: (tx: PluginStorageTransaction) => T): Promise<T> {
        return sqlite.runTransaction(() => {
          const tx: PluginStorageTransaction = {
            get<V>(key: string): V | undefined {
              return sqlite.get<V>(pluginId, namespaceVersion, key)
            },
            set<V>(key: string, value: V): void {
              sqlite.set<V>(pluginId, namespaceVersion, key, value)
            },
            delete(key: string): void {
              sqlite.delete(pluginId, namespaceVersion, key)
            },
          }
          return run(tx)
        })
      },
    }
  }
}
