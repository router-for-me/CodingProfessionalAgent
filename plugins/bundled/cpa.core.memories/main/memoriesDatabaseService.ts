import Database, { type Database as DatabaseType } from 'better-sqlite3'
import fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { getAppConfigDirName } from '@cpa/plugin-api'
import { parseLegacyMemoryFilename } from '../shared/legacyFilename.js'
import { buildSnippet, matchMemoryContent, SearchMatcher } from '../shared/memorySearch.js'
import { approxTokenCount, truncateMiddleWithTokenBudget } from '../shared/tokenBudget.js'
import type {
    AddMemoryRequest,
    AddMemoryResponse,
    MemorySearchHit,
    ReadMemoriesRequest,
    ReadMemoriesResponse,
    SearchMemoriesRequest,
    SearchMemoriesResponse,
} from '../shared/types.js'
import { validateAddRequest, validateReadRequest, validateSearchRequest } from '../shared/validation.js'

const NON_ASCII_CASED_RE = /(?:(?=[^\x00-\x7f])\p{Cased}|\u0307)/u

const SEARCH_INDEX_TRIGGERS_SQL = `
    CREATE TRIGGER IF NOT EXISTS trg_memories_fts_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
        INSERT INTO memories_unicode_docs(memory_id, has_unicode_case) VALUES (new.id, -1)
            ON CONFLICT(memory_id) DO UPDATE SET has_unicode_case = -1;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_memories_fts_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.id, old.content);
        DELETE FROM memories_unicode_docs WHERE memory_id = old.id;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_memories_fts_au AFTER UPDATE OF content ON memories
    WHEN old.content IS NOT new.content BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.id, old.content);
        INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
        INSERT INTO memories_unicode_docs(memory_id, has_unicode_case) VALUES (new.id, -1)
            ON CONFLICT(memory_id) DO UPDATE SET has_unicode_case = -1;
    END;
`

function checkSearchIndexState(db: DatabaseType): {
    indexReady: boolean
    hasUnicodeCaseColumn: boolean
    triggersReady: boolean
} {
    const indexMarker = db.prepare("SELECT value FROM memories_meta WHERE key = 'fts_index_v1'").get() as { value: string } | undefined
    const searchTriggers = db.prepare(`
        SELECT count(*) AS count FROM sqlite_master WHERE type = 'trigger'
        AND name IN ('trg_memories_fts_ai', 'trg_memories_fts_ad', 'trg_memories_fts_au')
        AND sql LIKE '%memories_unicode_docs%'
    `).get() as { count: number }
    const hasUnicodeCaseColumn = (db.pragma('table_info(memories_unicode_docs)') as { name: string }[])
        .some((column) => column.name === 'has_unicode_case')
    return {
        indexReady: indexMarker?.value === '1',
        hasUnicodeCaseColumn,
        triggersReady: searchTriggers.count === 3,
    }
}

function needsFallbackScan(content: string): boolean {
    return NON_ASCII_CASED_RE.test(content) || content.includes('\0')
}

function isFtsEligibleQuery(query: string, caseSensitive: boolean): boolean {
    if (query.includes('\r') || query.includes('\n') || query.includes('\0')) return false
    return Array.from(query).length >= 3 && (caseSensitive || !NON_ASCII_CASED_RE.test(query))
}

