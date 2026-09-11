/**
 * CPA skills discovery, progressive disclosure, and explicit /skill: or $name expansion.
 * Browser-safe: NativeBridge only — no Node fs/path/Buffer.
 */

import ignore from 'ignore'
import type { NativeBridge, NativeDirEntry } from '../agentAdapter.js'
import { dirnamePath, isAbsolutePath, normalizeDirectoryCacheKey, resolveToCwd } from '../path.js'
import { FrontmatterError, parseFrontmatter } from '../frontmatter.js'
import { getAppConfigDirName } from '@cpa/plugin-api'

const MAX_NAME_LENGTH = 64
const MAX_DESCRIPTION_LENGTH = 1024

const IGNORE_FILE_NAMES = ['.gitignore', '.ignore', '.fdignore'] as const
const PROJECT_CONFIG_DIR = '.cpa'
const SKILL_FILE = 'SKILL.md'
const HOME_SKILL_DIR_SEGMENTS = ['.coding-professional-agent', 'skills'] as const

export interface Skill {
    name: string
    description: string
    filePath: string
    baseDir: string
    disableModelInvocation: boolean
    body: string
}

export interface SkillCollision {
    resourceType: 'skill'
    name: string
    winnerPath: string
    loserPath: string
}

export interface SkillDiagnostic {
    type: 'warning' | 'collision'
    message: string
    path?: string
    collision?: SkillCollision
}

export interface LoadSkillsResult {
    skills: Skill[]
    diagnostics: SkillDiagnostic[]
}

export interface LoadSkillsOptions {
    cwd?: string
    agentDir: string
    homeDir?: string
    bridge: NativeBridge
}

