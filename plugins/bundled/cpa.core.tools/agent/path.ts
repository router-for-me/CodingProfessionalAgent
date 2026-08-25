/**
 * Cross-platform path helpers for browser tool code.
 * Pure string operations — no Node path/fs/Buffer.
 */

// Absolute Windows drive path requires a separator after the drive letter (C:/ or C:\).
const WINDOWS_DRIVE_ABS = /^[A-Za-z]:[\\/]/
// Drive-relative forms C: / C:foo are rejected (no known per-drive cwd).
const WINDOWS_DRIVE_REL = /^[A-Za-z]:(?![\\/])/
const UNC_PREFIX = /^(?:\\\\|\/\/)/
// Unicode space characters normalized like Pi before tool path expansion.
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g
const NARROW_NO_BREAK_SPACE = '\u202F'

/** Options for tool path expansion (~ / leading @ / unicode spaces). */
export interface ExpandPathOptions {
    /** Absolute home directory used for `~` expansion. Required only when the path uses `~`. */
    homeDir?: string
    /** Strip exactly one leading `@` before absolute/relative judgment. Default true. */
    stripAtPrefix?: boolean
    /** Expand `~`, `~/`, and Windows `~\`. Default true. */
    expandTilde?: boolean
    /** Replace Unicode spaces with ASCII space. Default true for tool paths. */
    normalizeUnicodeSpaces?: boolean
}

/** Minimal stat surface used by the macOS read-path fallback resolver. */
export interface PathStatBridge {
    stat(path: string): Promise<{ isDir: boolean }>
}

export function assertNonEmptyPath(value: unknown, label: string): asserts value is string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`${label} must be a non-empty string`)
    }
}

/**
 * True when the path is independently absolute.
 * Accepts:
 * - POSIX single-root absolute (`/`, `/repo`, ...). Leading `//` is UNC, not POSIX.
 * - Windows drive absolute (`C:\...`, `C:/...`) with a separator after the drive letter.
 * - Complete UNC (`\\server\share...`, `//server/share...`) with both server and share.
 * Rejects:
 * - relative paths
 * - drive-relative (`C:`, `C:foo`)
 * - single-backslash root-relative (`\repo`, `\foo`) which need a drive/UNC cwd to resolve
 * - incomplete UNC (`\\server`, `//server`) missing a share segment
 */
export function isAbsolutePath(filePath: string): boolean {
    assertNonEmptyPath(filePath, 'path')
    if (WINDOWS_DRIVE_REL.test(filePath)) {
        return false
    }
    // Complete UNC first: `//` / `\\` prefixes are not POSIX single-root forms.
    if (UNC_PREFIX.test(filePath)) {
        return isCompleteUncPath(filePath)
    }
    // Single backslash root-relative is not independently absolute.
    if (filePath.startsWith('\\')) {
        return false
    }
    // POSIX single-root absolute (including `/`).
    if (filePath.startsWith('/')) {
        return true
    }
    return WINDOWS_DRIVE_ABS.test(filePath)
}

/** UNC is independently absolute only when both server and share segments are present. */
function isCompleteUncPath(value: string): boolean {
    const body = value.replace(/^(?:\\\\|\/\/)/, '')
    const parts = body.split(/[\\/]+/).filter((part) => part.length > 0)
    return parts.length >= 2
}

/**
 * Expand tool path prefixes: optional Unicode-space normalization, one leading `@`,
 * and `~` / `~/` / Windows `~\` home expansion. Does not resolve against cwd.
 */
export function expandPath(input: string, options: ExpandPathOptions = {}): string {
    assertNonEmptyPath(input, 'path')

    const stripAtPrefix = options.stripAtPrefix !== false
    const expandTilde = options.expandTilde !== false
    const normalizeUnicodeSpaces = options.normalizeUnicodeSpaces !== false

    let normalized = input
    if (normalizeUnicodeSpaces) {
        normalized = normalized.replace(UNICODE_SPACES, ' ')
    }
    if (stripAtPrefix && normalized.startsWith('@')) {
        normalized = normalized.slice(1)
    }
    if (!expandTilde) {
        return normalized
    }
    return expandTildePath(normalized, options.homeDir)
}

