/**
 * CPA context file discovery: AGENTS* / CLAUDE* chains, SYSTEM, APPEND_SYSTEM.
 * Uses NativeBridge only — no Node fs/path/Buffer, no hard-coded ~/.pi paths.
 */

import type { NativeBridge, NativeDirEntry } from '../agentAdapter.js'
import { dirnamePath, isAbsolutePath, normalizeDirectoryCacheKey, resolveToCwd } from '../path.js'
import { getAppConfigDirName } from '@cpa/plugin-api'

export const CONTEXT_FILE_CANDIDATES = [
    'AGENTS.override.md',
    'AGENTS.md',
    'AGENTS.MD',
    'CLAUDE.md',
    'CLAUDE.MD',
] as const

const PROJECT_CONFIG_DIR = '.cpa'
const SYSTEM_FILE = 'SYSTEM.md'
const APPEND_SYSTEM_FILE = 'APPEND_SYSTEM.md'
const HOME_AGENT_DIR_SEGMENTS = ['.coding-professional-agent'] as const

export interface ContextFile {
    path: string
    content: string
    source?: string
}

export interface ContextDiagnostic {
    type?: 'warning'
    message: string
    path?: string
    source?: string
}

export interface PromptSource {
    path: string
    content: string
}

export interface LoadContextFilesResult {
    files: ContextFile[]
    diagnostics: ContextDiagnostic[]
    system?: PromptSource
    appendSystem?: PromptSource
}

type DirSnapshotResult =
    | { status: 'ok'; entries: Map<string, NativeDirEntry> }
    | { status: 'missing' }
    | { status: 'error'; message: string }

export async function loadContextFiles(
    cwd: string | undefined,
    agentDir: string,
    bridge: NativeBridge,
    homeDir?: string,
): Promise<LoadContextFilesResult> {
    const diagnostics: ContextDiagnostic[] = []

    const agentCheck = validateAbsoluteResourcePath(agentDir, 'agentDir')
    if (agentCheck) {
        return { files: [], diagnostics: [{ type: 'warning', message: agentCheck, path: agentDir }] }
    }

    const resolvedHomeDir = await resolveHomeDir(bridge, homeDir, diagnostics)
    const configDirName = await resolveConfigDirName(bridge)
    const homeAgentDir = resolvedHomeDir
        ? joinPath(resolvedHomeDir, configDirName)
        : undefined

    const globalDirs: string[] = [agentDir]
    if (homeAgentDir && normalizeDirKey(homeAgentDir) !== normalizeDirKey(agentDir)) {
        globalDirs.push(homeAgentDir)
    }

    if (cwd === undefined || cwd === null || cwd === '') {
        return loadGlobalContextOnly(globalDirs, bridge, diagnostics)
    }

    const cwdCheck = validateAbsoluteResourcePath(cwd, 'cwd')
    if (cwdCheck) {
        return { files: [], diagnostics: [{ type: 'warning', message: cwdCheck, path: cwd }] }
    }

    const snapshots = new DirSnapshotCache(bridge)
    const files: ContextFile[] = []
    const seen = new Set<string>()

    for (const gDir of globalDirs) {
        const globalFile = await loadContextFileFromDir(gDir, bridge, diagnostics, snapshots)
        if (globalFile && !seen.has(globalFile.path)) {
            files.push(globalFile)
            seen.add(globalFile.path)
        }
    }

    const leafToRoot: ContextFile[] = []
    let current = cwd
    const visitedDirs = new Set<string>()
    while (!visitedDirs.has(current)) {
        visitedDirs.add(current)
        const file = await loadContextFileFromDir(current, bridge, diagnostics, snapshots)
        if (file && !seen.has(file.path)) {
            leafToRoot.push(file)
            seen.add(file.path)
        }
        const parent = dirnamePath(current)
        if (parent === current) {
            break
        }
        current = parent
    }

    for (let i = leafToRoot.length - 1; i >= 0; i -= 1) {
        files.push(leafToRoot[i]!)
    }

    const projectCpaDir = joinPath(cwd, PROJECT_CONFIG_DIR)
    const system =
        (await loadSpecificFile(projectCpaDir, SYSTEM_FILE, bridge, diagnostics, snapshots)) ??
        (await loadFirstSpecificFile(globalDirs, SYSTEM_FILE, bridge, diagnostics, snapshots))

    const appendSystem =
        (await loadSpecificFile(projectCpaDir, APPEND_SYSTEM_FILE, bridge, diagnostics, snapshots)) ??
        (await loadFirstSpecificFile(globalDirs, APPEND_SYSTEM_FILE, bridge, diagnostics, snapshots))

    return {
        files,
        diagnostics,
        ...(system ? { system } : {}),
        ...(appendSystem ? { appendSystem } : {}),
    }
}

