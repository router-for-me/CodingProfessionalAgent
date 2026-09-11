/**
 * CPA prompt templates: non-recursive discovery, arg parsing, substitution, expansion.
 * Browser-safe: NativeBridge only — no Node fs/path/Buffer.
 */

import type { NativeBridge, NativeDirEntry } from '../agentAdapter.js'
import { isAbsolutePath, normalizeDirectoryCacheKey, resolveToCwd } from '../path.js'
import { FrontmatterError, parseFrontmatter } from '../frontmatter.js'
import { getAppConfigDirName } from '@cpa/plugin-api'

const PROJECT_CONFIG_DIR = '.cpa'
const DESCRIPTION_TRUNCATE = 60
const HOME_PROMPT_DIR_SEGMENTS = ['.coding-professional-agent', 'prompts'] as const

export interface PromptTemplate {
    name: string
    description: string
    argumentHint?: string
    content: string
    filePath: string
}

export interface PromptCollision {
    resourceType: 'prompt'
    name: string
    winnerPath: string
    loserPath: string
}

export interface PromptDiagnostic {
    type: 'warning' | 'collision'
    message: string
    path?: string
    collision?: PromptCollision
}

export interface LoadPromptTemplatesResult {
    prompts: PromptTemplate[]
    diagnostics: PromptDiagnostic[]
}

export interface LoadPromptTemplatesOptions {
    cwd?: string
    agentDir: string
    homeDir?: string
    bridge: NativeBridge
}

export function parseCommandArgs(argsString: string): string[] {
    const input = typeof argsString === 'string' ? argsString : ''
    const args: string[] = []
    let current = ''
    let inQuote: '"' | "'" | null = null
    let sawQuoted = false

    for (let i = 0; i < input.length; i += 1) {
        const char = input[i]!

        if (inQuote) {
            if (char === '\\') {
                const next = input[i + 1]
                if (next === undefined) {
                    current += '\\'
                    continue
                }
                current += next
                i += 1
                continue
            }
            if (char === inQuote) {
                inQuote = null
                sawQuoted = true
                continue
            }
            current += char
            continue
        }

        if (char === '\\') {
            const next = input[i + 1]
            if (next === undefined) {
                current += '\\'
                continue
            }
            current += next
            i += 1
            continue
        }

        if (char === '"' || char === "'") {
            inQuote = char
            sawQuoted = true
            continue
        }

        if (/\s/.test(char)) {
            if (current.length > 0 || sawQuoted) {
                args.push(current)
                current = ''
                sawQuoted = false
            }
            continue
        }

        current += char
    }

    if (inQuote) {
        throw new Error(`unclosed ${inQuote === '"' ? 'double' : 'single'} quote in command arguments`)
    }

    if (current.length > 0 || sawQuoted) {
        args.push(current)
    }

    return args
}

export function substituteArgs(content: string, args: string[]): string {
    const allArgs = args.join(' ')
    const source = typeof content === 'string' ? content : ''

    return source.replace(
        /\$\{(\d+):-([^}]*)\}|\$\{(ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
        (
            _match,
            defaultNum: string | undefined,
            defaultValue: string | undefined,
            allDefaultKind: string | undefined,
            allDefaultValue: string | undefined,
            sliceStart: string | undefined,
            sliceLength: string | undefined,
            simple: string | undefined,
        ) => {
            if (defaultNum !== undefined) {
                const index = parseInt(defaultNum, 10) - 1
                if (!Number.isFinite(index) || index < 0) {
                    return defaultValue ?? ''
                }
                const value = args[index]
                return value ? value : (defaultValue ?? '')
            }

            if (allDefaultKind !== undefined) {
                if (args.length === 0 || allArgs === '') {
                    return allDefaultValue ?? ''
                }
                const hasNonEmpty = args.some((arg) => arg.length > 0)
                if (!hasNonEmpty) {
                    return allDefaultValue ?? ''
                }
                return allArgs
            }

            if (sliceStart !== undefined) {
                let start = parseInt(sliceStart, 10) - 1
                if (!Number.isFinite(start)) {
                    return ''
                }
                if (start < 0) {
                    start = 0
                }
                if (start >= args.length) {
                    return ''
                }
                if (sliceLength !== undefined) {
                    const length = parseInt(sliceLength, 10)
                    if (!Number.isFinite(length) || length <= 0) {
                        return ''
                    }
                    return args.slice(start, start + length).join(' ')
                }
                return args.slice(start).join(' ')
            }

            if (simple === 'ARGUMENTS' || simple === '@') {
                return allArgs
            }

            if (simple !== undefined) {
                const index = parseInt(simple, 10) - 1
                if (!Number.isFinite(index) || index < 0) {
                    return ''
                }
                return args[index] ?? ''
            }

            return ''
        },
    )
}

export function expandPromptTemplate(text: string, templates: readonly PromptTemplate[]): string {
    if (typeof text !== 'string' || !text.startsWith('/')) {
        return text
    }

    if (text.startsWith('/skill:')) {
        return text
    }

    const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/)
    if (!match) {
        return text
    }

    const templateName = match[1]!
    const argsString = match[2] ?? ''
    const template = templates.find((entry) => entry.name === templateName)
    if (!template) {
        return text
    }

    const args = parseCommandArgs(argsString)
    return substituteArgs(template.content, args)
}

