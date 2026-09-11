/**
 * Worktree discovery and directory scanning utilities.
 */

import {
  runGitViaNativeBridge,
  type GitCommandRunner,
} from './gitBranches'
import { getHostBridge } from '@/application/services/hostTransport'
import { getAppConfigDirName } from '@cpa/plugin-api'

export interface DiscoveredWorktree {
  name: string
  path: string
  branch?: string
  headSha?: string
  mainRepo?: string
  mainRepoPath?: string
  gitDir?: string
  isGitWorktree?: boolean
}

export interface WorktreeFsBridge {
  readDir: (dirPath: string) => Promise<Array<{ name: string; isDir: boolean }> | null>
  readFile?: (filePath: string) => Promise<string | null>
  stat?: (targetPath: string) => Promise<{ isDir: boolean; mode?: number; size?: number } | null>
  removeDir?: (dirPath: string) => Promise<void>
  removeFile?: (filePath: string) => Promise<void>
}

/**
 * Resolve the user-configured or default root directory for worktrees.
 */
export async function resolveWorktreeRootDir(
  configuredRootDir?: string,
  runtimeHomeDir?: string,
): Promise<string> {
  const trimmed = configuredRootDir?.trim()
  let homeDir = runtimeHomeDir

  let configDirName = getAppConfigDirName()
  if (!homeDir) {
    try {
      const bridge = getHostBridge()
      if (bridge?.RuntimeInfo) {
        const info = await bridge.RuntimeInfo()
        if (info?.homeDir) {
          homeDir = info.homeDir
        }
        if ((info as any)?.appConfigDirName) {
          configDirName = (info as any).appConfigDirName
        } else if (typeof (info as any)?.isDebug === 'boolean') {
          configDirName = getAppConfigDirName((info as any).isDebug)
        }
      }
    } catch {
      // Fallback
    }
  }

  if (trimmed) {
    if (trimmed.startsWith('~') && homeDir) {
      return trimmed.replace(/^~(?=$|\/|\\)/, homeDir)
    }
    return trimmed
  }

  if (homeDir) {
    return `${homeDir}/${configDirName}/worktrees`
  }
  return `~/${configDirName}/worktrees`
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/')
}

