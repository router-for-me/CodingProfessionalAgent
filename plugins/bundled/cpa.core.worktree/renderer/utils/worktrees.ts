import type { FileSystemService, ProcessService } from '@cpa/plugin-api'

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

export type GitCommandRunner = (args: readonly string[], cwd?: string) => Promise<{
    exitCode: number
    stdout: string
    stderr: string
}>

export interface WorktreeServiceContext {
    fsBridge?: WorktreeFsBridge
    gitRunner?: GitCommandRunner
    fileSystemService?: FileSystemService
    processService?: ProcessService
}

export async function resolveWorktreeRootDir(
    configuredRootDir?: string,
    runtimeHomeDir?: string,
    fileSystemService?: FileSystemService,
): Promise<string> {
    const trimmed = configuredRootDir?.trim()
    let homeDir = runtimeHomeDir

    if (!homeDir && fileSystemService?.getRuntimeInfo) {
        try {
            const info = await fileSystemService.getRuntimeInfo()
            if (info?.homeDir) {
                homeDir = info.homeDir
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
        return `${homeDir}/.coding-professional-agent/worktrees`
    }
    return '~/.coding-professional-agent/worktrees'
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

export async function listWorktreesUnderDir(
    rootDir: string,
    options: WorktreeFsBridge | WorktreeServiceContext = {},
): Promise<DiscoveredWorktree[]> {
    if (!rootDir || !rootDir.trim()) return []

    const bridge: WorktreeFsBridge | undefined =
        'readDir' in options ? options : options.fsBridge
    const fileSystemService: FileSystemService | undefined =
        'readDir' in options ? undefined : options.fileSystemService

    const resolvedDir = await resolveWorktreeRootDir(rootDir, undefined, fileSystemService)

    const readDir = async (dirPath: string): Promise<Array<{ name: string; isDir: boolean }> | null> => {
        if (bridge?.readDir) {
            return bridge.readDir(dirPath)
        }
        if (fileSystemService?.readDir) {
            try {
                const list = await fileSystemService.readDir(dirPath)
                return (list || []).map((item) => ({
                    name: item.name,
                    isDir: item.isDirectory,
                }))
            } catch {
                return null
            }
        }
        return null
    }

    const readFile = async (filePath: string): Promise<string | null> => {
        if (bridge?.readFile) {
            return bridge.readFile(filePath)
        }
        if (fileSystemService) {
            try {
                const file = fileSystemService.readFileIfExists
                    ? await fileSystemService.readFileIfExists(filePath)
                    : await fileSystemService.readFile(filePath)
                if (file?.dataBase64) {
                    const binary = atob(file.dataBase64)
                    const bytes = new Uint8Array(binary.length)
                    for (let i = 0; i < binary.length; i++) {
                        bytes[i] = binary.charCodeAt(i)
                    }
                    return new TextDecoder().decode(bytes)
                }
            } catch {
                return null
            }
        }
        return null
    }

    const entries = await readDir(resolvedDir)
    if (!entries || !Array.isArray(entries)) {
        return []
    }

    const worktrees: DiscoveredWorktree[] = []

    for (const entry of entries) {
        if (!entry.isDir) continue

        const wtPath = `${resolvedDir}/${entry.name}`
        const gitFilePath = `${wtPath}/.git`

        const gitFileContent = await readFile(gitFilePath)
        if (!gitFileContent || !gitFileContent.trim().startsWith('gitdir:')) {
            continue
        }

        let gitDirPath = gitFileContent.replace(/^gitdir:\s*/, '').trim()
        if (!gitDirPath.startsWith('/') && !/^[a-zA-Z]:/.test(gitDirPath)) {
            gitDirPath = resolveRelativePath(gitDirPath, wtPath)
        }

        let branch: string | undefined
        let headSha: string | undefined
        let mainRepoPath: string | undefined
        let mainRepo: string | undefined

        const headContent = await readFile(`${gitDirPath}/HEAD`)
        if (headContent) {
            const headTrimmed = headContent.trim()
            if (headTrimmed.startsWith('ref:')) {
                const ref = headTrimmed.replace(/^ref:\s*/, '').trim()
                branch = ref.replace(/^refs\/heads\//, '')
            } else {
                headSha = headTrimmed.slice(0, 8)
            }
        }

        const commondirContent = await readFile(`${gitDirPath}/commondir`)
        if (commondirContent) {
            const commondirTrimmed = commondirContent.trim()
            const fullCommonDir = resolveRelativePath(commondirTrimmed, gitDirPath)
            mainRepoPath = normalizePath(fullCommonDir).replace(/\/\.git\/?$/, '')
            const parts = mainRepoPath.split('/').filter(Boolean)
            mainRepo = parts[parts.length - 1] ?? mainRepoPath
        }

        worktrees.push({
            name: entry.name,
            path: wtPath,
            branch,
            headSha,
            mainRepo,
            mainRepoPath,
            gitDir: gitDirPath,
            isGitWorktree: true,
        })
    }

    return worktrees
}

export async function deleteWorktree(
    wt: DiscoveredWorktree,
    options: {
        fsBridge?: WorktreeFsBridge
        gitRunner?: GitCommandRunner
        fileSystemService?: FileSystemService
        processService?: ProcessService
    } = {},
): Promise<{ ok: boolean; error?: string }> {
    const { fsBridge, gitRunner, fileSystemService, processService } = options

    const runner: GitCommandRunner | undefined =
        gitRunner ??
        (processService
            ? async (args: readonly string[], cwd?: string) => {
                  try {
                      return await processService.run({
                          command: 'git',
                          args,
                          cwd,
                      })
                  } catch (err) {
                      return {
                          exitCode: 1,
                          stdout: '',
                          stderr: err instanceof Error ? err.message : String(err),
                      }
                  }
              }
            : undefined)

    const removeDir =
        fsBridge?.removeDir ??
        (fileSystemService?.removeDir
            ? (dirPath: string) => fileSystemService.removeDir!(dirPath)
            : undefined)

    if (wt.mainRepoPath && runner) {
        const res = await runner(['worktree', 'remove', '--force', wt.path], wt.mainRepoPath)
        if (res.exitCode === 0) {
            if (removeDir) {
                await removeDir(wt.path).catch(() => {})
            }
            return { ok: true }
        }
    }

    if (removeDir) {
        try {
            await removeDir(wt.path)
            return { ok: true }
        } catch (err) {
            return {
                ok: false,
                error: err instanceof Error ? err.message : String(err),
            }
        }
    }

    return { ok: false, error: 'Cannot delete directory: no removal handler available' }
}