export async function loadPromptTemplates(
    options: LoadPromptTemplatesOptions,
): Promise<LoadPromptTemplatesResult> {
    const diagnostics: PromptDiagnostic[] = []
    const promptMap = new Map<string, PromptTemplate>()
    const realPathSet = new Set<string>()

    const agentCheck = validateAbsoluteResourcePath(options.agentDir, 'agentDir')
    if (agentCheck) {
        diagnostics.push({ type: 'warning', message: agentCheck, path: options.agentDir })
        return { prompts: [], diagnostics }
    }

    await collectFromDir(
        joinPath(options.agentDir, 'prompts'),
        options.bridge,
        promptMap,
        realPathSet,
        diagnostics,
    )

    const resolvedHomeDir = await resolveHomeDir(options.bridge, options.homeDir, diagnostics)
    if (resolvedHomeDir) {
        const configDirName = await resolveConfigDirName(options.bridge)
        const homePromptsDir = joinPath(resolvedHomeDir, configDirName, 'prompts')
        const agentPromptsDir = joinPath(options.agentDir, 'prompts')
        if (normalizeDirKey(homePromptsDir) !== normalizeDirKey(agentPromptsDir)) {
            await collectFromDir(
                homePromptsDir,
                options.bridge,
                promptMap,
                realPathSet,
                diagnostics,
            )
        }
    }

    const cwd = options.cwd
    if (cwd !== undefined && cwd !== null && cwd !== '') {
        const cwdCheck = validateAbsoluteResourcePath(cwd, 'cwd')
        if (cwdCheck) {
            diagnostics.push({ type: 'warning', message: cwdCheck, path: cwd })
        } else {
            await collectFromDir(
                joinPath(cwd, PROJECT_CONFIG_DIR, 'prompts'),
                options.bridge,
                promptMap,
                realPathSet,
                diagnostics,
            )
        }
    }

    const prompts = Array.from(promptMap.values()).sort((a, b) => compareCodePoints(a.name, b.name))
    return { prompts, diagnostics }
}