/**
 * Resolve a tool path: expand `@`/`~` (when enabled) then resolve against cwd.
 * Relative and absolute paths still use cwd only when the expanded form is relative.
 */
export function resolveToolPath(
    filePath: string,
    cwd: string,
    options: ExpandPathOptions = {},
): string {
    const expanded = expandPath(filePath, options)
    return resolveToCwd(expanded, cwd)
}

/** True when the path (after optional one `@` strip) requires homeDir for tilde expansion. */
export function pathNeedsHomeDir(filePath: string): boolean {
    assertNonEmptyPath(filePath, 'path')
    let candidate = filePath
    if (candidate.startsWith('@')) {
        candidate = candidate.slice(1)
    }
    // Unicode spaces do not affect tilde detection at index 0.
    return (
        candidate === '~' ||
        candidate.startsWith('~/') ||
        candidate.startsWith('~\\') ||
        isUnsupportedTildeUser(candidate)
    )
}

/**
 * Resolve a tool path for read, with darwin-only macOS filename fallbacks when the
 * exact path is missing. Permission and other non-missing exact errors are not
 * rewritten by variants. Returns the original resolved path when no variant exists.
 */
export async function resolveReadPath(
    filePath: string,
    cwd: string,
    bridge: PathStatBridge,
    options: ExpandPathOptions & { platform?: string } = {},
): Promise<string> {
    const resolved = resolveToolPath(filePath, cwd, options)

    const exact = await classifyExistingFile(bridge, resolved)
    if (exact === 'file' || exact === 'directory') {
        // Exact hit (file or directory). Do not rewrite permission/non-missing errors via variants.
        return resolved
    }
    // exact === 'missing' — only then try darwin filename variants.
    if ((options.platform ?? '').toLowerCase() !== 'darwin') {
        return resolved
    }

    for (const variant of macOSReadPathVariants(resolved)) {
        if (variant === resolved) {
            continue
        }
        const kind = await classifyExistingFile(bridge, variant)
        if (kind === 'file') {
            return variant
        }
        // Non-missing errors already thrown; missing/directory continue.
    }
    return resolved
}

/**
 * Missing-path classification (aligned with shell/mutationQueue):
 * - When error has a `code` field, only ENOENT/ENOTDIR are missing.
 * - Code-less errors use precise OS predicates (no generic "not found" alone for permission).
 */
export function isMissingPathError(error: unknown): boolean {
    if (typeof error === 'object' && error !== null && 'code' in error) {
        const code = (error as { code?: unknown }).code
        return code === 'ENOENT' || code === 'ENOTDIR'
    }

    const message =
        typeof error === 'object' &&
        error !== null &&
        'message' in error &&
        typeof (error as { message?: unknown }).message === 'string'
            ? (error as { message: string }).message
            : String(error)

    if (/no such file or directory/i.test(message)) {
        return true
    }
    if (/\bnot a directory\b/i.test(message)) {
        return true
    }
    if (/The system cannot find the file specified/i.test(message)) {
        return true
    }
    if (/The system cannot find the path specified/i.test(message)) {
        return true
    }
    // FakeNativeBridge and similar "stat …: not found" helpers.
    if (/^stat .+: not found$/i.test(message)) {
        return true
    }
    if (/\bENOENT\b/i.test(message)) {
        return true
    }
    return false
}

/**
 * Resolve a tool path relative to cwd.
 * Handles POSIX absolute, `.` / `..`, Windows drive absolute, backslashes, and UNC.
 * Relative paths never rewrite an absolute path onto a different drive.
 * Drive-relative forms (C: / C:foo) are rejected with a clear error.
 */