function resolveRelativePath(relative: string, base: string): string {
  const normBase = normalizePath(base)
  const normRel = normalizePath(relative)
  if (normRel.startsWith('/')) return normRel
  if (/^[a-zA-Z]:\//.test(normRel)) return normRel

  const baseParts = normBase.split('/').filter(Boolean)
  const relParts = normRel.split('/').filter(Boolean)

  for (const part of relParts) {
    if (part === '.') continue
    if (part === '..') {
      baseParts.pop()
    } else {
      baseParts.push(part)
    }
  }

  const prefix = normBase.startsWith('/') ? '/' : ''
  return prefix + baseParts.join('/')
}

/**
 * Scan all subdirectories in the configured worktree root directory.
 */
export async function listWorktreesUnderDir(
  rootDir: string,
  bridge?: WorktreeFsBridge,
): Promise<DiscoveredWorktree[]> {
  if (!rootDir || !rootDir.trim()) return []

  const resolvedDir = await resolveWorktreeRootDir(rootDir)

  const defaultReadDir = async (dirPath: string) => {
    const bridge = getHostBridge()
    if (bridge?.ReadDir) {
      try {
        return await bridge.ReadDir(dirPath)
      } catch {
        return null
      }
    }
    return null
  }

  const defaultReadFile = async (filePath: string) => {
    const bridge = getHostBridge()
    if (bridge?.ReadFile) {
      try {
        const file = await bridge.ReadFile(filePath)
        if (file?.dataBase64) {
          const binary = atob(file.dataBase64)
          const bytes = new Uint8Array(binary.length)
          for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i)
          }
          return new TextDecoder('utf-8').decode(bytes)
        }
      } catch {
        return null
      }
    }
    return null
  }

  const readDir = bridge?.readDir ?? defaultReadDir
  const readFile = bridge?.readFile ?? defaultReadFile

  let entries: Array<{ name: string; isDir: boolean }> | null = null
  try {
    entries = await readDir(resolvedDir)
  } catch {
    return []
  }

  if (!entries || !Array.isArray(entries) || entries.length === 0) {
    return []
  }

  const dirEntries = entries.filter((e) => e.isDir && !e.name.startsWith('.'))
  const worktrees: DiscoveredWorktree[] = []

  for (const entry of dirEntries) {
    const itemPath =
      resolvedDir.endsWith('/') || resolvedDir.endsWith('\\')
        ? `${resolvedDir}${entry.name}`
        : `${resolvedDir}/${entry.name}`

    let branch: string | undefined = undefined
    let headSha: string | undefined = undefined
    let mainRepo: string | undefined = undefined
    let mainRepoPath: string | undefined = undefined
    let gitDir: string | undefined = undefined
    let isGitWorktree = false

    // Try reading .git file or directory in the worktree
    try {
      const gitFilePath = `${itemPath}/.git`
      const gitContent = await readFile(gitFilePath)
      if (gitContent) {
        // .git is a pointer file with "gitdir: <path>"
        isGitWorktree = true
        const match = gitContent.match(/gitdir:\s*(.+)/i)
        if (match && match[1]) {
          let resolvedGitDir = match[1].trim()
          if (!resolvedGitDir.startsWith('/') && !/^[a-zA-Z]:[/\\]/.test(resolvedGitDir)) {
            resolvedGitDir = resolveRelativePath(resolvedGitDir, itemPath)
          }
          gitDir = resolvedGitDir

          // Read HEAD inside gitDir
          const headContent = await readFile(`${gitDir}/HEAD`)
          if (headContent) {
            const headTrimmed = headContent.trim()
            if (headTrimmed.startsWith('ref: refs/heads/')) {
              branch = headTrimmed.replace('ref: refs/heads/', '')
            } else if (/^[0-9a-f]{7,64}$/i.test(headTrimmed)) {
              headSha = headTrimmed.slice(0, 7)
            }
          }

          // Try reading commondir inside gitDir
          try {
            const commonDirContent = await readFile(`${gitDir}/commondir`)
            if (commonDirContent && commonDirContent.trim()) {
              const resolvedCommonDir = resolveRelativePath(commonDirContent.trim(), gitDir)
              mainRepoPath = resolveRelativePath('..', resolvedCommonDir)
            }
          } catch {
            // Ignore
          }

          if (!mainRepoPath) {
            const norm = normalizePath(gitDir)
            const wtIdx = norm.lastIndexOf('/.git/worktrees')
            if (wtIdx !== -1) {
              mainRepoPath = norm.slice(0, wtIdx)
            }
          }

          if (mainRepoPath) {
            const parts = mainRepoPath.split(/[/\\]/).filter(Boolean)
            mainRepo = parts[parts.length - 1]
          } else {
            // Extract main repo name from gitDir path
            const parts = gitDir.split(/[/\\]/).filter(Boolean)
            const wtIdx = parts.lastIndexOf('worktrees')
            if (wtIdx > 1) {
              mainRepo = parts[wtIdx - 2]
            }
          }
        }
      } else {
        // Check if there is .git/HEAD directly
        const headContent = await readFile(`${itemPath}/.git/HEAD`)
        if (headContent) {
          isGitWorktree = true
          mainRepoPath = itemPath
          mainRepo = entry.name
          const headTrimmed = headContent.trim()
          if (headTrimmed.startsWith('ref: refs/heads/')) {
            branch = headTrimmed.replace('ref: refs/heads/', '')
          } else if (/^[0-9a-f]{7,64}$/i.test(headTrimmed)) {
            headSha = headTrimmed.slice(0, 7)
          }
        }
      }
    } catch {
      // Ignore git parse errors, still list as a directory
    }

    worktrees.push({
      name: entry.name,
      path: itemPath,
      branch,
      headSha,
      mainRepo,
      mainRepoPath,
      gitDir,
      isGitWorktree,
    })
  }

  return worktrees.sort((a, b) => a.name.localeCompare(b.name))
}

export interface DeleteWorktreeOptions {
  fsBridge?: WorktreeFsBridge
  gitRunner?: GitCommandRunner
}

export interface DeleteWorktreeResult {
  ok: boolean
  error?: string
}

/**
 * Remove a worktree directory and unlink it from the original Git repository.
 */