export async function loadSkills(options: LoadSkillsOptions): Promise<LoadSkillsResult> {
    const diagnostics: SkillDiagnostic[] = []
    const skillMap = new Map<string, Skill>()
    const realPathSet = new Set<string>()
    const visitedDirs = new Set<string>()

    const agentCheck = validateAbsoluteResourcePath(options.agentDir, 'agentDir')
    if (agentCheck) {
        diagnostics.push({ type: 'warning', message: agentCheck, path: options.agentDir })
        return { skills: [], diagnostics }
    }

    const bridge = options.bridge

    const scanRoot = async (dir: string): Promise<void> => {
        const rootCheck = validateAbsoluteResourcePath(dir, 'skill directory')
        if (rootCheck) {
            diagnostics.push({ type: 'warning', message: rootCheck, path: dir })
            return
        }
        await walkSkillsDir({
            dir,
            rootDir: dir,
            includeRootFiles: true,
            bridge,
            parentPatterns: [],
            visitedDirs,
            realPathSet,
            skillMap,
            diagnostics,
        })
    }

    await scanRoot(joinPath(options.agentDir, 'skills'))

    const homeDir = await resolveHomeDir(options)
    if (homeDir !== undefined && homeDir !== null && homeDir !== '') {
        const homeCheck = validateAbsoluteResourcePath(homeDir, 'homeDir')
        if (homeCheck) {
            diagnostics.push({ type: 'warning', message: homeCheck, path: homeDir })
        } else {
            const configDirName = await resolveConfigDirName(options.bridge)
            await scanRoot(joinPath(homeDir, configDirName, 'skills'))
        }
    }

    if (options.cwd !== undefined && options.cwd !== null && options.cwd !== '') {
        const cwdCheck = validateAbsoluteResourcePath(options.cwd, 'cwd')
        if (cwdCheck) {
            diagnostics.push({ type: 'warning', message: cwdCheck, path: options.cwd })
        } else {
            await scanRoot(joinPath(options.cwd, PROJECT_CONFIG_DIR, 'skills'))
        }
    }

    const skills = Array.from(skillMap.values()).sort((a, b) => compareCodePoints(a.name, b.name))
    return { skills, diagnostics }
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

async function resolveHomeDir(options: LoadSkillsOptions): Promise<string | undefined> {
    if (options.homeDir !== undefined) {
        return options.homeDir
    }
    if (options.bridge.runtimeInfo) {
        try {
            const info = await options.bridge.runtimeInfo()
            return info?.homeDir
        } catch {
            return undefined
        }
    }
    return undefined
}

export function formatSkillsForPrompt(
    skills: readonly Skill[],
    hasReadTool: boolean,
): string {
    if (!hasReadTool) {
        return ''
    }

    const visible = skills.filter((skill) => !skill.disableModelInvocation)
    if (visible.length === 0) {
        return ''
    }

    const lines = [
        '\n\nThe following skills provide specialized instructions for specific tasks.',
        "Use the read tool to load a skill's file when the task matches its description.",
        "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
        '',
        '<available_skills>',
    ]

    for (const skill of visible) {
        lines.push('  <skill>')
        lines.push(`    <name>${escapeXml(skill.name)}</name>`)
        lines.push(`    <description>${escapeXml(skill.description)}</description>`)
        lines.push(`    <location>${escapeXml(skill.filePath)}</location>`)
        lines.push('  </skill>')
    }

    lines.push('</available_skills>')
    return lines.join('\n')
}

export function expandSkillCommand(text: string, skills: readonly Skill[]): string {
    if (typeof text !== 'string') {
        return text
    }

    const parsed = parseSkillCommand(text)
    if (!parsed) {
        return text
    }
    if (argsContainKnownSkill(parsed.args, skills)) {
        return text
    }

    const skill = skills.find((entry) => entry.name === parsed.skillName)
    if (!skill) {
        return text
    }

    const body = skill.body
    const trimmedArgs = parsed.args.trim()
    if (trimmedArgs.length === 0) {
        return body
    }
    return `${body}\n\nUser: ${trimmedArgs}`
}

export function expandUserSkillEntries(
    entries: readonly any[],
    skills: readonly Skill[],
): any[] {
    if (skills.length === 0) return entries as any[]
    let changed = false
    const next = entries.map((entry) => {
        const expanded = expandUserSkillEntry(entry, skills)
        if (expanded !== entry) changed = true
        return expanded
    })
    return changed ? next : (entries as any[])
}

export function expandUserSkillEntry(
    entry: any,
    skills: readonly Skill[],
): any {
    if (!entry || entry.kind !== 'user') return entry
    return expandUserEntrySkills(entry, skills)
}

export function expandUserEntrySkills(
    entry: any,
    skills: readonly Skill[],
): any {
    if (skills.length === 0) return entry
    let changed = false

    const newContent = entry.content.map((block: any) => {
        if (!block || block.type !== 'text') return block
        const expanded = expandSkillCommand(block.text, skills)
        if (expanded !== block.text) {
            changed = true
            return { ...block, text: expanded }
        }
        return block
    })

    if (!changed) return entry
    return { ...entry, content: newContent }
}

export function parseSkillCommand(text: string): { skillName: string; args: string } | null {
    const slashMatch = text.match(/^\/skill:([a-z0-9-]+)(?:\s+([\s\S]*))?$/)
    if (slashMatch) {
        return {
            skillName: slashMatch[1]!,
            args: slashMatch[2] ?? '',
        }
    }

    const dollarMatch = text.match(/^\$([a-z0-9-]+)(?:\s+([\s\S]*))?$/)
    if (dollarMatch) {
        return {
            skillName: dollarMatch[1]!,
            args: dollarMatch[2] ?? '',
        }
    }

    return null
}

function argsContainKnownSkill(args: string, skills: readonly Skill[]): boolean {
    const trimmed = args.trim()
    if (!trimmed) return false
    const parsed = parseSkillCommand(trimmed)
    if (!parsed) return false
    return skills.some((entry) => entry.name === parsed.skillName)
}

async function walkSkillsDir(input: {
    dir: string
    rootDir: string
    includeRootFiles: boolean
    bridge: NativeBridge
    parentPatterns: readonly string[]
    visitedDirs: Set<string>
    realPathSet: Set<string>
    skillMap: Map<string, Skill>
    diagnostics: SkillDiagnostic[]
}): Promise<void> {
    const {
        dir,
        rootDir,
        includeRootFiles,
        bridge,
        parentPatterns,
        visitedDirs,
        realPathSet,
        skillMap,
        diagnostics,
    } = input

    let realDir = dir
    if (bridge.realPath) {
        try {
            realDir = await bridge.realPath(dir)
        } catch {
            realDir = dir
        }
    }

    const realDirKey = normalizeRealPathKey(realDir)
    if (visitedDirs.has(realDirKey)) {
        return
    }
    visitedDirs.add(realDirKey)

    let entries: readonly NativeDirEntry[]
    try {
        entries = await bridge.readDir(dir)
    } catch (error) {
        if (!isNotFoundError(error)) {
            diagnostics.push({
                type: 'warning',
                message: `failed to read skill directory: ${errorMessage(error)}`,
                path: dir,
            })
        }
        return
    }

    const localPatterns = await loadLocalIgnorePatterns(
        dir,
        rootDir,
        entries,
        bridge,
        diagnostics,
    )
    const patterns = parentPatterns.concat(localPatterns)
    const createIgnore = (typeof (ignore as any) === 'function' ? (ignore as any) : (ignore as any).default) as () => any
    const ig = createIgnore()
    if (patterns.length > 0) {
        ig.add(patterns)
    }

    const sorted = [...entries]
        .filter((entry) => entry && typeof entry.name === 'string' && entry.name.length > 0)
        .sort((a, b) => compareCodePoints(a.name, b.name))

    for (const entry of sorted) {
        if (entry.name !== SKILL_FILE) {
            continue
        }
        const fullPath = joinPath(dir, entry.name)
        const resolved = await resolveEntryKind(fullPath, bridge, diagnostics)
        if (!resolved || resolved.kind !== 'file') {
            continue
        }
        const relPath = toPosixRelative(rootDir, fullPath)
        if (relPath && ig.ignores(relPath)) {
            continue
        }
        await considerSkillFile({
            filePath: fullPath,
            bridge,
            realPathSet,
            skillMap,
            diagnostics,
        })
        return
    }

    for (const entry of sorted) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') {
            continue
        }

        const fullPath = joinPath(dir, entry.name)
        const resolved = await resolveEntryKind(fullPath, bridge, diagnostics)
        if (!resolved) {
            continue
        }

        const relPath = toPosixRelative(rootDir, fullPath)
        const ignorePath = resolved.kind === 'directory' ? `${relPath}/` : relPath
        if (relPath && ig.ignores(ignorePath)) {
            continue
        }

        if (resolved.kind === 'directory') {
            await walkSkillsDir({
                dir: fullPath,
                rootDir,
                includeRootFiles: false,
                bridge,
                parentPatterns: patterns,
                visitedDirs,
                realPathSet,
                skillMap,
                diagnostics,
            })
            continue
        }

        if (!includeRootFiles || !entry.name.endsWith('.md')) {
            continue
        }

        await considerSkillFile({
            filePath: fullPath,
            bridge,
            realPathSet,
            skillMap,
            diagnostics,
        })
    }
}