export function resolveToCwd(filePath: string, cwd: string): string {
    assertNonEmptyPath(filePath, 'path')
    assertNonEmptyPath(cwd, 'cwd')

    if (WINDOWS_DRIVE_REL.test(filePath)) {
        throw new Error(
            `drive-relative paths are not supported (no per-drive cwd): ${filePath}`,
        )
    }

    const style = detectPathStyle(filePath, cwd)
    const normalizedInput = normalizeSeparators(filePath, style)
    const normalizedCwd = normalizeSeparators(cwd, style)

    if (isUncPath(normalizedInput)) {
        return canonicalizeSegments(normalizedInput, style, { keepUnc: true })
    }

    if (isWindowsDriveAbsolute(normalizedInput)) {
        return canonicalizeSegments(normalizedInput, style, { keepDrive: true })
    }

    if (style === 'posix' && normalizedInput.startsWith('/')) {
        return canonicalizeSegments(normalizedInput, style, { keepRoot: true })
    }

    // Windows root-relative: \foo or /foo
    if (style === 'windows' && (normalizedInput.startsWith('/') || normalizedInput.startsWith('\\'))) {
        if (isUncPath(normalizedCwd)) {
            const shareRoot = uncShareRoot(normalizedCwd)
            const rest = normalizedInput.replace(/^[\\/]+/, '')
            if (!rest) {
                return shareRoot
            }
            return canonicalizeSegments(`${shareRoot}/${rest}`, style, { keepUnc: true })
        }
        const drive = windowsDriveOf(normalizedCwd)
        if (!drive) {
            throw new Error(`cwd must be a Windows absolute path: ${cwd}`)
        }
        return canonicalizeSegments(`${drive}${normalizedInput}`, style, { keepDrive: true })
    }

    // Relative path: join onto cwd (same drive / root only).
    if (style === 'windows' && !isWindowsDriveAbsolute(normalizedCwd) && !isUncPath(normalizedCwd)) {
        throw new Error(`cwd must be an absolute path: ${cwd}`)
    }
    if (style === 'posix' && !normalizedCwd.startsWith('/')) {
        throw new Error(`cwd must be an absolute path: ${cwd}`)
    }

    const joined = joinRaw(normalizedCwd, normalizedInput, style)
    return canonicalizeSegments(joined, style, {
        keepDrive: style === 'windows' && isWindowsDriveAbsolute(joined),
        keepUnc: isUncPath(joined),
        keepRoot: style === 'posix',
    })
}

/**
 * Canonical directory identity for per-load caches.
 * Collapses `.` / `..` / duplicate separators / trailing slash (root preserved).
 * Windows drive and UNC keys are lowercased (case-insensitive FS identity).
 * POSIX remains case-sensitive. Leading `//` is always UNC, never POSIX root.
 * Only the key is lowercased — callers still pass the first-seen path to I/O.
 */
export function normalizeDirectoryCacheKey(dir: string): string {
    assertNonEmptyPath(dir, 'path')
    // Absolute dirs resolve against themselves; reuses browser path canonicalization.
    const canonical = resolveToCwd(dir, dir)
    if (isUncPath(canonical) || isWindowsDriveAbsolute(canonical)) {
        return canonical.toLowerCase()
    }
    return canonical
}

export function isPathWithinDirectory(
    targetPath: string,
    rootPath: string,
): boolean {
    const targetKey = normalizeDirectoryCacheKey(targetPath)
    const rootKey = normalizeDirectoryCacheKey(rootPath)
    if (targetKey === rootKey) {
        return true
    }
    const childPrefix = rootKey.endsWith('/') ? rootKey : `${rootKey}/`
    return targetKey.startsWith(childPrefix)
}

