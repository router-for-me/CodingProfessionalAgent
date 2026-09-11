/**
 * Local memories backend implementation for CPA.
 * Provides safe scoped filesystem operations, multi-mode text search,
 * token truncation, ad-hoc notes management, and local memory lifecycle.
 */

import {
    DEFAULT_READ_MAX_TOKENS,
    MAX_LIST_RESULTS,
    MAX_SEARCH_RESULTS,
    type AddAdHocNoteRequest,
    type AddAdHocNoteResponse,
    type ListMemoriesRequest,
    type ListMemoriesResponse,
    type MemoryEntry,
    type MemorySearchMatch,
    type ReadMemoryRequest,
    type ReadMemoryResponse,
    type SearchMatchMode,
    type SearchMemoriesRequest,
    type SearchMemoriesResponse,
} from './types'
import { getAppConfigDirName } from '@cpa/plugin-api'

export interface ElectronBridgeLike {
    RuntimeInfo?(): Promise<{ platform?: string; userConfigDir?: string; tempDir?: string; homeDir: string }>
    ReadFile?(path: string): Promise<{ dataBase64: string }>
    WriteFile?(path: string, dataBase64: string): Promise<void>
    MkdirAll?(path: string): Promise<void>
    RemoveFile?(path: string): Promise<void>
    Stat?(path: string): Promise<{ name: string; size: number; mode: number; isDir: boolean; isSymbolicLink?: boolean }>
    ReadDir?(path: string): Promise<Array<{ name: string; isDir: boolean; isSymbolicLink?: boolean }> | null>
    RealPath?(path: string): Promise<string>
}

export interface LocalMemoriesBackendOptions {
    memoryRoot?: string
    bridge?: ElectronBridgeLike
}

const AD_HOC_NOTE_FILENAME_MAX_BYTES = 128
const AD_HOC_NOTE_SLUG_MAX_BYTES = 80
const TIMESTAMP_PREFIX_LEN = 20
const APPROX_BYTES_PER_TOKEN = 4

/**
 * Encode string to base64 using UTF-8 safe TextEncoder.
 */
export function stringToBase64(str: string): string {
    const bytes = new TextEncoder().encode(str)
    let binary = ''
    const chunkSize = 0x8000
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
    }
    return btoa(binary)
}

/**
 * Decode base64 to UTF-8 string.
 */
export function base64ToString(b64: string): string {
    if (!b64) return ''
    try {
        const binary = atob(b64)
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i += 1) {
            bytes[i] = binary.charCodeAt(i)
        }
        return new TextDecoder().decode(bytes)
    } catch {
        return ''
    }
}

/**
 * Normalize path separators to POSIX slash.
 */
export function normalizeSeparators(p: string): string {
    return p.replace(/\\/g, '/')
}

/**
 * Join path segments using normalized separators.
 */
export function joinPath(...segments: string[]): string {
    const cleaned = segments
        .map((s) => normalizeSeparators(s))
        .filter(Boolean)
        .map((s, idx) => {
            let res = s
            if (idx > 0) res = res.replace(/^\/+/, '')
            if (idx < segments.length - 1) res = res.replace(/\/+$/, '')
            return res
        })
        .filter((s) => s.length > 0)
    return cleaned.join('/')
}

/**
 * Convert full path to display path relative to memory root.
 */
export function displayRelativePath(root: string, fullPath: string): string {
    const normRoot = normalizeSeparators(root).replace(/\/+$/, '')
    const normPath = normalizeSeparators(fullPath)
    if (normPath === normRoot) {
        return ''
    }
    if (normPath.startsWith(normRoot + '/')) {
        return normPath.slice(normRoot.length + 1)
    }
    return normPath
}

/**
 * Split content into lines matching Rust `str.lines()` semantics:
 * - Empty string results in 0 lines ([]).
 * - Trailing newline (\n or \r\n) does not create an extra trailing empty line.
 * - Handles both CRLF (\r\n) and LF (\n).
 */
export function splitLines(content: string): string[] {
    if (content.length === 0) {
        return []
    }
    let text = content
    if (text.endsWith('\r\n')) {
        text = text.slice(0, -2)
    } else if (text.endsWith('\n')) {
        text = text.slice(0, -1)
    }
    if (text.length === 0) {
        return ['']
    }
    return text.split(/\r?\n/)
}

/**
 * Resolve canonical real path for a given path using the bridge.
 */