async function considerSkillFile(input: {
    filePath: string
    bridge: NativeBridge
    realPathSet: Set<string>
    skillMap: Map<string, Skill>
    diagnostics: SkillDiagnostic[]
}): Promise<void> {
    const { filePath, bridge, realPathSet, skillMap, diagnostics } = input

    let realPath = filePath
    if (bridge.realPath) {
        try {
            realPath = await bridge.realPath(filePath)
        } catch (error) {
            diagnostics.push({
                type: 'warning',
                message: `skill realPath failed, using logical path: ${errorMessage(error)}`,
                path: filePath,
            })
            realPath = filePath
        }
    }

    const realKey = normalizeRealPathKey(realPath)
    if (realPathSet.has(realKey)) {
        return
    }
    realPathSet.add(realKey)

    let bytes: Uint8Array
    try {
        bytes = await bridge.readFile(filePath)
    } catch (error) {
        diagnostics.push({
            type: 'warning',
            message: `failed to read skill file: ${errorMessage(error)}`,
            path: filePath,
        })
        return
    }

    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    const skill = parseSkillContent(text, filePath, diagnostics)
    if (!skill) {
        return
    }

    const existing = skillMap.get(skill.name)
    if (existing) {
        diagnostics.push({
            type: 'collision',
            message: `skill name collision "${skill.name}": winner "${existing.filePath}", loser "${filePath}"`,
            path: filePath,
            collision: {
                resourceType: 'skill',
                name: skill.name,
                winnerPath: existing.filePath,
                loserPath: filePath,
            },
        })
        return
    }

    skillMap.set(skill.name, skill)
}

function parseSkillContent(
    text: string,
    filePath: string,
    diagnostics: SkillDiagnostic[],
): Skill | null {
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
                  : 'failed to parse skill file'
        diagnostics.push({ type: 'warning', message, path: filePath })
        return null
    }

    const skillDir = dirnamePath(filePath)

    const descriptionValue = frontmatter.description
    if (typeof descriptionValue !== 'string' || descriptionValue.trim() === '') {
        diagnostics.push({
            type: 'warning',
            message: 'description is required',
            path: filePath,
        })
        return null
    }

    if (descriptionValue.length > MAX_DESCRIPTION_LENGTH) {
        diagnostics.push({
            type: 'warning',
            message: `description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${descriptionValue.length})`,
            path: filePath,
        })
    }

    const nameValue = frontmatter.name
    const name =
        typeof nameValue === 'string' && nameValue.length > 0
            ? nameValue
            : defaultSkillName(filePath)

    for (const error of validateName(name)) {
        diagnostics.push({ type: 'warning', message: error, path: filePath })
    }

    return {
        name,
        description: descriptionValue,
        filePath,
        baseDir: skillDir,
        disableModelInvocation: frontmatter['disable-model-invocation'] === true,
        body,
    }
}

