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
        const matcher = new SearchMatcher(queries, matchMode, caseSensitive, normalized, lineCount)
        const matches: MemorySearchHit[] = []
        const rows = db.prepare('SELECT id, title, content FROM memories ORDER BY id DESC').all() as MemoryRow[]
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
        const result = db.prepare('INSERT INTO memories (title, content, created_at, updated_at) VALUES (?, ?, ?, ?)')
            .run(title, note, timestamp, timestamp)
        return { success: true, id: Number(result.lastInsertRowid) }
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
            `)
            this.migrateLegacyFiles(db)
            this.db = db
            return db
        } catch (error) {
            db.close()
            throw error
        }
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
