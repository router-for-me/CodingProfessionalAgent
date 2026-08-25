import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { MainPluginStorage } from '../src/main/plugins/storage/MainPluginStorage.js'
import { SessionDatabaseService } from '../plugins/bundled/cpa.core.session-manager/main/sessionDatabaseService.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

describe('Standalone SessionDatabaseService & MainPluginStorage', () => {
    let tempDir: string
    let sessionDb: SessionDatabaseService
    let storage: MainPluginStorage

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cpa-storage-fallback-test-'))

        // Create legacy session db
        const fixturesDir = path.resolve(__dirname, 'fixtures/legacy-data')
        const dbPath = path.join(tempDir, 'sessions', 'data.db')
        const helperModule = await import(
            pathToFileURL(path.join(fixturesDir, 'create-session-db.ts')).href
        )
        helperModule.createLegacySessionDb(dbPath)

        sessionDb = new SessionDatabaseService({ dbPath })
        storage = new MainPluginStorage({ baseDir: tempDir })
    })

    afterEach(async () => {
        sessionDb.close()
        await fs.rm(tempDir, { recursive: true, force: true })
    })

    it('does not return empty sessions or null on standalone SessionDatabaseService', async () => {
        // 1. listSessions should return existing legacy sessions, not empty array []
        const sessions = await sessionDb.listSessions()
        expect(sessions).toBeDefined()
        expect(Array.isArray(sessions)).toBe(true)
        expect(sessions.length).toBeGreaterThan(0)
        expect(sessions[0].id).toBe('sess-legacy-1')

        // 2. get session by id should return session object, not null
        const session = await sessionDb.get('sess-legacy-1')
        expect(session).toBeDefined()
        expect(session?.id).toBe('sess-legacy-1')
        expect(session?.entries).toHaveLength(2)

        // 3. get session-meta should return session item
        const meta = await sessionDb.getMeta('sess-legacy-1')
        expect(meta).toBeDefined()
        expect(meta?.id).toBe('sess-legacy-1')
        expect(meta?.title).toBe('Legacy Main Session')
    })

    it('provides isolated generic plugin storage on MainPluginStorage with baseDir', async () => {
        const pluginNs = await storage.openNamespace('com.test.standalone', 1)
        await pluginNs.set('key', { value: 42 })
        expect(await pluginNs.get('key')).toEqual({ value: 42 })
    })
})

