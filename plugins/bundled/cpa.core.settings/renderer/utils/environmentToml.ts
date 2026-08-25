import { joinPath, normalizePath } from './pathUtils.js'
import type {
    ActionPlatform,
    ProjectEnvironmentAction,
    ProjectEnvironmentScripts,
} from '@cpa/plugin-api'

export type EnvironmentPlatform = 'default' | 'macos' | 'linux' | 'windows'
export type { ActionPlatform }

export interface ProjectEnvironmentConfig {
    version?: number
    name?: string
    setupScripts?: ProjectEnvironmentScripts
    cleanupScripts?: ProjectEnvironmentScripts
    actions?: ProjectEnvironmentAction[]
}

/** Convert an action platform string from TOML or UI to 'darwin' | 'linux' | 'win32' | undefined. */
export function normalizeActionPlatform(key?: unknown): ActionPlatform | undefined {
    if (typeof key !== 'string') return undefined
    const lower = key.toLowerCase().trim()
    if (lower === 'darwin' || lower === 'macos' || lower === 'mac') return 'darwin'
    if (lower === 'linux') return 'linux'
    if (lower === 'win32' || lower === 'windows' || lower === 'win') return 'win32'
    return undefined
}

/** Convert a platform string from TOML or UI to a normalized platform key. */
export function normalizePlatformKey(key: string): EnvironmentPlatform {
    const lower = key.toLowerCase().trim()
    if (lower === 'darwin' || lower === 'macos' || lower === 'mac') return 'macos'
    if (lower === 'linux') return 'linux'
    if (lower === 'win32' || lower === 'windows' || lower === 'win') return 'windows'
    return 'default'
}

/** Convert a normalized platform key to standard TOML table name (darwin, linux, win32). */
export function toTomlPlatformKey(platform: EnvironmentPlatform): string {
    if (platform === 'macos') return 'darwin'
    if (platform === 'windows') return 'win32'
    if (platform === 'linux') return 'linux'
    return 'default'
}

/** Unescape a basic TOML string. */
function unescapeTomlString(str: string): string {
    return str
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\')
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
}

/** Escape a basic string for TOML output with quotes. */
function escapeTomlString(str: string): string {
    const escaped = str
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t')
    return `"${escaped}"`
}