export async function deleteWorktree(
  target: DiscoveredWorktree | string,
  options?: DeleteWorktreeOptions,
): Promise<DeleteWorktreeResult> {
  const targetPath = typeof target === 'string' ? target : target.path
  if (!targetPath || !targetPath.trim()) {
    return { ok: false, error: 'Target worktree path is required' }
  }

  const defaultReadFile = async (filePath: string) => {
    const bridge = getHostBridge()
    if (bridge?.ReadFile) {
      try {
        const file = await bridge.ReadFile(filePath)
        if (file?.dataBase64) {
          const binary = atob(file.dataBase64)
          const bytes = new Uint8Array(binary.length)
          for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i)
          }
          return new TextDecoder('utf-8').decode(bytes)
        }
      } catch {
        return null
      }
    }
    return null
  }

  const defaultRemoveDir = async (dirPath: string) => {
    const bridge = getHostBridge()
    if (bridge?.RemoveDir) {
      await bridge.RemoveDir(dirPath)
      return
    }
    if (bridge?.RemoveFile) {
      try {
        await bridge.RemoveFile(dirPath)
      } catch {
        // Fallback
      }
    }
  }

  const readFile = options?.fsBridge?.readFile ?? defaultReadFile
  const removeDir = options?.fsBridge?.removeDir ?? defaultRemoveDir
  const removeFile = options?.fsBridge?.removeFile
  const gitRunner = options?.gitRunner ?? runGitViaNativeBridge

  let mainRepoPath: string | undefined =
    typeof target !== 'string' ? target.mainRepoPath : undefined
  let gitDir: string | undefined =
    typeof target !== 'string' ? target.gitDir : undefined
  let isGitWorktree =
    typeof target !== 'string' ? target.isGitWorktree : undefined

  // If git metadata is missing, discover it from .git file
  if (!mainRepoPath || !gitDir || isGitWorktree === undefined) {
    try {
      const gitFilePath = `${targetPath}/.git`
      const gitContent = await readFile(gitFilePath)
      if (gitContent) {
        const match = gitContent.match(/gitdir:\s*(.+)/i)
        if (match && match[1]) {
          isGitWorktree = true
          let resolvedGitDir = match[1].trim()
          if (
            !resolvedGitDir.startsWith('/') &&
            !/^[a-zA-Z]:[/\\]/.test(resolvedGitDir)
          ) {
            resolvedGitDir = resolveRelativePath(resolvedGitDir, targetPath)
          }
          gitDir = resolvedGitDir

          try {
            const commonDirContent = await readFile(`${gitDir}/commondir`)
            if (commonDirContent && commonDirContent.trim()) {
              const resolvedCommonDir = resolveRelativePath(
                commonDirContent.trim(),
                gitDir,
              )
              mainRepoPath = resolveRelativePath('..', resolvedCommonDir)
            }
          } catch {
            // Ignore
          }

          if (!mainRepoPath) {
            const norm = normalizePath(gitDir)
            const wtIdx = norm.lastIndexOf('/.git/worktrees')
            if (wtIdx !== -1) {
              mainRepoPath = norm.slice(0, wtIdx)
            }
          }
        }
      }
    } catch {
      // Ignore
    }
  }

  let gitRemoved = false

  // 1. Remove git worktree association in main repo
  if (mainRepoPath) {
    try {
      const result = await gitRunner(mainRepoPath, [
        'worktree',
        'remove',
        '--force',
        targetPath,
      ])
      if (result.exitCode === 0) {
        gitRemoved = true
      } else {
        // Prune broken worktree references if remove failed
        try {
          await gitRunner(mainRepoPath, ['worktree', 'prune'])
        } catch {
          // Best effort
        }
      }
    } catch {
      try {
        await gitRunner(mainRepoPath, ['worktree', 'prune'])
      } catch {
        // Best effort
      }
    }
  }

  // 2. Clean up git admin directory in main repo if still present
  if (gitDir) {
    try {
      if (removeDir) {
        await removeDir(gitDir)
      } else if (removeFile) {
        await removeFile(gitDir)
      }
    } catch {
      // Best effort
    }
  }

  // 3. Delete worktree directory from filesystem
  try {
    if (removeDir) {
      await removeDir(targetPath)
    } else if (removeFile) {
      await removeFile(targetPath)
    }
  } catch (err) {
    if (!gitRemoved) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  return { ok: true }
}