async function loadGlobalContextOnly(
    globalDirs: readonly string[],
    bridge: NativeBridge,
    diagnostics: ContextDiagnostic[],
): Promise<LoadContextFilesResult> {
    const snapshots = new DirSnapshotCache(bridge)
    const files: ContextFile[] = []
    const seen = new Set<string>()

    for (const gDir of globalDirs) {
        const globalFile = await loadContextFileFromDir(gDir, bridge, diagnostics, snapshots)
        if (globalFile && !seen.has(globalFile.path)) {
            files.push(globalFile)
            seen.add(globalFile.path)
        }
    }

    const system = await loadFirstSpecificFile(globalDirs, SYSTEM_FILE, bridge, diagnostics, snapshots)
    const appendSystem = await loadFirstSpecificFile(
        globalDirs,
        APPEND_SYSTEM_FILE,
        bridge,
        diagnostics,
        snapshots,
    )

    return {
        files,
        diagnostics,
        ...(system ? { system } : {}),
        ...(appendSystem ? { appendSystem } : {}),
    }
}

class DirSnapshotCache {
    private readonly cache = new Map<string, Promise<DirSnapshotResult>>()

    constructor(private readonly bridge: NativeBridge) {}

    get(dirPath: string): Promise<DirSnapshotResult> {
        const key = normalizeDirKey(dirPath)
        let promise = this.cache.get(key)
        if (!promise) {
            promise = this.fetch(dirPath)
            this.cache.set(key, promise)
        }
        return promise
    }

    private async fetch(dirPath: string): Promise<DirSnapshotResult> {
        try {
            const rawEntries = await this.bridge.readDir(dirPath)
            const map = new Map<string, NativeDirEntry>()
            for (const entry of rawEntries) {
                if (entry && typeof entry.name === 'string') {
                    map.set(entry.name, entry)
                }
            }
            return { status: 'ok', entries: map }
        } catch (error) {
            if (isNotFoundError(error)) {
                return { status: 'missing' }
            }
            return { status: 'error', message: errorMessage(error) }
        }
    }
}

async function loadContextFileFromDir(
    dirPath: string,
    bridge: NativeBridge,
    diagnostics: ContextDiagnostic[],
    snapshots: DirSnapshotCache,
): Promise<ContextFile | null> {
    const snapshot = await snapshots.get(dirPath)
    if (snapshot.status === 'missing') {
        return null
    }
    if (snapshot.status === 'error') {
        diagnostics.push({
            type: 'warning',
            message: `failed to list directory: ${snapshot.message}`,
            path: dirPath,
        })
        return null
    }

    for (const candidate of CONTEXT_FILE_CANDIDATES) {
        const entry = snapshot.entries.get(candidate)
        if (!entry) {
            continue
        }
        const fullPath = joinPath(dirPath, candidate)
        const kind = await resolveEntryKind(fullPath, entry, bridge, diagnostics)
        if (kind !== 'file') {
            continue
        }
        try {
            const bytes = await bridge.readFile(fullPath)
            const content = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
            return { path: fullPath, content }
        } catch (error) {
            diagnostics.push({
                type: 'warning',
                message: `failed to read context file: ${errorMessage(error)}`,
                path: fullPath,
            })
            return null
        }
    }
    return null
}

