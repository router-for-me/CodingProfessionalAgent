import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { createPluginTestHarness } from '@cpa/plugin-sdk'
import { sessionManagerMainEntry } from './index.js'
import { SessionDatabaseService } from './sessionDatabaseService.js'
import { SessionService } from './sessionService.js'
import manifest from '../manifest.json' with { type: 'json' }

function entriesRevision(payloads: string[]): string {
    return crypto.createHash('sha256').update(JSON.stringify(payloads)).digest('hex')
}

describe('cpa.core.session-manager main entry', () => {
    it('registers services and all 24 session RPC methods on activation', async () => {
        const harness = createPluginTestHarness(sessionManagerMainEntry, {
            manifest,
        })

        await harness.activate()

        const services = harness.getRegistered('service')
        expect(services.map((s) => s.id).sort()).toEqual(['sessionRunRegistry', 'sessionService'])

        const rpcs = harness.getRegistered('rpc')
        expect(rpcs).toHaveLength(24)
        const rpcMethods = rpcs.map((r) => r.id).sort()
        expect(rpcMethods).toEqual([
            'session:abortRun',
            'session:ackDelegateRun',
            'session:broadcastResumePromptState',
            'session:broadcastRunStatus',
            'session:broadcastStreamEvent',
            'session:broadcastSubAgentState',
            'session:claimPendingDelegateRuns',
            'session:delegateRun',
            'session:delete',
            'session:findUnfinished',
            'session:get',
            'session:getActiveRuns',
            'session:getResumePromptState',
            'session:getSystemPrompt',
            'session:list',
            'session:listSessions',
            'session:listSessionsByScheduleId',
            'session:queryMetrics',
            'session:resumePromptAction',
            'session:search',
            'session:set',
            'session:setMeta',
            'session:setSystemPrompt',
            'session:updateSubAgent',
        ])
    })

    it('migrates legacy sessions table to add system_prompt and reads/writes atomically without polluting listSessions', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-sp-mig-'))
        const dbPath = path.join(tmpDir, 'data.db')
        try {
            const legacyDb = new Database(dbPath)
            legacyDb.exec(`
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
                CREATE TABLE session_entries (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    version INTEGER NOT NULL DEFAULT 1,
                    created_at INTEGER NOT NULL,
                    entry_index INTEGER NOT NULL,
                    payload_json TEXT NOT NULL
                );
            `)
            legacyDb.close()

            const service = new SessionService({ dbPath })
            try {
                const db = service.getDatabaseService()
                const setOk = await (service as any).setSystemPrompt('s1', 'ENHANCED_PROMPT')
                expect(setOk).toBe(true)
                expect((db as any).getSystemPrompt('s1')).toBe('ENHANCED_PROMPT')

                const userEntry = {
                    id: 'u1',
                    sessionId: 's1',
                    kind: 'user',
                    version: 1,
                    createdAt: 100,
                    content: [{ type: 'text', text: 'hello' }],
                }
                await service.set('s1', {
                    title: 'Chat 1',
                    entries: [userEntry],
                    expectedEntriesRevision: entriesRevision([]),
                })

                expect(await (service as any).getSystemPrompt('s1')).toBe('ENHANCED_PROMPT')
                expect(((await service.get('s1')) as any)?.systemPrompt).toBe('ENHANCED_PROMPT')

                const listed = await service.listSessions()
                expect(listed).toHaveLength(1)
                expect('systemPrompt' in (listed[0] as any)).toBe(false)
            } finally {
                service.close()
            }
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true })
        }
    })

    it('refuses to resurrect a tombstoned session when a late setSystemPrompt arrives after delete', async () => {
        const service = new SessionService({ dbPath: ':memory:' })
        try {
            await service.set('s-del', { title: 'To Delete', entries: [] })
            await service.delete('s-del')
            const written = await (service as any).setSystemPrompt('s-del', 'LATE_PROMPT')
            expect(written).toBe(false)
            expect(await (service as any).getSystemPrompt('s-del')).toBeNull()
            expect(await service.list()).not.toContain('s-del')
        } finally {
            service.close()
        }
    })
    it('uses atomic first-write-wins for concurrent system prompt writers including empty legacy values', async () => {
        const service = new SessionService({ dbPath: ':memory:' })
        try {
            expect(await service.setSystemPrompt('race', 'FIRST')).toBe(true)
            expect(await service.setSystemPrompt('race', 'SECOND')).toBe(true)
            expect(await service.getSystemPrompt('race')).toBe('FIRST')
        } finally { service.close() }
    })

    it('recovers persisted chained prompt inheritance after restart without exposing an unresolved prompt', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-fork-restart-'))
        const dbPath = path.join(tmpDir, 'data.db')
        let service = new SessionService({ dbPath })
        try {
            await service.setSystemPrompt('a', 'INHERITED')
            await service.set('b', { entries: [], pendingSystemPromptFrom: 'a' })
            await service.set('c', { entries: [], pendingSystemPromptFrom: 'b' })
            await service.set('missing', { entries: [], pendingSystemPromptFrom: 'gone' })
            await service.set('plain', { entries: [] })
            await service.set('plain-fork', { entries: [], pendingSystemPromptFrom: 'plain' })
            service.close()
            service = new SessionService({ dbPath })
            expect((await service.listSessions()).find((s) => s.id === 'c')).toMatchObject({ pendingSystemPromptFrom: 'b' })
            expect(await service.getSystemPrompt('c')).toBe('INHERITED')
            expect(await service.getSystemPrompt('b')).toBe('INHERITED')
            await expect(service.getSystemPrompt('missing')).rejects.toThrow()
            expect(await service.getSystemPrompt('plain-fork')).toBeNull()
            await service.delete('plain')
            expect(await service.getSystemPrompt('plain-fork')).toBeNull()
            await service.set('plain-fork', { entries: [], pendingSystemPromptFrom: 'plain' })
            expect(await service.getSystemPrompt('plain-fork')).toBeNull()
        } finally { service.close(); fs.rmSync(tmpDir, { recursive: true, force: true }) }
    })

    it('never overwrites an already-locked system_prompt or pending fork inheritance during regular SessionSet', async () => {
        const service = new SessionService({ dbPath: ':memory:' })
        try {
            expect(await service.setSystemPrompt('locked-1', 'FIRST_LOCKED')).toBe(true)
            await service.set('locked-1', {
                title: 'Updated',
                entries: [],
                systemPrompt: 'OVERWRITE_ATTEMPT',
            })
            expect(await service.getSystemPrompt('locked-1')).toBe('FIRST_LOCKED')

            // Also respects pending fork inheritance if SessionSet supplies systemPrompt before first getSystemPrompt
            await service.setSystemPrompt('fork-src', 'PARENT_LOCKED')
            await service.set('fork-child', {
                entries: [],
                pendingSystemPromptFrom: 'fork-src',
            })
            await service.set('fork-child', {
                entries: [],
                systemPrompt: 'CHILD_OVERWRITE_ATTEMPT',
            })
            expect(await service.getSystemPrompt('fork-child')).toBe('PARENT_LOCKED')

            // Also resolves pending fork inheritance on first insert even when systemPrompt is provided
            await service.set('fork-fresh', {
                entries: [],
                pendingSystemPromptFrom: 'fork-src',
                systemPrompt: 'CHILD_FIRST_INSERT_OVERWRITE',
            })
            expect(await service.getSystemPrompt('fork-fresh')).toBe('PARENT_LOCKED')

            // Chained pending fork on first insert with explicit systemPrompt
            await service.set('fork-mid', {
                entries: [],
                pendingSystemPromptFrom: 'fork-src',
            })
            await service.set('fork-leaf', {
                entries: [],
                pendingSystemPromptFrom: 'fork-mid',
                systemPrompt: 'LEAF_OVERWRITE',
            })
            expect(await service.getSystemPrompt('fork-leaf')).toBe('PARENT_LOCKED')
        } finally {
            service.close()
        }
    })

})