async function collectFromDir(
    dir: string,
    bridge: NativeBridge,
    promptMap: Map<string, PromptTemplate>,
    realPathSet: Set<string>,
    diagnostics: PromptDiagnostic[],
): Promise<void> {
    let entries: readonly NativeDirEntry[]
    try {
        entries = await bridge.readDir(dir)
    } catch (error) {
        if (isNotFoundError(error)) {
            return
        }
        diagnostics.push({
            type: 'warning',
            message: `readDir ${dir}: ${errorMessage(error)}`,
            path: dir,
        })
        return
    }

    const sorted = [...entries]
        .filter((entry) => entry && typeof entry.name === 'string' && entry.name.length > 0)
        .sort((a, b) => compareCodePoints(a.name, b.name))

    for (const entry of sorted) {
        if (!entry.name.endsWith('.md') || entry.name.startsWith('.')) {
            continue
        }

        const fullPath = joinPath(dir, entry.name)

        let isFile = false
        try {
            const st = await bridge.stat(fullPath)
            isFile = !st.isDir
        } catch (error) {
            diagnostics.push({
                type: 'warning',
                message: `broken or inaccessible prompt path: ${errorMessage(error)}`,
                path: fullPath,
            })
            continue
        }

        if (!isFile) {
            continue
        }

        let realPath: string
        try {
            realPath = bridge.realPath ? await bridge.realPath(fullPath) : fullPath
        } catch (error) {
            diagnostics.push({
                type: 'warning',
                message: `prompt realPath failed, using logical path: ${errorMessage(error)}`,
                path: fullPath,
            })
            realPath = fullPath
        }

        const realKey = normalizeRealPathKey(realPath)
        if (realPathSet.has(realKey)) {
            continue
        }
        realPathSet.add(realKey)

        let bytes: Uint8Array
        try {
            bytes = await bridge.readFile(fullPath)
        } catch (error) {
            diagnostics.push({
                type: 'warning',
                message: `failed to read prompt file: ${errorMessage(error)}`,
                path: fullPath,
            })
            continue
        }

        const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
        const template = parsePromptTemplate(text, fullPath, diagnostics)
        if (!template) {
            continue
        }

        const existing = promptMap.get(template.name)
        if (existing) {
            diagnostics.push({
                type: 'collision',
                message: `prompt name collision "${template.name}": winner "${existing.filePath}", loser "${fullPath}"`,
                path: fullPath,
                collision: {
                    resourceType: 'prompt',
                    name: template.name,
                    winnerPath: existing.filePath,
                    loserPath: fullPath,
                },
            })
            continue
        }

        promptMap.set(template.name, template)
    }
}

function parsePromptTemplate(
    text: string,
    filePath: string,
    diagnostics: PromptDiagnostic[],
): PromptTemplate | null {
    let frontmatter: Record<string, unknown>
    let body: string
    try {
        const parsed = parseFrontmatter(text)
        frontmatter = parsed.frontmatter
        body = parsed.body
    } catch (error) {
        const message =
            error instanceof FrontmatterError
                ? error.message
                : error instanceof Error
                  ? error.message
                  : 'failed to parse prompt template'
        diagnostics.push({ type: 'warning', message, path: filePath })
        return null
    }

    const defaultName = baseName(filePath).replace(/\.md$/i, '')
    const nameValue = frontmatter.name
    const name = typeof nameValue === 'string' && nameValue.trim().length > 0 ? nameValue.trim() : defaultName

    let description: string
    const descValue = frontmatter.description
    if (typeof descValue === 'string' && descValue.trim().length > 0) {
        description = descValue.trim()
    } else {
        const firstLine = body.split(/\r?\n/).find((line) => line.trim().length > 0) ?? ''
        const trimmedFirst = firstLine.trim()
        if (trimmedFirst.length > DESCRIPTION_TRUNCATE) {
            description = `${trimmedFirst.slice(0, DESCRIPTION_TRUNCATE)}...`
        } else {
            description = trimmedFirst
        }
    }

    const argumentHintValue = frontmatter['argument-hint']
    const argumentHint =
        typeof argumentHintValue === 'string' && argumentHintValue.trim().length > 0
            ? argumentHintValue.trim()
            : undefined

    return {
        name,
        description,
        ...(argumentHint ? { argumentHint } : {}),
        content: body,
        filePath,
    }
}

function joinPath(base: string, ...parts: string[]): string {
    let current = base
    for (const part of parts) {
        current = resolveToCwd(part, current)
    }
    return current
}

function baseName(filePath: string): string {
    const normalized = filePath.replace(/\\/g, '/').replace(/\/+$/, '')
    const idx = normalized.lastIndexOf('/')
    return idx === -1 ? normalized : normalized.slice(idx + 1)
}

function normalizeDirKey(dirPath: string): string {
    try {
        return normalizeDirectoryCacheKey(dirPath)
    } catch {
        return dirPath.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
    }
}

function normalizeRealPathKey(value: string): string {
    try {
        return normalizeDirectoryCacheKey(value)
    } catch {
        return value.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
    }
}

function compareCodePoints(a: string, b: string): number {
    if (a < b) return -1
    if (a > b) return 1
    return 0
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
    diagnostics: PromptDiagnostic[],
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