export async function getCanonicalPath(bridge: ElectronBridgeLike, targetPath: string): Promise<string> {
    try {
        if (bridge.RealPath) {
            const res = await bridge.RealPath(targetPath)
            if (res) return normalizeSeparators(res).replace(/\/+$/, '')
        }
        if ((bridge as { realPath?: (p: string) => Promise<string> }).realPath) {
            const res = await (bridge as { realPath: (p: string) => Promise<string> }).realPath(targetPath)
            if (res) return normalizeSeparators(res).replace(/\/+$/, '')
        }
    } catch {
        // Fall back to normalized input path if realPath is not supported or fails
    }
    return normalizeSeparators(targetPath).replace(/\/+$/, '')
}

/**
 * Check whether canonicalPath strictly stays within canonicalRoot.
 */
export function isPathContained(canonicalRoot: string, canonicalPath: string): boolean {
    const normRoot = normalizeSeparators(canonicalRoot).replace(/\/+$/, '')
    const normPath = normalizeSeparators(canonicalPath).replace(/\/+$/, '')
    return normPath === normRoot || normPath.startsWith(normRoot + '/')
}

/**
 * Validate ad-hoc note filename format `YYYY-MM-DDTHH-MM-SS-<slug>.md`.
 */
export function validateAdHocFilename(filename: string): void {
    const encoder = new TextEncoder()
    const byteLen = encoder.encode(filename).length
    if (byteLen > AD_HOC_NOTE_FILENAME_MAX_BYTES) {
        throw new Error(`filename '${filename}' must be at most 128 bytes`)
    }
    if (!filename.endsWith('.md')) {
        throw new Error(`filename '${filename}' must end with .md`)
    }
    const stem = filename.slice(0, -3)
    if (stem.length <= TIMESTAMP_PREFIX_LEN) {
        throw new Error(`filename '${filename}' must use YYYY-MM-DDTHH-MM-SS-<slug>.md`)
    }
    const prefix = stem.slice(0, TIMESTAMP_PREFIX_LEN)
    const slug = stem.slice(TIMESTAMP_PREFIX_LEN)

    // Timestamp prefix format: YYYY-MM-DDTHH-MM-SS-
    const timestampRegex = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-$/
    if (!timestampRegex.test(prefix)) {
        throw new Error(`filename '${filename}' must use YYYY-MM-DDTHH-MM-SS-<slug>.md`)
    }

    const slugByteLen = encoder.encode(slug).length
    if (slugByteLen === 0 || slugByteLen > AD_HOC_NOTE_SLUG_MAX_BYTES) {
        throw new Error(`filename '${filename}' slug must be 1 to 80 bytes`)
    }

    const slugRegex = /^[a-z0-9-]+$/
    if (!slugRegex.test(slug)) {
        throw new Error(`filename '${filename}' slug must contain only lowercase ASCII letters, digits, or hyphens`)
    }
}

/**
 * Approximate token count for text.
 */
export function approxTokenCount(text: string): number {
    const byteLength = new TextEncoder().encode(text).length
    return Math.floor((byteLength + (APPROX_BYTES_PER_TOKEN - 1)) / APPROX_BYTES_PER_TOKEN)
}

/**
 * Approximate bytes for a given token count.
 */
export function approxBytesForTokens(tokens: number): number {
    return tokens * APPROX_BYTES_PER_TOKEN
}

/**
 * Truncate middle of text to fit within maxTokens budget.
 */