async function loadSpecificFile(
    dirPath: string,
    fileName: string,
    bridge: NativeBridge,
    diagnostics: ContextDiagnostic[],
    snapshots: DirSnapshotCache,
): Promise<PromptSource | null> {
    const snapshot = await snapshots.get(dirPath)
    if (snapshot.status !== 'ok') {
        return null
    }
    const entry = snapshot.entries.get(fileName)
    if (!entry) {
        return null
    }
    const fullPath = joinPath(dirPath, fileName)
    const kind = await resolveEntryKind(fullPath, entry, bridge, diagnostics)
    if (kind !== 'file') {
        return null
    }
    try {
        const bytes = await bridge.readFile(fullPath)
        const content = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
        return { path: fullPath, content }
    } catch (error) {
        diagnostics.push({
            type: 'warning',
            message: `failed to read ${fileName}: ${errorMessage(error)}`,
            path: fullPath,
        })
        return null
    }
}

async function loadFirstSpecificFile(
    dirs: readonly string[],
    fileName: string,
    bridge: NativeBridge,
    diagnostics: ContextDiagnostic[],
    snapshots: DirSnapshotCache,
): Promise<PromptSource | null> {
    for (const dir of dirs) {
        const file = await loadSpecificFile(dir, fileName, bridge, diagnostics, snapshots)
        if (file) {
            return file
        }
    }
    return null
}

async function resolveEntryKind(
    fullPath: string,
    entry: NativeDirEntry,
    bridge: NativeBridge,
    diagnostics: ContextDiagnostic[],
): Promise<'file' | 'directory' | null> {
    if (!entry.isSymlink) {
        return entry.isDir ? 'directory' : 'file'
    }
    try {
        const stat = await bridge.stat(fullPath)
        return stat.isDir ? 'directory' : 'file'
    } catch (error) {
        diagnostics.push({
            type: 'warning',
            message: `failed to stat symlink target: ${errorMessage(error)}`,
            path: fullPath,
        })
        return null
    }
}

function joinPath(base: string, ...parts: string[]): string {
    let current = base
    for (const part of parts) {
        current = resolveToCwd(part, current)
    }
    return current
}

function normalizeDirKey(dirPath: string): string {
    try {
        return normalizeDirectoryCacheKey(dirPath)
    } catch {
        return dirPath.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
    }
}

async function resolveConfigDirName(bridge: NativeBridge): Promise<string> {
    if (bridge.runtimeInfo) {
        try {
            const info = await bridge.runtimeInfo()
            if (info?.appConfigDirName) return info.appConfigDirName
            if (typeof info?.isDebug === 'boolean') {
                return getAppConfigDirName(info.isDebug)
            }
        } catch {
            // fallback
        }
    }
    return getAppConfigDirName()
}

async function resolveHomeDir(
    bridge: NativeBridge,
    explicitHomeDir: string | undefined,
    diagnostics: ContextDiagnostic[],
): Promise<string | undefined> {
    if (explicitHomeDir !== undefined && explicitHomeDir !== null && explicitHomeDir !== '') {
        const check = validateAbsoluteResourcePath(explicitHomeDir, 'homeDir')
        if (check) {
            diagnostics.push({ type: 'warning', message: check, path: explicitHomeDir })
            return undefined
        }
        return explicitHomeDir
    }
    if (bridge.runtimeInfo) {
        try {
            const info = await bridge.runtimeInfo()
            return info?.homeDir
        } catch {
            return undefined
        }
    }
    return undefined
}

function validateAbsoluteResourcePath(value: string, label: string): string | null {
    if (typeof value !== 'string' || value.length === 0) {
        return `${label} must be a non-empty absolute path`
    }
    if (hasControlChars(value)) {
        return `${label} is invalid: control characters are not allowed`
    }
    try {
        if (!isAbsolutePath(value)) {
            return `${label} must be an absolute POSIX, Windows drive, or complete UNC path: ${value}`
        }
    } catch (error) {
        return `${label} is invalid: ${errorMessage(error)}`
    }
    return null
}

function hasControlChars(value: string): boolean {
    for (let i = 0; i < value.length; i += 1) {
        const code = value.charCodeAt(i)
        if (code < 0x20 || code === 0x7f) {
            return true
        }
    }
    return false
}

function isNotFoundError(error: unknown): boolean {
    return /not found|ENOENT|no such file|does not exist/i.test(errorMessage(error))
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message
    }
    return String(error)
}