/** Parse a raw TOML string into a ProjectEnvironmentConfig structure. */
export function parseEnvironmentToml(content: string): ProjectEnvironmentConfig {
    const config: ProjectEnvironmentConfig = {
        version: 1,
        setupScripts: {},
        cleanupScripts: {},
        actions: [],
    }

    const lines = content.split(/\r?\n/)
    let currentTable = ''
    let isTableArray = false
    let currentAction: Partial<ProjectEnvironmentAction> | null = null

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i]?.trim() ?? ''
        if (!line || line.startsWith('#')) {
            continue
        }

        // Check for table array header [[actions]]
        const tableArrayMatch = line.match(/^\[\[\s*([a-zA-Z0-9_.-]+)\s*\]\]$/)
        if (tableArrayMatch) {
            if (currentAction && currentAction.name) {
                const normPlatform = normalizeActionPlatform(currentAction.platform)
                config.actions?.push({
                    id: currentAction.id || Date.now().toString() + Math.random().toString(36).slice(2, 6),
                    name: currentAction.name,
                    script: currentAction.script || (currentAction as { command?: string }).command || '',
                    ...(normPlatform ? { platform: normPlatform } : {}),
                    ...(currentAction.icon ? { icon: currentAction.icon } : {}),
                })
            }
            currentTable = tableArrayMatch[1] ?? ''
            isTableArray = true
            currentAction = {
                id: Date.now().toString() + Math.random().toString(36).slice(2, 6),
            }
            continue
        }

        // Check for table header [setup], [setup.darwin], [cleanup], etc.
        const tableMatch = line.match(/^\[\s*([a-zA-Z0-9_.-]+)\s*\]$/)
        if (tableMatch) {
            if (currentAction && currentAction.name) {
                const normPlatform = normalizeActionPlatform(currentAction.platform)
                config.actions?.push({
                    id: currentAction.id || Date.now().toString() + Math.random().toString(36).slice(2, 6),
                    name: currentAction.name,
                    script: currentAction.script || (currentAction as { command?: string }).command || '',
                    ...(normPlatform ? { platform: normPlatform } : {}),
                    ...(currentAction.icon ? { icon: currentAction.icon } : {}),
                })
                currentAction = null
            }
            currentTable = tableMatch[1] ?? ''
            isTableArray = false
            continue
        }

        // Check for key-value pair key = "value" or key = value
        const kvMatch = line.match(/^([a-zA-Z0-9_.-]+)\s*=\s*(.*)$/)
        if (!kvMatch) continue

        const key = kvMatch[1]?.trim() ?? ''
        let rawVal = kvMatch[2]?.trim() ?? ''

        // Parse value
        let parsedValue: string | number | boolean = rawVal
        if (rawVal.startsWith('"""')) {
            // Multiline string support
            let collected = rawVal.slice(3)
            if (collected.endsWith('"""') && collected.length >= 3) {
                parsedValue = collected.slice(0, -3)
            } else {
                while (i + 1 < lines.length) {
                    i++
                    const nextLine = lines[i] ?? ''
                    if (nextLine.includes('"""')) {
                        const endIdx = nextLine.indexOf('"""')
                        collected += '\n' + nextLine.slice(0, endIdx)
                        break
                    } else {
                        collected += '\n' + nextLine
                    }
                }
                parsedValue = collected
            }
        } else if (rawVal.startsWith('"') && rawVal.endsWith('"') && rawVal.length >= 2) {
            parsedValue = unescapeTomlString(rawVal.slice(1, -1))
        } else if (rawVal.startsWith("'") && rawVal.endsWith("'") && rawVal.length >= 2) {
            parsedValue = rawVal.slice(1, -1)
        } else if (/^\d+$/.test(rawVal)) {
            parsedValue = parseInt(rawVal, 10)
        } else if (rawVal === 'true') {
            parsedValue = true
        } else if (rawVal === 'false') {
            parsedValue = false
        }

        // Handle value according to current table context
        if (isTableArray && currentTable === 'actions' && currentAction) {
            if (key === 'name') currentAction.name = String(parsedValue)
            else if (key === 'script') currentAction.script = String(parsedValue)
            else if (key === 'command') currentAction.script = String(parsedValue)
            else if (key === 'icon') currentAction.icon = String(parsedValue)
            else if (key === 'platform' || key === 'os') {
                currentAction.platform = normalizeActionPlatform(String(parsedValue))
            }
        } else if (!currentTable) {
            if (key === 'version') config.version = Number(parsedValue)
            else if (key === 'name') config.name = String(parsedValue)
        } else if (currentTable.startsWith('setup')) {
            if (key === 'script') {
                const parts = currentTable.split('.')
                const plat = parts[1] ? normalizePlatformKey(parts[1]) : 'default'
                if (!config.setupScripts) config.setupScripts = {}
                config.setupScripts[plat] = String(parsedValue)
            }
        } else if (currentTable.startsWith('cleanup')) {
            if (key === 'script') {
                const parts = currentTable.split('.')
                const plat = parts[1] ? normalizePlatformKey(parts[1]) : 'default'
                if (!config.cleanupScripts) config.cleanupScripts = {}
                config.cleanupScripts[plat] = String(parsedValue)
            }
        }
    }

    if (currentAction && currentAction.name) {
        const normPlatform = normalizeActionPlatform(currentAction.platform)
        config.actions?.push({
            id: currentAction.id || Date.now().toString() + Math.random().toString(36).slice(2, 6),
            name: currentAction.name,
            script: currentAction.script || (currentAction as { command?: string }).command || '',
            ...(normPlatform ? { platform: normPlatform } : {}),
            ...(currentAction.icon ? { icon: currentAction.icon } : {}),
        })
    }

    return config
}