export function truncateMiddleWithTokenBudget(
    text: string,
    maxTokens: number,
): { content: string; truncated: boolean } {
    if (!text) {
        return { content: '', truncated: false }
    }
    const encoder = new TextEncoder()
    const textBytes = encoder.encode(text)
    const maxBytes = approxBytesForTokens(maxTokens)

    if (maxTokens > 0 && textBytes.length <= maxBytes) {
        return { content: text, truncated: false }
    }

    if (maxBytes === 0) {
        const removedTokens = Math.floor((textBytes.length + 3) / APPROX_BYTES_PER_TOKEN)
        return {
            content: `…${removedTokens} tokens truncated…`,
            truncated: true,
        }
    }

    const leftBudget = Math.floor(maxBytes / 2)
    const rightBudget = maxBytes - leftBudget

    let leftEnd = 0
    let rightStart = text.length

    let currentByteCount = 0
    for (let i = 0; i < text.length; i++) {
        const codePoint = text.codePointAt(i)!
        const charBytes = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4
        if (currentByteCount + charBytes <= leftBudget) {
            currentByteCount += charBytes
            if (codePoint > 0xffff) i++
            leftEnd = i + 1
        } else {
            break
        }
    }

    const tailStartTargetBytes = Math.max(0, textBytes.length - rightBudget)
    currentByteCount = 0
    for (let i = 0; i < text.length; i++) {
        const codePoint = text.codePointAt(i)!
        const charBytes = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4
        if (currentByteCount >= tailStartTargetBytes) {
            rightStart = i
            break
        }
        currentByteCount += charBytes
        if (codePoint > 0xffff) i++
    }

    if (rightStart < leftEnd) {
        rightStart = leftEnd
    }

    const left = text.slice(0, leftEnd)
    const right = text.slice(rightStart)

    const removedBytes = Math.max(0, textBytes.length - maxBytes)
    const removedTokens = Math.floor((removedBytes + 3) / APPROX_BYTES_PER_TOKEN)
    const marker = `…${removedTokens} tokens truncated…`

    return {
        content: `${left}${marker}${right}`,
        truncated: true,
    }
}

/**
 * Metadata query helper catching errors when path is absent.
 */
async function metadataOrNull(
    bridge: ElectronBridgeLike,
    targetPath: string,
): Promise<{ name: string; size: number; mode: number; isDir: boolean; isSymbolicLink?: boolean } | null> {
    if (!bridge.Stat) {
        return null
    }
    try {
        const stat = await bridge.Stat(targetPath)
        return stat
    } catch {
        return null
    }
}

/**
 * Resolve memory root path from options or bridge RuntimeInfo.
 */
export async function resolveMemoryRoot(options?: LocalMemoriesBackendOptions): Promise<string> {
    if (options?.memoryRoot) {
        return options.memoryRoot
    }
    const bridge = options?.bridge
    if (bridge?.RuntimeInfo) {
        try {
            const info = await bridge.RuntimeInfo()
            if (info?.homeDir) {
                const sep = info.homeDir.includes('\\') ? '\\' : '/'
                const dirName = (info as any)?.appConfigDirName || getAppConfigDirName((info as any)?.isDebug)
                return `${info.homeDir}${sep}${dirName}${sep}memories`
            }
        } catch {
            // Fall back to default location
        }
    }
    return `~/${getAppConfigDirName()}/memories`
}

/**
 * Resolve backend execution context.
 */
export async function resolveBackendContext(
    options?: LocalMemoriesBackendOptions,
): Promise<{ root: string; bridge: ElectronBridgeLike }> {
    const bridge = options?.bridge
    if (!bridge) {
        throw new Error('bridge is unavailable')
    }
    const root = await resolveMemoryRoot(options)
    return { root, bridge }
}

/**
 * Resolve and validate scoped path within memory root.
 */
export async function resolveScopedPath(
    root: string,
    bridge: ElectronBridgeLike,
    relativePath?: string | null,
): Promise<string> {
    const canonicalRoot = await getCanonicalPath(bridge, root)

    if (!relativePath) {
        return root
    }

    const norm = normalizeSeparators(relativePath)
    if (norm.startsWith('/') || /^[a-zA-Z]:/.test(norm)) {
        throw new Error(`path '${relativePath}' must stay within the memories root`)
    }

    const components = norm.split('/').filter(Boolean)
    if (components.some((c) => c === '..')) {
        throw new Error(`path '${relativePath}' must stay within the memories root`)
    }
    if (components.some((c) => c.startsWith('.'))) {
        throw new Error(`path '${relativePath}' was not found`)
    }

    let scopedPath = root
    for (let i = 0; i < components.length; i++) {
        const comp = components[i]
        scopedPath = joinPath(scopedPath, comp)

        const stat = await metadataOrNull(bridge, scopedPath)
        if (!stat) {
            for (let j = i + 1; j < components.length; j++) {
                scopedPath = joinPath(scopedPath, components[j])
            }
            const normScoped = normalizeSeparators(scopedPath)
            const normRoot = normalizeSeparators(root).replace(/\/+$/, '')
            if (normScoped !== normRoot && !normScoped.startsWith(normRoot + '/')) {
                throw new Error(`path '${relativePath}' must stay within the memories root`)
            }
            return scopedPath
        }

        const canonicalPath = await getCanonicalPath(bridge, scopedPath)
        if (!isPathContained(canonicalRoot, canonicalPath)) {
            throw new Error(`path '${relativePath}' must stay within the memories root`)
        }

        if (stat.isSymbolicLink || (stat.mode && (stat.mode & 0o170000) === 0o120000)) {
            throw new Error(`path '${displayRelativePath(root, scopedPath)}' must not be a symlink`)
        }

        if (i + 1 < components.length && !stat.isDir) {
            throw new Error(`path '${relativePath}' traverses through a non-directory path component`)
        }
    }

    const canonicalPath = await getCanonicalPath(bridge, scopedPath)
    if (!isPathContained(canonicalRoot, canonicalPath)) {
        throw new Error(`path '${relativePath}' must stay within the memories root`)
    }

    return scopedPath
}

