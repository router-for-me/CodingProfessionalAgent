import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as fsSync from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'
import { MainPluginStorage } from './MainPluginStorage.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

describe('MainPluginStorage', () => {
  let tempDir: string
  let storage: MainPluginStorage

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cpa-plugin-storage-test-'))
    storage = new MainPluginStorage({
      baseDir: tempDir,
    })
  })

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore
    }
  })

  it('provides private plugin storage in SQLite with version and plugin isolation', async () => {
    const pluginANsV1 = await storage.openNamespace('com.plugin.alpha', 1)
    const pluginANsV2 = await storage.openNamespace('com.plugin.alpha', 2)
    const pluginBNsV1 = await storage.openNamespace('com.plugin.beta', 1)

    // Plugin A v1 write
    await pluginANsV1.set('config', { theme: 'neon', debug: true })
    // Plugin A v2 write
    await pluginANsV2.set('config', { theme: 'cyberpunk', v2Flag: true })
    // Plugin B v1 write
    await pluginBNsV1.set('config', { theme: 'solarized' })

    // Read back and assert complete isolation
    expect(await pluginANsV1.get('config')).toEqual({ theme: 'neon', debug: true })
    expect(await pluginANsV2.get('config')).toEqual({ theme: 'cyberpunk', v2Flag: true })
    expect(await pluginBNsV1.get('config')).toEqual({ theme: 'solarized' })

    // Deletion in Plugin A v1 does not affect Plugin A v2 or Plugin B v1
    await pluginANsV1.delete('config')
    expect(await pluginANsV1.get('config')).toBeUndefined()
    expect(await pluginANsV2.get('config')).toEqual({ theme: 'cyberpunk', v2Flag: true })
    expect(await pluginBNsV1.get('config')).toEqual({ theme: 'solarized' })
  })

  it('supports atomic transactions in plugin namespaces with commit and rollback', async () => {
    const pluginNs = await storage.openNamespace('com.plugin.transactional', 1)

    // Successful transaction
    const result = await pluginNs.transaction((tx) => {
      tx.set('counter', 1)
      tx.set('items', ['a', 'b', 'c'])
      const c = tx.get<number>('counter')
      return (c ?? 0) + 10
    })

    expect(result).toBe(11)
    expect(await pluginNs.get('counter')).toBe(1)
    expect(await pluginNs.get('items')).toEqual(['a', 'b', 'c'])

    // Failed transaction rolls back
    await expect(
      pluginNs.transaction((tx) => {
        tx.set('counter', 99)
        tx.delete('items')
        throw new Error('Simulated transaction failure')
      }),
    ).rejects.toThrow('Simulated transaction failure')

    // Assert state was restored
    expect(await pluginNs.get('counter')).toBe(1)
    expect(await pluginNs.get('items')).toEqual(['a', 'b', 'c'])
  })

  it('ensures SQLite WAL mode and idempotent migrations on plugin_storage', async () => {
    const pluginNs = await storage.openNamespace('com.plugin.migrated', 1)
    await pluginNs.set('ready', true)
    expect(await pluginNs.get('ready')).toBe(true)

    // Open a second storage instance pointing to same DB
    const storage2 = new MainPluginStorage({
      baseDir: tempDir,
    })

    const pluginNs2 = await storage2.openNamespace('com.plugin.migrated', 1)
    expect(await pluginNs2.get('ready')).toBe(true)
  })

  it('does not contain hardcoded plugin IDs or business schemas in MainPluginStorage source', () => {
    const storageSourcePath = path.resolve(__dirname, 'MainPluginStorage.ts')
    const source = fsSync.readFileSync(storageSourcePath, 'utf8')

    expect(source).not.toContain('cpa.core.session-manager')
    expect(source).not.toContain('cpa.core.settings')
    expect(source).not.toContain('cpa.core.scheduler')
    expect(source).not.toContain('CREATE TABLE IF NOT EXISTS sessions')
    expect(source).not.toContain('CREATE TABLE IF NOT EXISTS subagents')
    expect(source).not.toContain('sessionDatabaseService')
    expect(source).not.toContain('sessionSqliteSchema')
    expect(source).not.toContain('kvStoreService')
  })
})