/** Serialize a ProjectEnvironmentConfig back into standard TOML format. */
export function serializeEnvironmentToml(config: ProjectEnvironmentConfig): string {
    const lines: string[] = [
        '# THIS IS AUTOGENERATED. DO NOT EDIT MANUALLY',
        `version = ${config.version ?? 1}`,
    ]

    if (config.name) {
        lines.push(`name = ${escapeTomlString(config.name)}`)
    }

    // Setup scripts
    const setup = config.setupScripts || {}
    if (setup.default !== undefined) {
        lines.push('')
        lines.push('[setup]')
        lines.push(`script = ${escapeTomlString(setup.default)}`)
    }

    const platformOrder: EnvironmentPlatform[] = ['macos', 'linux', 'windows']
    for (const plat of platformOrder) {
        const val = setup[plat]
        if (val !== undefined && val.trim().length > 0) {
            lines.push('')
            lines.push(`[setup.${toTomlPlatformKey(plat)}]`)
            lines.push(`script = ${escapeTomlString(val)}`)
        }
    }

    // Cleanup scripts
    const cleanup = config.cleanupScripts || {}
    if (cleanup.default !== undefined) {
        lines.push('')
        lines.push('[cleanup]')
        lines.push(`script = ${escapeTomlString(cleanup.default)}`)
    }

    for (const plat of platformOrder) {
        const val = cleanup[plat]
        if (val !== undefined && val.trim().length > 0) {
            lines.push('')
            lines.push(`[cleanup.${toTomlPlatformKey(plat)}]`)
            lines.push(`script = ${escapeTomlString(val)}`)
        }
    }

    // Actions
    if (config.actions && config.actions.length > 0) {
        for (const action of config.actions) {
            lines.push('')
            lines.push('[[actions]]')
            lines.push(`name = ${escapeTomlString(action.name)}`)
            if (action.icon) {
                lines.push(`icon = ${escapeTomlString(action.icon)}`)
            }
            lines.push(`command = ${escapeTomlString(action.script || action.command || '')}`)
            const normPlatform = normalizeActionPlatform(action.platform)
            if (normPlatform) {
                lines.push(`platform = ${escapeTomlString(normPlatform)}`)
            }
        }
    }

    return lines.join('\n') + '\n'
}

/** Decode base64 string to utf-8 text. */
function decodeBase64(base64: string): string {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i)
    }
    return new TextDecoder('utf-8').decode(bytes)
}

/** Encode utf-8 text to base64 string. */
function encodeBase64(text: string): string {
    const bytes = new TextEncoder().encode(text)
    let binary = ''
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]!)
    }
    return btoa(binary)
}

export interface ReadFileBridge {
    ReadFile: (path: string) => Promise<{ dataBase64: string }>
    ReadFileIfExists?: (path: string) => Promise<{ dataBase64: string } | null>
    FileExists?: (path: string) => Promise<boolean>
    GetProjectEnvironment?: (projectPath: string) => Promise<{ filePath: string; content: string } | null>
}

export interface WriteFileBridge extends ReadFileBridge {
    WriteFile: (path: string, dataBase64: string) => Promise<void>
    MkdirAll?: (path: string) => Promise<void>
    InvalidateEnvironmentCache?: (projectPath?: string) => Promise<void>
}

/** In-memory cache for resolved project environments. */
const projectEnvCache = new Map<string, { config: ProjectEnvironmentConfig; filePath: string } | null>()

/**
 * Invalidate cached project environment in memory.
 */
export function invalidateProjectEnvironmentCache(projectPath?: string): void {
    if (projectPath) {
        projectEnvCache.delete(normalizePath(projectPath))
    } else {
        projectEnvCache.clear()
    }
}

/**
 * Attempt to read and parse environment.toml for a given project root path.
 */
