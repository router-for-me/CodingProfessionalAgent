/**
 * Path utilities for directory browsing across POSIX and Windows environments.
 */

export function isWindowsPath(p: string): boolean {
  if (!p) return false
  return (
    /^[a-zA-Z]:/.test(p) ||
    (p.includes('\\') && !p.startsWith('/'))
  )
}

export function normalizePath(p: string): string {
  if (!p || p.trim() === '') return '/'
  const trimmed = p.trim()
  const isWin = isWindowsPath(trimmed)

  if (isWin) {
    let normalized = trimmed.replace(/\//g, '\\')
    // Handle drive root e.g. C: -> C:\
    if (/^[a-zA-Z]:$/.test(normalized)) {
      return `${normalized}\\`
    }
    // Remove trailing backslash unless it is drive root e.g. C:\
    if (normalized.length > 3 && normalized.endsWith('\\')) {
      normalized = normalized.slice(0, -1)
    }
    return normalized
  }

  // POSIX path
  let normalized = trimmed.replace(/\\/g, '/').replace(/\/+/g, '/')
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1)
  }
  return normalized || '/'
}

export function getParentPath(p: string): string {
  const norm = normalizePath(p)
  const isWin = isWindowsPath(norm)

  if (isWin) {
    if (/^[a-zA-Z]:\\?$/.test(norm)) {
      return norm.endsWith('\\') ? norm : `${norm}\\`
    }
    const lastSlash = norm.lastIndexOf('\\')
    if (lastSlash === -1) return norm
    if (lastSlash === 2 && norm[1] === ':') {
      return `${norm.slice(0, 2)}\\`
    }
    return norm.slice(0, lastSlash)
  }

  // POSIX
  if (norm === '/') return '/'
  const lastSlash = norm.lastIndexOf('/')
  if (lastSlash <= 0) return '/'
  return norm.slice(0, lastSlash)
}

export function joinPath(parent: string, child: string): string {
  const normParent = normalizePath(parent)
  const isWin = isWindowsPath(normParent)
  const cleanChild = child.replace(/^[/\\]+/, '').replace(/[/\\]+$/, '')

  if (isWin) {
    if (normParent.endsWith('\\')) {
      return `${normParent}${cleanChild}`
    }
    return `${normParent}\\${cleanChild}`
  }

  if (normParent === '/') {
    return `/${cleanChild}`
  }
  return `${normParent}/${cleanChild}`
}

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

export function getBaseName(p: string): string {
  const norm = normalizePath(p)
  const isWin = isWindowsPath(norm)
  if (isWin) {
    if (/^[a-zA-Z]:\\?$/.test(norm)) {
      return norm
    }
    const parts = norm.split('\\').filter(Boolean)
    return parts[parts.length - 1] || norm
  }

  if (norm === '/') return '/'
  const parts = norm.split('/').filter(Boolean)
  return parts[parts.length - 1] || norm
}
