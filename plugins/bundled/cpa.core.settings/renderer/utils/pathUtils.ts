/**
 * Normalizes slashes in a filesystem path to forward slashes.
 */
export function normalizePath(filePath: string): string {
    if (!filePath) return ''
    return filePath.replace(/\\/g, '/')
}

/**
 * Checks if a given path is a Windows-style path with a drive letter.
 */
export function isWindowsPath(filePath: string): boolean {
    return /^[a-zA-Z]:/.test(filePath)
}

/**
 * Gets the base name (final segment) of a path.
 */
export function getBaseName(filePath: string): string {
    const normalized = normalizePath(filePath).replace(/\/+$/, '')
    if (!normalized) return ''
    const idx = normalized.lastIndexOf('/')
    return idx === -1 ? normalized : normalized.slice(idx + 1)
}

/**
 * Gets the parent directory of a path.
 */
export function getParentPath(filePath: string): string {
    const normalized = normalizePath(filePath).replace(/\/+$/, '')
    if (!normalized) return ''
    const idx = normalized.lastIndexOf('/')
    if (idx === -1) return ''
    if (idx === 0) return '/'
    return normalized.slice(0, idx)
}

/**
 * Joins path segments using forward slashes.
 */
export function joinPath(...segments: string[]): string {
    const cleaned = segments
        .filter(Boolean)
        .map((s) => normalizePath(s).replace(/^\/+|\/+$/g, ''))
        .filter(Boolean)
    const isAbs = segments[0] && normalizePath(segments[0]).startsWith('/')
    const joined = cleaned.join('/')
    return isAbs ? `/${joined}` : joined
}

/**
 * Splits a path into individual directory segments with their resolved full paths.
 */
export function getPathSegments(p: string): Array<{ name: string; path: string }> {
    const norm = normalizePath(p)
    const isWin = isWindowsPath(norm)

    if (isWin) {
        const driveMatch = norm.match(/^([a-zA-Z]:(?:\\|\/)?)/)
        const rawDrive = driveMatch ? driveMatch[1] : 'C:\\'
        const drive = rawDrive.endsWith('\\') ? rawDrive : `${rawDrive.replace(/\//g, '\\')}\\`
        const rest = norm.slice(rawDrive.length).split('\\').filter(Boolean)
        const segments: Array<{ name: string; path: string }> = [
            { name: drive, path: drive },
        ]
        let current = drive
        for (const part of rest) {
            current = joinPath(current, part)
            segments.push({ name: part, path: current })
        }
        return segments
    }

    // POSIX
    const parts = norm.split('/').filter(Boolean)
    const segments: Array<{ name: string; path: string }> = [
        { name: '/', path: '/' },
    ]
    let current = ''
    for (const part of parts) {
        current = `${current}/${part}`
        segments.push({ name: part, path: current })
    }
    return segments
}