export async function readProjectEnvironment(
    projectPath: string,
    bridge?: ReadFileBridge,
    forceRefresh = false
): Promise<{ config: ProjectEnvironmentConfig; filePath: string } | null> {
    if (!projectPath || typeof projectPath !== 'string') return null

    const normalizedRoot = normalizePath(projectPath)

    if (!forceRefresh && !bridge && projectEnvCache.has(normalizedRoot)) {
        return projectEnvCache.get(normalizedRoot) ?? null
    }

    const resolvedBridge: ReadFileBridge | undefined = bridge
    if (!resolvedBridge) return null

    if (resolvedBridge.GetProjectEnvironment) {
        try {
            const envResult = await resolvedBridge.GetProjectEnvironment(normalizedRoot)
            if (envResult && typeof envResult.content === 'string') {
                const config = parseEnvironmentToml(envResult.content)
                const result = { config, filePath: envResult.filePath }
                if (!bridge) projectEnvCache.set(normalizedRoot, result)
                return result
            }
            if (!bridge) projectEnvCache.set(normalizedRoot, null)
            return null
        } catch {
            // Fall back to candidate probing
        }
    }

    if (!resolvedBridge.ReadFile && !resolvedBridge.ReadFileIfExists) return null

    const candidatePaths = [
        joinPath(joinPath(normalizedRoot, '.cpa'), 'environments/environment.toml'),
        joinPath(joinPath(normalizedRoot, '.codex'), 'environments/environment.toml'),
        joinPath(normalizedRoot, 'environment.toml'),
    ]

    for (const candidate of candidatePaths) {
        try {
            if (resolvedBridge.ReadFileIfExists) {
                const res = await resolvedBridge.ReadFileIfExists(candidate)
                if (res && typeof res.dataBase64 === 'string') {
                    const text = decodeBase64(res.dataBase64)
                    const config = parseEnvironmentToml(text)
                    const result = { config, filePath: candidate }
                    if (!bridge) projectEnvCache.set(normalizedRoot, result)
                    return result
                }
            } else if (resolvedBridge.ReadFile) {
                const res = await resolvedBridge.ReadFile(candidate)
                if (res && typeof res.dataBase64 === 'string') {
                    const text = decodeBase64(res.dataBase64)
                    const config = parseEnvironmentToml(text)
                    const result = { config, filePath: candidate }
                    if (!bridge) projectEnvCache.set(normalizedRoot, result)
                    return result
                }
            }
        } catch {
            // File does not exist or cannot be read
        }
    }

    if (!bridge) projectEnvCache.set(normalizedRoot, null)
    return null
}

/**
 * Save project environment configuration to TOML file.
 */
export async function saveProjectEnvironment(
    projectPath: string,
    config: ProjectEnvironmentConfig,
    preferredPath?: string,
    bridge?: WriteFileBridge
): Promise<string | null> {
    if (!projectPath || typeof projectPath !== 'string') return null

    const resolvedBridge: WriteFileBridge | undefined = bridge
    if (!resolvedBridge?.WriteFile) return null

    const normalizedRoot = normalizePath(projectPath)
    const targetFilePath =
        preferredPath ||
        joinPath(joinPath(normalizedRoot, '.cpa'), 'environments/environment.toml')
    const targetDir = targetFilePath.replace(/[/\\][^/\\]+$/, '')

    try {
        if (resolvedBridge.MkdirAll) {
            await resolvedBridge.MkdirAll(targetDir)
        }
        const tomlContent = serializeEnvironmentToml(config)
        await resolvedBridge.WriteFile(targetFilePath, encodeBase64(tomlContent))
        projectEnvCache.set(normalizedRoot, { config, filePath: targetFilePath })
        if (resolvedBridge.InvalidateEnvironmentCache) {
            void resolvedBridge.InvalidateEnvironmentCache(normalizedRoot).catch(() => {})
        }
        return targetFilePath
    } catch {
        return null
    }
}