function defaultSkillName(filePath: string): string {
    const file = baseName(filePath)
    if (file === SKILL_FILE) {
        return baseName(dirnamePath(filePath))
    }
    return file.replace(/\.md$/i, '')
}

function validateName(name: string): string[] {
    const errors: string[] = []
    if (name.length > MAX_NAME_LENGTH) {
        errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`)
    }
    if (!/^[a-z0-9-]+$/.test(name)) {
        errors.push(
            'name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)',
        )
    }
    if (name.startsWith('-') || name.endsWith('-')) {
        errors.push('name must not start or end with a hyphen')
    }
    if (name.includes('--')) {
        errors.push('name must not contain consecutive hyphens')
    }
    return errors
}

async function loadLocalIgnorePatterns(
    dir: string,
    rootDir: string,
    entries: readonly NativeDirEntry[],
    bridge: NativeBridge,
    diagnostics: SkillDiagnostic[],
): Promise<string[]> {
    const relativeDir = toPosixRelative(rootDir, dir)
    const prefix = relativeDir ? `${relativeDir}/` : ''
    const patterns: string[] = []

    for (const filename of IGNORE_FILE_NAMES) {
        const entry = entries.find((candidate) => candidate.name === filename)
        if (!entry || entry.isDir) {
            continue
        }
        const ignorePath = joinPath(dir, filename)
        let bytes: Uint8Array
        try {
            bytes = await bridge.readFile(ignorePath)
        } catch (error) {
            if (isNotFoundError(error)) {
                continue
            }
            diagnostics.push({
                type: 'warning',
                message: `failed to read ignore file: ${errorMessage(error)}`,
                path: ignorePath,
            })
            continue
        }
        const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
        for (const line of text.split(/\r?\n/)) {
            const pattern = rootIgnorePattern(line, prefix)
            if (pattern) {
                patterns.push(pattern)
            }
        }
    }

    return patterns
}

function rootIgnorePattern(rawLine: string, prefix: string): string | null {
    const trimmed = rawLine.trim()
    if (!trimmed || trimmed.startsWith('#')) {
        return null
    }

    let body = trimmed
    const negated = body.startsWith('!')
    if (negated) {
        body = body.slice(1).trim()
    }
    if (!body || body.startsWith('#')) {
        return null
    }

    let anchored = false
    if (body.startsWith('/') && !body.startsWith('//')) {
        anchored = true
        body = body.slice(1)
    }

    const core = body.endsWith('/') && body.length > 1 ? body.slice(0, -1) : body
    const coreForSlashCheck = core.startsWith('\\') ? core.slice(1) : core
    const hasSlash = coreForSlashCheck.includes('/')

    let rooted: string
    if (!prefix) {
        if (anchored) {
            rooted = `/${body}`
        } else {
            rooted = body
        }
    } else if (anchored || hasSlash) {
        rooted = `${prefix}${body}`
    } else {
        rooted = `${prefix}**/${body}`
    }

    return negated ? `!${rooted}` : rooted
}

async function resolveEntryKind(
    fullPath: string,
    bridge: NativeBridge,
    diagnostics: SkillDiagnostic[],
): Promise<{ kind: 'file' | 'directory' } | null> {
    try {
        const stat = await bridge.stat(fullPath)
        return { kind: stat.isDir ? 'directory' : 'file' }
    } catch (error) {
        if (!isNotFoundError(error)) {
            diagnostics.push({
                type: 'warning',
                message: `failed to stat entry: ${errorMessage(error)}`,
                path: fullPath,
            })
        }
        return null
    }
}

function escapeXml(value: string): string {
    let result = ''
    for (const char of String(value ?? '')) {
        const code = char.charCodeAt(0)
        if (char === '&') {
            result += '&amp;'
        } else if (char === '<') {
            result += '&lt;'
        } else if (char === '>') {
            result += '&gt;'
        } else if (char === '"') {
            result += '&quot;'
        } else if (char === "'") {
            result += '&apos;'
        } else if (char === '\n') {
            result += '&#10;'
        } else if (char === '\r') {
            result += '&#13;'
        } else if (char === '\t') {
            result += '&#9;'
        } else if (code < 0x20 || code === 0x7f) {
            continue
        } else {
            result += char
        }
    }
    return result
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

function toPosixRelative(root: string, fullPath: string): string {
    const rootNorm = root.replace(/\\/g, '/').replace(/\/+$/, '')
    const fullNorm = fullPath.replace(/\\/g, '/')
    if (fullNorm === rootNorm) {
        return ''
    }
    const prefix = `${rootNorm}/`
    if (fullNorm.startsWith(prefix)) {
        return fullNorm.slice(prefix.length)
    }
    return baseName(fullNorm)
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