/** Parent directory of an absolute or relative path. Root/drive roots stay themselves. */
export function dirnamePath(filePath: string): string {
    assertNonEmptyPath(filePath, 'path')
    const style = detectPathStyle(filePath, filePath)
    const normalized = normalizeSeparators(filePath, style)

    if (isUncPath(normalized)) {
        const canonical = canonicalizeSegments(normalized, style, { keepUnc: true })
        const withoutPrefix = canonical.slice(2)
        const parts = withoutPrefix.split('/').filter((part, index) => index < 2 || part.length > 0)
        if (parts.length <= 2) {
            return canonical
        }
        return `//${parts.slice(0, -1).join('/')}`
    }

    if (isWindowsDriveAbsolute(normalized)) {
        const drive = normalized.slice(0, 2)
        const rest = normalized.slice(2)
        const body = rest.replace(/^[\\/]+/, '')
        if (!body) {
            return `${drive}/`
        }
        const segments = body.split(/[\\/]+/).filter(Boolean)
        if (segments.length <= 1) {
            return `${drive}/`
        }
        return `${drive}/${segments.slice(0, -1).join('/')}`
    }

    if (normalized === '/' || normalized === '\\') {
        return '/'
    }

    const collapsed = normalizeSeparators(normalized, style)
    const endsWithSep = /[\\/]$/.test(collapsed)
    const trimmed = endsWithSep ? collapsed.replace(/[\\/]+$/, '') : collapsed
    if (!trimmed || trimmed === '.' || WINDOWS_DRIVE_REL.test(trimmed)) {
        return '.'
    }
    const lastSlash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
    if (lastSlash < 0) {
        return '.'
    }
    if (lastSlash === 0) {
        return '/'
    }
    return trimmed.slice(0, lastSlash)
}

function expandTildePath(normalized: string, homeDir: string | undefined): string {
    if (!normalized.startsWith('~')) {
        return normalized
    }
    if (isUnsupportedTildeUser(normalized)) {
        throw new Error(`unsupported home path (only ~ and ~/ are supported): ${normalized}`)
    }

    const needsHome = normalized === '~' || normalized.startsWith('~/') || normalized.startsWith('~\\')
    if (!needsHome) {
        return normalized
    }
    if (typeof homeDir !== 'string' || homeDir.length === 0) {
        throw new Error('homeDir is required to expand ~ paths')
    }
    if (!isAbsolutePath(homeDir)) {
        throw new Error(`homeDir must be an absolute path: ${homeDir}`)
    }

    // Canonicalize home so trailing slashes / . / .. collapse consistently.
    const home = resolveToCwd(homeDir, homeDir)
    if (normalized === '~') {
        return home
    }
    // `~/rest` or `~\rest`
    const rest = normalized.slice(2)
    if (!rest) {
        return home
    }
    return resolveToCwd(rest, home)
}

function isUnsupportedTildeUser(value: string): boolean {
    if (!value.startsWith('~')) {
        return false
    }
    if (value === '~') {
        return false
    }
    if (value.startsWith('~/') || value.startsWith('~\\')) {
        return false
    }
    return true
}

/**
 * macOS read fallbacks matching Pi path-utils order:
 * 1. regular-space-before-AM/PM → U+202F
 * 2. NFD
 * 3. straight apostrophe → U+2019
 * 4. NFD + curly apostrophe
 */