function escapeFtsPhrase(q: string): string {
    return '"' + q.replace(/"/g, '""') + '"'
}

export interface MemoriesDatabaseOptions {
    memoryRoot?: string
    dbPath?: string
}

interface MemoryRow {
    id: number
    title: string
    content: string
}

interface LegacyMemory {
    title: string
    content: string
    createdAt: number
    relativePath: string
}

export class MemoriesDatabaseService {
    private readonly memoryRoot: string
    private readonly dbPath: string
    private db: DatabaseType | null = null

    constructor(options: MemoriesDatabaseOptions = {}) {
        this.memoryRoot = options.memoryRoot ?? path.join(os.homedir(), getAppConfigDirName(), 'memories')
        this.dbPath = options.dbPath ?? path.join(this.memoryRoot, 'memories.db')
    }

    getDbPath(): string {
        this.ensureReady()
        return this.dbPath
    }

    search(request: SearchMemoriesRequest): SearchMemoriesResponse {
        const { queries, matchMode, caseSensitive, normalized, lineCount, startIndex, maxResults } = validateSearchRequest(request)
        const db = this.ensureReady()
        this.syncPendingUnicodeDocs(db)
        const matcher = new SearchMatcher(queries, matchMode, caseSensitive, normalized, lineCount)
        const matches: MemorySearchHit[] = []
        let ftsExpression: string | undefined
        if (!normalized) {
            const eligible = queries.filter((q) => isFtsEligibleQuery(q, caseSensitive))
            if (matchMode === 'any') {
                if (eligible.length === queries.length) {
                    ftsExpression = eligible.map(escapeFtsPhrase).join(' OR ')
                }
            } else if (eligible.length > 0) {
                ftsExpression = eligible.map(escapeFtsPhrase).join(' AND ')
            }
        }
        const rows = (ftsExpression === undefined
            ? db.prepare('SELECT id, title, content FROM memories ORDER BY id DESC').all()
            : db.prepare(`
                SELECT m.id, m.title, m.content
                FROM memories m
                WHERE m.id IN (SELECT rowid FROM memories_fts WHERE content MATCH ?)
                   OR m.id IN (SELECT memory_id FROM memories_unicode_docs)
                ORDER BY m.id DESC
            `).all(ftsExpression)) as MemoryRow[]
        for (const row of rows) {
            const match = matchMemoryContent(row.content, matcher)
            if (match) {
                matches.push({
                    id: row.id,
                    title: row.title,
                    matchedQueries: match.matchedQueries,
                    snippet: buildSnippet(match.firstMatchLine),
                })
            }
        }
        if (startIndex > matches.length) {
            throw new Error(`cursor '${request.cursor}' exceeds result count ${matches.length}`)
        }
        const endIndex = startIndex + maxResults
        const truncated = endIndex < matches.length
        return {
            matches: matches.slice(startIndex, endIndex),
            ...(truncated ? { nextCursor: String(endIndex) } : {}),
            truncated,
        }
    }

    read(request: ReadMemoriesRequest): ReadMemoriesResponse {
        const { ids, maxTokens } = validateReadRequest(request)
        const db = this.ensureReady()
        const placeholders = ids.map(() => '?').join(', ')
        const rows = db.prepare(`SELECT id, title, content FROM memories WHERE id IN (${placeholders})`).all(...ids) as MemoryRow[]
        const byId = new Map(rows.map((row) => [row.id, row]))
        const response: ReadMemoriesResponse = { memories: [], missingIds: [] }
        let remaining = maxTokens
        let left = rows.length
        for (const id of ids) {
            const row = byId.get(id)
            if (!row) {
                response.missingIds.push(id)
                continue
            }
            const share = Math.floor(remaining / left)
            const result = truncateMiddleWithTokenBudget(row.content, share)
            response.memories.push({ id, title: row.title, ...result })
            remaining = Math.max(0, remaining - approxTokenCount(result.content))
            left--
        }
        return response
    }

    add(request: AddMemoryRequest): AddMemoryResponse {
        const { title, note } = validateAddRequest(request)
        const db = this.ensureReady()
        const timestamp = Date.now()
        const id = db.transaction(() => {
            const result = db.prepare('INSERT INTO memories (title, content, created_at, updated_at) VALUES (?, ?, ?, ?)')
                .run(title, note, timestamp, timestamp)
            this.syncPendingUnicodeDocs(db)
            return Number(result.lastInsertRowid)
        })()
        return { success: true, id }
    }

    clear(): void {
        const db = this.ensureReady()
        db.prepare('DELETE FROM memories').run()
        db.exec('VACUUM')
    }

    close(): void {
        this.db?.close()
        this.db = null
    }

    private ensureReady(): DatabaseType {
        if (this.db) return this.db
        fs.mkdirSync(this.memoryRoot, { recursive: true })
        fs.mkdirSync(path.dirname(this.dbPath), { recursive: true })
        const db = new Database(this.dbPath)
        try {
            db.pragma('journal_mode = WAL')
            db.pragma('busy_timeout = 5000')
            db.pragma('synchronous = NORMAL')
            const hadFtsTable = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memories_fts'").get())
            db.exec(`
                CREATE TABLE IF NOT EXISTS memories (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    title TEXT NOT NULL,
                    content TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS memories_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS memories_unicode_docs (
                    memory_id INTEGER PRIMARY KEY,
                    has_unicode_case INTEGER NOT NULL DEFAULT -1,
                    FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
                );
                CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
                    content,
                    content='memories',
                    content_rowid='id',
                    tokenize='trigram'
                );
            `)
            this.migrateLegacyFiles(db)
            this.ensureSearchIndex(db, hadFtsTable)
            this.db = db
            return db
        } catch (error) {
            db.close()
            throw error
        }
    }

    private ensureSearchIndex(db: DatabaseType, hadFtsTable: boolean): void {
        const initial = checkSearchIndexState(db)
        if (hadFtsTable && initial.indexReady && initial.hasUnicodeCaseColumn && initial.triggersReady) {
            this.syncPendingUnicodeDocs(db)
            return
        }
        db.transaction(() => {
            const current = checkSearchIndexState(db)
            if (hadFtsTable && current.indexReady && current.hasUnicodeCaseColumn && current.triggersReady) return
            if (!current.hasUnicodeCaseColumn) {
                db.exec('ALTER TABLE memories_unicode_docs ADD COLUMN has_unicode_case INTEGER NOT NULL DEFAULT -1')
            }
            db.prepare('DELETE FROM memories_unicode_docs').run()
            db.prepare("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')").run()
            db.prepare('INSERT INTO memories_unicode_docs (memory_id) SELECT id FROM memories').run()
            db.exec(`
                DROP TRIGGER IF EXISTS trg_memories_fts_ai;
                DROP TRIGGER IF EXISTS trg_memories_fts_ad;
                DROP TRIGGER IF EXISTS trg_memories_fts_au;
            `)
            db.exec(SEARCH_INDEX_TRIGGERS_SQL)
            db.prepare("INSERT OR REPLACE INTO memories_meta (key, value) VALUES ('fts_index_v1', '1')").run()
        }).immediate()
        this.syncPendingUnicodeDocs(db)
    }

    private syncPendingUnicodeDocs(db: DatabaseType): void {
        if (!db.prepare('SELECT 1 FROM memories_unicode_docs WHERE has_unicode_case < 0 LIMIT 1').get()) return
        db.transaction(() => {
            const rows = db.prepare(`
                SELECT m.id, m.content FROM memories_unicode_docs u
                JOIN memories m ON m.id = u.memory_id
                WHERE u.has_unicode_case < 0
            `).all() as Pick<MemoryRow, 'id' | 'content'>[]
            const update = db.prepare('UPDATE memories_unicode_docs SET has_unicode_case = 1 WHERE memory_id = ?')
            const remove = db.prepare('DELETE FROM memories_unicode_docs WHERE memory_id = ?')
            for (const row of rows) {
                if (needsFallbackScan(row.content)) {
                    update.run(row.id)
                } else {
                    remove.run(row.id)
                }
            }
        }).immediate()
    }

    private migrateLegacyFiles(db: DatabaseType): void {
        if (db.prepare("SELECT value FROM memories_meta WHERE key = 'legacy_files_migrated'").get()) return
        try {
            const memories: LegacyMemory[] = []
            this.collectLegacyFiles(this.memoryRoot, memories)
            memories.sort((a, b) => {
                if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
                return a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0
            })
            db.transaction(() => {
                const insert = db.prepare('INSERT INTO memories (title, content, created_at, updated_at) VALUES (?, ?, ?, ?)')
                for (const memory of memories) {
                    insert.run(memory.title, memory.content, memory.createdAt, memory.createdAt)
                }
                db.prepare("INSERT INTO memories_meta (key, value) VALUES ('legacy_files_migrated', '1')").run()
            })()
        } catch (error) {
            console.warn('Failed to migrate legacy memories', error)
            throw error
        }
    }

    private collectLegacyFiles(directory: string, memories: LegacyMemory[]): void {
        let entries: fs.Dirent[]
        try {
            entries = fs.readdirSync(directory, { withFileTypes: true })
        } catch (error) {
            if (directory === this.memoryRoot) throw error
            console.warn(`Skipping unreadable legacy memory directory ${directory}`, error)
            return
        }
        for (const entry of entries) {
            if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
            const filePath = path.join(directory, entry.name)
            if (entry.isDirectory()) {
                this.collectLegacyFiles(filePath, memories)
            } else if (entry.isFile() && path.extname(entry.name) === '.md') {
                try {
                    const content = fs.readFileSync(filePath, 'utf8')
                    const parsed = parseLegacyMemoryFilename(entry.name)
                    const createdAt = parsed.createdAt ?? Math.floor(fs.statSync(filePath).mtimeMs)
                    memories.push({
                        title: parsed.title,
                        content,
                        createdAt,
                        relativePath: path.relative(this.memoryRoot, filePath),
                    })
                } catch (error) {
                    console.warn(`Skipping unreadable legacy memory ${filePath}`, error)
                }
            }
        }
    }
}
