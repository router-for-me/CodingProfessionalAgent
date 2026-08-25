/**
 * Neutral path utilities for browser and node runtimes.
 * Does not depend on Node 'node:path'.
 */

export function normalizePath(rawPath: string): string {
    if (typeof rawPath !== 'string' || !rawPath) {
        return ''
    }

    let p = rawPath.replace(/\\/g, '/')
    let drivePrefix = ''
    let isUnc = false

    if (/^[a-zA-Z]:(?:\/|$)/.test(p)) {
        drivePrefix = `${p.slice(0, 2)}/`
        p = p.slice(2).replace(/^\/+/, '')
    } else if (p.startsWith('//')) {
        isUnc = true
        p = p.slice(2).replace(/^\/+/, '')
    }

    const isUnixAbsolute = !drivePrefix && !isUnc && p.startsWith('/')
    const segments = p.split('/')
    const resolvedSegments: string[] = []

    for (const segment of segments) {
        if (!segment || segment === '.') {
            continue
        }
        if (segment === '..') {
            if (resolvedSegments.length > 0 && resolvedSegments[resolvedSegments.length - 1] !== '..') {
                resolvedSegments.pop()
            } else if (!drivePrefix && !isUnixAbsolute && !isUnc) {
                resolvedSegments.push('..')
            }
        } else {
            resolvedSegments.push(segment)
        }
    }

    const body = resolvedSegments.join('/')
    if (drivePrefix) {
        return body ? `${drivePrefix}${body}` : drivePrefix
    }
    if (isUnc) {
        return `//${body}`
    }
    if (isUnixAbsolute) {
        return `/${body}`
    }
    return body || '.'
}

export function isAbsolutePath(filePath: string): boolean {
    if (typeof filePath !== 'string' || !filePath) {
        return false
    }
    if (filePath.startsWith('\\') && !filePath.startsWith('\\\\')) {
        return false
    }
    const p = filePath.replace(/\\/g, '/')
    return p.startsWith('/') || /^[a-zA-Z]:(?:\/|$)/.test(p)
}

export function resolveToCwd(filePath: string, cwd?: string): string {
    if (isAbsolutePath(filePath)) {
        return normalizePath(filePath)
    }
    if (!cwd) {
        return normalizePath(filePath)
    }
    const cleanCwd = normalizePath(cwd)
    const cleanFile = normalizePath(filePath)
    if (cleanFile === '.' || cleanFile === '') {
        return cleanCwd
    }
    if (cleanCwd.endsWith('/')) {
        return normalizePath(`${cleanCwd}${cleanFile}`)
    }
    return normalizePath(`${cleanCwd}/${cleanFile}`)
}

export function isPathWithinDirectory(targetPath: string, parentDirectory: string): boolean {
    const normTarget = normalizePath(targetPath)
    const normParent = normalizePath(parentDirectory)

    if (normTarget === normParent) {
        return true
    }
    const parentWithSlash = normParent.endsWith('/') ? normParent : `${normParent}/`
    return normTarget.startsWith(parentWithSlash)
}

export function dirnamePath(filePath: string): string {
    const normalized = normalizePath(filePath)
    const idx = normalized.lastIndexOf('/')
    if (idx <= 0) {
        return normalized.startsWith('/') ? '/' : '.'
    }
    return normalized.slice(0, idx)
}

export function basenamePath(filePath: string): string {
    const normalized = normalizePath(filePath)
    const idx = normalized.lastIndexOf('/')
    if (idx < 0) {
        return normalized
    }
    return normalized.slice(idx + 1)
}

export function relativePath(from: string, to: string): string {
    const normFrom = normalizePath(from)
    const normTo = normalizePath(to)
    if (normFrom === normTo) return ''

    const fromParts = normFrom.split('/').filter(Boolean)
    const toParts = normTo.split('/').filter(Boolean)

    let common = 0
    while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) {
        common += 1
    }

    const upCount = fromParts.length - common
    const remaining = toParts.slice(common)

    const parts = Array(upCount).fill('..').concat(remaining)
    return parts.join('/')
}

export function splitPathSegments(filePath: string): string[] {
    const norm = normalizePath(filePath)
    return norm.split('/').filter(Boolean)
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

export function assertPromptCwd(cwd: string): string {
    if (typeof cwd !== 'string' || !cwd) {
        throw new Error('cwd must be a non-empty absolute path')
    }
    if (hasControlChars(cwd)) {
        throw new Error('cwd is invalid: control characters are not allowed')
    }
    if (cwd.startsWith('\\') && !cwd.startsWith('\\\\')) {
        throw new Error(`Root-relative Windows paths are not supported as cwd: ${cwd}`)
    }
    const p = cwd.replace(/\\/g, '/')
    if (p.startsWith('//')) {
        const segments = p.slice(2).split('/').filter(Boolean)
        if (segments.length < 2) {
            throw new Error(`Incomplete UNC path: ${cwd}`)
        }
    }
    if (!isAbsolutePath(cwd)) {
        throw new Error(`cwd must be an absolute POSIX, Windows drive, or UNC path: ${cwd}`)
    }
    return normalizePath(cwd)
}

export function normalizeDirectoryCacheKey(dir: string): string {
    return normalizePath(dir).toLowerCase()
}

export function isMissingPathError(error: unknown): boolean {
    if (!error) return false
    const message = error instanceof Error ? error.message : String(error)
    return /not found|ENOENT|no such file|does not exist/i.test(message)
}