function macOSReadPathVariants(resolved: string): string[] {
    const amPm = resolved.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`)
    const nfd = resolved.normalize('NFD')
    const curly = resolved.replace(/'/g, '\u2019')
    const nfdCurly = nfd.replace(/'/g, '\u2019')
    return [amPm, nfd, curly, nfdCurly]
}

/**
 * Classify whether path is an existing non-directory file.
 * Rethrows non-missing errors (permission, etc.).
 */
async function classifyExistingFile(
    bridge: PathStatBridge,
    path: string,
): Promise<'file' | 'directory' | 'missing'> {
    try {
        const stat = await bridge.stat(path)
        return stat.isDir ? 'directory' : 'file'
    } catch (error) {
        if (isMissingPathError(error)) {
            return 'missing'
        }
        throw error
    }
}

function detectPathStyle(filePath: string, cwd: string): 'posix' | 'windows' {
    if (
        isWindowsDriveAbsolute(filePath) ||
        isWindowsDriveAbsolute(cwd) ||
        isUncPath(filePath) ||
        isUncPath(cwd) ||
        WINDOWS_DRIVE_REL.test(filePath) ||
        WINDOWS_DRIVE_REL.test(cwd) ||
        filePath.includes('\\') ||
        cwd.includes('\\')
    ) {
        return 'windows'
    }
    return 'posix'
}

function normalizeSeparators(value: string, style: 'posix' | 'windows'): string {
    if (style === 'windows') {
        // Keep UNC prefix as // after normalization.
        if (isUncPath(value)) {
            const rest = value.replace(/^(?:\\\\|\/\/)/, '').replace(/\\/g, '/')
            return `//${rest}`
        }
        return value.replace(/\\/g, '/')
    }
    return value
}

function isWindowsDriveAbsolute(value: string): boolean {
    return WINDOWS_DRIVE_ABS.test(value)
}

function isUncPath(value: string): boolean {
    return UNC_PREFIX.test(value)
}

function windowsDriveOf(value: string): string | undefined {
    const match = /^([A-Za-z]:)/.exec(value)
    return match ? match[1] : undefined
}

/** //server/share root of a UNC path. */
function uncShareRoot(value: string): string {
    const normalized = normalizeSeparators(value, 'windows')
    const body = normalized.replace(/^(?:\\\\|\/\/)/, '')
    const parts = body.split('/').filter((part) => part.length > 0)
    if (parts.length < 2) {
        throw new Error(`Invalid UNC path: ${value}`)
    }
    return `//${parts[0]}/${parts[1]}`
}

function joinRaw(base: string, relative: string, _style: 'posix' | 'windows'): string {
    if (!relative || relative === '.') {
        return base
    }
    if (base.endsWith('/') || base.endsWith('\\')) {
        return `${base}${relative}`
    }
    return `${base}/${relative}`
}

function canonicalizeSegments(
    value: string,
    _style: 'posix' | 'windows',
    flags: { keepDrive?: boolean; keepUnc?: boolean; keepRoot?: boolean },
): string {
    if (flags.keepUnc) {
        const body = value.replace(/^(?:\\\\|\/\/)/, '')
        const rawParts = body.split('/').filter((part) => part.length > 0)
        const parts: string[] = []
        for (const part of rawParts) {
            if (part === '.' || part === '') {
                continue
            }
            if (part === '..') {
                // Do not climb above the share root (//server/share).
                if (parts.length > 2) {
                    parts.pop()
                }
                continue
            }
            parts.push(part)
        }
        if (parts.length < 2) {
            throw new Error(`Invalid UNC path: ${value}`)
        }
        return `//${parts.join('/')}`
    }

    if (flags.keepDrive) {
        const drive = value.slice(0, 2)
        const rest = value.slice(2).replace(/^[\\/]+/, '')
        const parts = collapse(rest.split(/[\\/]+/))
        return parts.length === 0 ? `${drive}/` : `${drive}/${parts.join('/')}`
    }

    // POSIX absolute or relative
    const absolute = value.startsWith('/')
    const parts = collapse(value.split('/'))
    if (absolute || flags.keepRoot) {
        return `/${parts.join('/')}`
    }
    return parts.length === 0 ? '.' : parts.join('/')
}

function collapse(parts: string[]): string[] {
    const out: string[] = []
    for (const part of parts) {
        if (!part || part === '.') {
            continue
        }
        if (part === '..') {
            if (out.length > 0 && out[out.length - 1] !== '..') {
                out.pop()
            } else if (out.length === 0) {
                // Absolute roots already stripped; ignore climb above root.
            }
            continue
        }
        out.push(part)
    }
    return out
}