/**
 * List memory entries within memory root or scoped subpath.
 */
export async function listMemories(
    request: ListMemoriesRequest,
    options?: LocalMemoriesBackendOptions,
): Promise<ListMemoriesResponse> {
    const { root, bridge } = await resolveBackendContext(options)
    const canonicalRoot = await getCanonicalPath(bridge, root)
    const maxResults = Math.min(
        typeof request.maxResults === 'number' && Number.isFinite(request.maxResults) && request.maxResults > 0
            ? Math.floor(request.maxResults)
            : MAX_LIST_RESULTS,
        MAX_LIST_RESULTS,
    )
    const scopedPath = await resolveScopedPath(root, bridge, request.path)
    let startIndex = 0
    if (request.cursor !== undefined && request.cursor !== null && request.cursor !== '') {
        const parsed = Number(request.cursor)
        if (!Number.isInteger(parsed) || parsed < 0) {
            throw new Error(`cursor '${request.cursor}' must be a non-negative integer`)
        }
        startIndex = parsed
    }

    const metadata = await metadataOrNull(bridge, scopedPath)
    if (!metadata) {
        throw new Error(`path '${request.path ?? ''}' was not found`)
    }
    if (metadata.isSymbolicLink || (metadata.mode && (metadata.mode & 0o170000) === 0o120000)) {
        throw new Error(`path '${displayRelativePath(root, scopedPath)}' must not be a symlink`)
    }

    const readDirFn = bridge.ReadDir ? bridge.ReadDir.bind(bridge) : (bridge as { readDir?: (p: string) => Promise<Array<{ name: string; isDir: boolean; isSymbolicLink?: boolean }> | null> }).readDir?.bind(bridge)
    let entries: MemoryEntry[] = []
    if (!metadata.isDir) {
        entries = [
            {
                path: displayRelativePath(root, scopedPath),
                entryType: 'file',
            },
        ]
    } else if (readDirFn) {
        const rawEntries = (await readDirFn(scopedPath)) || []
        const sortedRaw = [...rawEntries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        for (const entry of sortedRaw) {
            if (entry.name.startsWith('.')) {
                continue
            }
            if (entry.isSymbolicLink) {
                continue
            }
            const entryFullPath = joinPath(scopedPath, entry.name)
            const canonicalEntry = await getCanonicalPath(bridge, entryFullPath)
            if (!isPathContained(canonicalRoot, canonicalEntry)) {
                continue
            }
            const entryStat = await metadataOrNull(bridge, entryFullPath)
            if (entryStat?.isSymbolicLink || (entryStat?.mode && (entryStat.mode & 0o170000) === 0o120000)) {
                continue
            }
            const isDir = entryStat ? entryStat.isDir : entry.isDir
            entries.push({
                path: displayRelativePath(root, entryFullPath),
                entryType: isDir ? 'directory' : 'file',
            })
        }
    }

    if (startIndex > entries.length) {
        throw new Error(`cursor '${startIndex}' exceeds result count`)
    }

    const endIndex = Math.min(startIndex + maxResults, entries.length)
    const paginatedEntries = entries.slice(startIndex, endIndex)
    const nextCursor = endIndex < entries.length ? String(endIndex) : undefined
    const truncated = nextCursor !== undefined

    return {
        path: request.path,
        entries: paginatedEntries,
        nextCursor,
        truncated,
    }
}

/**
 * Read memory file content with line offsets, limits, and token truncation.
 */
export async function readMemory(
    request: ReadMemoryRequest,
    options?: LocalMemoriesBackendOptions,
): Promise<ReadMemoryResponse> {
    const lineOffset = request.lineOffset ?? 1
    if (lineOffset <= 0 || !Number.isInteger(lineOffset)) {
        throw new Error('line_offset must be a 1-indexed line number')
    }
    if (request.maxLines !== undefined && (request.maxLines <= 0 || !Number.isInteger(request.maxLines))) {
        throw new Error('max_lines must be a positive integer')
    }

    const { root, bridge } = await resolveBackendContext(options)
    const scopedPath = await resolveScopedPath(root, bridge, request.path)
    const metadata = await metadataOrNull(bridge, scopedPath)
    if (!metadata) {
        throw new Error(`path '${request.path}' was not found`)
    }
    if (metadata.isSymbolicLink || (metadata.mode && (metadata.mode & 0o170000) === 0o120000)) {
        throw new Error(`path '${request.path}' must not be a symlink`)
    }
    if (metadata.isDir) {
        throw new Error(`path '${request.path}' is not a file`)
    }

    const readFileFn = bridge.ReadFile ? bridge.ReadFile.bind(bridge) : (bridge as { readFile?: (p: string) => Promise<{ dataBase64: string }> }).readFile?.bind(bridge)
    if (!readFileFn) {
        throw new Error('ReadFile is unavailable')
    }

    const fileData = await readFileFn(scopedPath)
    const originalContent = base64ToString(fileData.dataBase64)

    const lines = splitLines(originalContent)

    if (lines.length === 0) {
        if (lineOffset > 1) {
            throw new Error('line_offset exceeds file length')
        }
        return {
            path: request.path,
            startLineNumber: 1,
            content: '',
            truncated: false,
        }
    }

    if (lineOffset > lines.length) {
        throw new Error('line_offset exceeds file length')
    }

    const maxTokens =
        typeof request.maxTokens === 'number' && Number.isFinite(request.maxTokens) && request.maxTokens > 0
            ? Math.floor(request.maxTokens)
            : DEFAULT_READ_MAX_TOKENS

    if (lineOffset === 1 && request.maxLines === undefined) {
        const truncation = truncateMiddleWithTokenBudget(originalContent, maxTokens)
        return {
            path: request.path,
            startLineNumber: 1,
            content: truncation.content,
            truncated: truncation.truncated,
        }
    }

    const endIndex = request.maxLines !== undefined ? Math.min(lineOffset - 1 + request.maxLines, lines.length) : lines.length
    const sliceLines = lines.slice(lineOffset - 1, endIndex)
    const lineTruncated = endIndex < lines.length

    let slicedContent = sliceLines.join('\n')
    if (originalContent.endsWith('\n') || originalContent.endsWith('\r\n')) {
        slicedContent += '\n'
    }

    const truncation = truncateMiddleWithTokenBudget(slicedContent, maxTokens)
    const truncated = lineTruncated || truncation.truncated

    return {
        path: request.path,
        startLineNumber: lineOffset,
        content: truncation.content,
        truncated,
    }
}

class SearchComparison {
    constructor(
        public caseSensitive: boolean,
        public normalized: boolean,
    ) {}

    prepare(value: string): string {
        let val = value
        if (!this.caseSensitive) {
            val = val.toLowerCase()
        }
        if (this.normalized) {
            val = val.replace(/[^\p{L}\p{N}]/gu, '')
        }
        return val
    }
}

class SearchMatcher {
    comparison: SearchComparison
    preparedQueries: string[]

    constructor(
        public queries: string[],
        public matchMode: SearchMatchMode,
        caseSensitive: boolean,
        normalized: boolean,
        public lineCount?: number,
    ) {
        this.comparison = new SearchComparison(caseSensitive, normalized)
        this.preparedQueries = queries.map((q) => this.comparison.prepare(q))
        if (this.preparedQueries.some((q) => q.length === 0)) {
            throw new Error('queries must not be empty or contain empty strings')
        }
    }

    matchedQueryFlags(line: string): boolean[] {
        const preparedLine = this.comparison.prepare(line)
        return this.preparedQueries.map((q) => preparedLine.includes(q))
    }

    matchedQueries(flags: boolean[]): string[] {
        return this.queries.filter((_, idx) => flags[idx])
    }
}

function buildSearchMatch(
    root: string,
    filePath: string,
    lines: string[],
    matchStartIndex: number,
    matchEndIndex: number,
    contextLines: number,
    matchedQueries: string[],
): MemorySearchMatch {
    const contentStartIndex = Math.max(0, matchStartIndex - contextLines)
    const contentEndIndex = Math.min(lines.length, matchEndIndex + contextLines + 1)
    return {
        path: displayRelativePath(root, filePath),
        matchLineNumber: matchStartIndex + 1,
        contentStartLineNumber: contentStartIndex + 1,
        content: lines.slice(contentStartIndex, contentEndIndex).join('\n'),
        matchedQueries,
    }
}

async function searchFile(
    root: string,
    filePath: string,
    bridge: ElectronBridgeLike,
    matcher: SearchMatcher,
    contextLines: number,
    matches: MemorySearchMatch[],
): Promise<void> {
    const readFileFn = bridge.ReadFile ? bridge.ReadFile.bind(bridge) : (bridge as { readFile?: (p: string) => Promise<{ dataBase64: string }> }).readFile?.bind(bridge)
    if (!readFileFn) return
    let content = ''
    try {
        const res = await readFileFn(filePath)
        content = base64ToString(res.dataBase64)
    } catch {
        return
    }

    const lines = splitLines(content)
    if (lines.length === 0) {
        return
    }

    const lineMatches = lines.map((line) => matcher.matchedQueryFlags(line))

    if (matcher.matchMode === 'any') {
        for (let idx = 0; idx < lines.length; idx++) {
            const flags = lineMatches[idx]
            if (flags.some(Boolean)) {
                matches.push(
                    buildSearchMatch(
                        root,
                        filePath,
                        lines,
                        idx,
                        idx,
                        contextLines,
                        matcher.matchedQueries(flags),
                    ),
                )
            }
        }
    } else if (matcher.matchMode === 'all_on_same_line') {
        for (let idx = 0; idx < lines.length; idx++) {
            const flags = lineMatches[idx]
            if (flags.every(Boolean)) {
                matches.push(
                    buildSearchMatch(
                        root,
                        filePath,
                        lines,
                        idx,
                        idx,
                        contextLines,
                        matcher.matchedQueries(flags),
                    ),
                )
            }
        }
    } else if (matcher.matchMode === 'all_within_lines') {
        const lineCount = matcher.lineCount ?? 1
        interface WindowMatch {
            startIndex: number
            endIndex: number
            flags: boolean[]
        }
        const windows: WindowMatch[] = []
        for (let startIndex = 0; startIndex < lines.length; startIndex++) {
            if (!lineMatches[startIndex].some(Boolean)) {
                continue
            }
            const lastAllowedIndex = Math.min(startIndex + lineCount - 1, lines.length - 1)
            const accumulatedFlags = new Array(matcher.queries.length).fill(false)
            for (let endIndex = startIndex; endIndex <= lastAllowedIndex; endIndex++) {
                const lineFlags = lineMatches[endIndex]
                for (let q = 0; q < matcher.queries.length; q++) {
                    accumulatedFlags[q] = accumulatedFlags[q] || lineFlags[q]
                }
                if (accumulatedFlags.every(Boolean)) {
                    windows.push({ startIndex, endIndex, flags: [...accumulatedFlags] })
                    break
                }
            }
        }

        for (let i = 0; i < windows.length; i++) {
            const current = windows[i]
            const strictlyContainsAnother = windows.some((other, j) => {
                if (i === j) return false
                return (
                    current.startIndex <= other.startIndex &&
                    current.endIndex >= other.endIndex &&
                    (current.startIndex !== other.startIndex || current.endIndex !== other.endIndex)
                )
            })
            if (strictlyContainsAnother) {
                continue
            }
            matches.push(
                buildSearchMatch(
                    root,
                    filePath,
                    lines,
                    current.startIndex,
                    current.endIndex,
                    contextLines,
                    matcher.matchedQueries(current.flags),
                ),
            )
        }
    }
}

/**
 * Search memory files matching multi-keyword query and match modes.
 */
export async function searchMemories(
    request: SearchMemoriesRequest,
    options?: LocalMemoriesBackendOptions,
): Promise<SearchMemoriesResponse> {
    const rawQueries = request.queries || []
    const queries = rawQueries.map((q) => q.trim())
    if (queries.length === 0 || queries.some((q) => q.length === 0)) {
        throw new Error('queries must not be empty or contain empty strings')
    }

    const matchMode = request.matchMode || 'any'
    if (
        matchMode === 'all_within_lines' &&
        (typeof request.lineCount !== 'number' || !Number.isFinite(request.lineCount) || request.lineCount <= 0)
    ) {
        throw new Error('all_within_lines.line_count must be a positive integer')
    }

    const maxResults = Math.min(
        typeof request.maxResults === 'number' && Number.isFinite(request.maxResults) && request.maxResults > 0
            ? Math.floor(request.maxResults)
            : MAX_SEARCH_RESULTS,
        MAX_SEARCH_RESULTS,
    )

    let startIndex = 0
    if (request.cursor !== undefined && request.cursor !== null && request.cursor !== '') {
        const parsed = Number(request.cursor)
        if (!Number.isInteger(parsed) || parsed < 0) {
            throw new Error(`cursor '${request.cursor}' must be a non-negative integer`)
        }
        startIndex = parsed
    }

    const { root, bridge } = await resolveBackendContext(options)
    const canonicalRoot = await getCanonicalPath(bridge, root)
    const scopedPath = await resolveScopedPath(root, bridge, request.path)
    const metadata = await metadataOrNull(bridge, scopedPath)
    if (!metadata) {
        throw new Error(`path '${request.path ?? ''}' was not found`)
    }
    if (metadata.isSymbolicLink || (metadata.mode && (metadata.mode & 0o170000) === 0o120000)) {
        throw new Error(`path '${displayRelativePath(root, scopedPath)}' must not be a symlink`)
    }

    const matcher = new SearchMatcher(
        queries,
        matchMode,
        request.caseSensitive ?? false,
        request.normalized ?? false,
        request.lineCount,
    )

    const contextLines = Math.max(0, Math.floor(request.contextLines ?? 0))
    const matches: MemorySearchMatch[] = []
    const readDirFn = bridge.ReadDir ? bridge.ReadDir.bind(bridge) : (bridge as { readDir?: (p: string) => Promise<Array<{ name: string; isDir: boolean; isSymbolicLink?: boolean }> | null> }).readDir?.bind(bridge)

    if (!metadata.isDir) {
        await searchFile(root, scopedPath, bridge, matcher, contextLines, matches)
    } else if (readDirFn) {
        const pending: string[] = [scopedPath]
        while (pending.length > 0) {
            const dirPath = pending.shift()!
            const dirEntries = (await readDirFn(dirPath)) || []
            const sortedDirEntries = [...dirEntries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
            for (const entry of sortedDirEntries) {
                if (entry.name.startsWith('.')) continue
                if (entry.isSymbolicLink) continue
                const childPath = joinPath(dirPath, entry.name)
                const canonicalChild = await getCanonicalPath(bridge, childPath)
                if (!isPathContained(canonicalRoot, canonicalChild)) {
                    continue
                }
                const childStat = await metadataOrNull(bridge, childPath)
                if (childStat?.isSymbolicLink || (childStat?.mode && (childStat.mode & 0o170000) === 0o120000)) {
                    continue
                }
                const isDir = childStat ? childStat.isDir : entry.isDir
                if (isDir) {
                    pending.push(childPath)
                } else {
                    await searchFile(root, childPath, bridge, matcher, contextLines, matches)
                }
            }
        }
    }

    matches.sort((left, right) => {
        const pathCmp = left.path < right.path ? -1 : left.path > right.path ? 1 : 0
        if (pathCmp !== 0) return pathCmp
        return left.matchLineNumber - right.matchLineNumber
    })

    if (startIndex > matches.length) {
        throw new Error(`cursor '${startIndex}' exceeds result count`)
    }

    const endIndex = Math.min(startIndex + maxResults, matches.length)
    const paginatedMatches = matches.slice(startIndex, endIndex)
    const nextCursor = endIndex < matches.length ? String(endIndex) : undefined
    const truncated = nextCursor !== undefined

    return {
        queries,
        matchMode,
        path: request.path,
        matches: paginatedMatches,
        nextCursor,
        truncated,
    }
}

/**
 * Add ad-hoc memory note to extensions/ad_hoc/notes.
 */
export async function addAdHocNote(
    request: AddAdHocNoteRequest,
    options?: LocalMemoriesBackendOptions,
): Promise<AddAdHocNoteResponse> {
    validateAdHocFilename(request.filename)
    if (!request.note || request.note.trim().length === 0) {
        throw new Error('ad-hoc note must not be empty')
    }

    const { root, bridge } = await resolveBackendContext(options)
    const canonicalRoot = await getCanonicalPath(bridge, root)
    const notesDir = joinPath(root, 'extensions', 'ad_hoc', 'notes')
    const mkdirFn = bridge.MkdirAll ? bridge.MkdirAll.bind(bridge) : (bridge as { mkdirAll?: (p: string) => Promise<void> }).mkdirAll?.bind(bridge)
    if (mkdirFn) {
        await mkdirFn(notesDir)
    }

    const noteFullPath = joinPath(notesDir, request.filename)
    const canonicalNote = await getCanonicalPath(bridge, noteFullPath)
    if (!isPathContained(canonicalRoot, canonicalNote)) {
        throw new Error(`path '${request.filename}' must stay within the memories root`)
    }

    const existingStat = await metadataOrNull(bridge, noteFullPath)
    if (existingStat) {
        throw new Error(`ad-hoc note '${request.filename}' already exists`)
    }

    const writeFileFn = bridge.WriteFile ? bridge.WriteFile.bind(bridge) : (bridge as { writeFile?: (p: string, d: string) => Promise<void> }).writeFile?.bind(bridge)
    if (!writeFileFn) {
        throw new Error('WriteFile is unavailable')
    }

    await writeFileFn(noteFullPath, stringToBase64(request.note))

    return {
        success: true,
        path: `extensions/ad_hoc/notes/${request.filename}`,
    }
}

/**
 * Delete all local memories under memory root and ensure empty root exists.
 */
export async function deleteLocalMemory(options?: LocalMemoriesBackendOptions): Promise<void> {
    const { root, bridge } = await resolveBackendContext(options)
    const stat = await metadataOrNull(bridge, root)
    const mkdirFn = bridge.MkdirAll ? bridge.MkdirAll.bind(bridge) : (bridge as { mkdirAll?: (p: string) => Promise<void> }).mkdirAll?.bind(bridge)
    if (!stat) {
        if (mkdirFn) {
            await mkdirFn(root)
        }
        return
    }

    const canonicalRoot = await getCanonicalPath(bridge, root)
    const removeFileFn = bridge.RemoveFile ? bridge.RemoveFile.bind(bridge) : (bridge as { removeFile?: (p: string) => Promise<void> }).removeFile?.bind(bridge)
    const readDirFn = bridge.ReadDir ? bridge.ReadDir.bind(bridge) : (bridge as { readDir?: (p: string) => Promise<Array<{ name: string; isDir: boolean; isSymbolicLink?: boolean }> | null> }).readDir?.bind(bridge)

    async function removeFileSafe(filePath: string): Promise<void> {
        if (removeFileFn) {
            await removeFileFn(filePath).catch(() => {})
        }
    }

    async function clearDirectory(dirPath: string): Promise<void> {
        if (!readDirFn) return
        const entries = (await readDirFn(dirPath)) || []
        for (const entry of entries) {
            const entryPath = joinPath(dirPath, entry.name)
            const canonicalEntry = await getCanonicalPath(bridge, entryPath)
            if (!isPathContained(canonicalRoot, canonicalEntry)) {
                // Do not follow or delete symlinks pointing outside root
                continue
            }

            const entryStat = await metadataOrNull(bridge, entryPath)
            const isSymlink =
                entryStat?.isSymbolicLink ||
                (entryStat?.mode && (entryStat.mode & 0o170000) === 0o120000) ||
                entry.isSymbolicLink
            const isDir = entryStat ? entryStat.isDir : entry.isDir

            if (isDir && !isSymlink) {
                await clearDirectory(entryPath)
            } else {
                await removeFileSafe(entryPath)
            }
        }
    }

    await clearDirectory(root)
    if (mkdirFn) {
        await mkdirFn(root).catch(() => {})
    }
}

/**
 * Object-oriented wrapper for LocalMemoriesBackend.
 */
export class LocalMemoriesBackend {
    constructor(private options?: LocalMemoriesBackendOptions) {}

    static fromMemoryRoot(root: string, bridge?: ElectronBridgeLike): LocalMemoriesBackend {
        return new LocalMemoriesBackend({ memoryRoot: root, bridge })
    }

    async listMemories(request: ListMemoriesRequest): Promise<ListMemoriesResponse> {
        return listMemories(request, this.options)
    }

    async readMemory(request: ReadMemoryRequest): Promise<ReadMemoryResponse> {
        return readMemory(request, this.options)
    }

    async searchMemories(request: SearchMemoriesRequest): Promise<SearchMemoriesResponse> {
        return searchMemories(request, this.options)
    }

    async addAdHocNote(request: AddAdHocNoteRequest): Promise<AddAdHocNoteResponse> {
        return addAdHocNote(request, this.options)
    }

    async deleteLocalMemory(): Promise<void> {
        return deleteLocalMemory(this.options)
    }
}
