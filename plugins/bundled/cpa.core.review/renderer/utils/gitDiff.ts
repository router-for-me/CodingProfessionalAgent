export type GitFileStatus =
  | 'added'
  | 'deleted'
  | 'modified'
  | 'renamed'
  | 'copied'
  | 'untracked'

export interface GitDiffLine {
  type: 'add' | 'delete' | 'normal'
  oldLineNumber: number | null
  newLineNumber: number | null
  content: string
}

export interface GitDiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  heading: string
  lines: GitDiffLine[]
}

export interface GitDiffFile {
  oldPath: string
  newPath: string
  displayPath: string
  status: GitFileStatus
  additions: number
  deletions: number
  isBinary: boolean
  hunks: GitDiffHunk[]
}

export interface GitDiffSummary {
  files: GitDiffFile[]
  totalAdditions: number
  totalDeletions: number
  totalFilesChanged: number
  rawDiff: string
}

export interface GitRepoDetails {
  repoRoot: string
  currentBranch: string | null
  defaultBranch: string | null
  branches: string[]
  remoteUrl: string | null
  isClean: boolean
}

export interface GitStatusEntry {
  status: GitFileStatus
  path: string
  origPath?: string
}

export const LARGE_DIFF_FILE_THRESHOLD = 5
export const LARGE_DIFF_LINES_THRESHOLD = 500

/**
 * Check if the git diff summary exceeds size thresholds
 * (e.g. 5+ files or 500+ total line changes when more than 1 file changed).
 */
export function isLargeGitDiff(summary?: GitDiffSummary | null): boolean {
  if (!summary || !summary.files || summary.files.length <= 1) {
    return false
  }
  const totalLines = (summary.totalAdditions ?? 0) + (summary.totalDeletions ?? 0)
  return (
    summary.files.length >= LARGE_DIFF_FILE_THRESHOLD ||
    totalLines >= LARGE_DIFF_LINES_THRESHOLD
  )
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/

export function parseGitDiff(rawDiff: string): GitDiffSummary {
  if (!rawDiff || !rawDiff.trim()) {
    return {
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
      totalFilesChanged: 0,
      rawDiff: '',
    }
  }

  const files: GitDiffFile[] = []
  let totalAdditions = 0
  let totalDeletions = 0

  const lines = rawDiff.split(/\r?\n/)
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (line.startsWith('diff --git ')) {
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/)
      let oldPath = match ? match[1] : ''
      let newPath = match ? match[2] : ''
      let displayPath = newPath || oldPath
      let status: GitFileStatus = 'modified'
      let isBinary = false
      let fileAdditions = 0
      let fileDeletions = 0
      const hunks: GitDiffHunk[] = []

      i += 1
      while (i < lines.length && !lines[i].startsWith('diff --git ')) {
        const subLine = lines[i]

        if (subLine.startsWith('new file mode')) {
          status = 'added'
        } else if (subLine.startsWith('deleted file mode')) {
          status = 'deleted'
        } else if (subLine.startsWith('similarity index') || subLine.startsWith('rename from')) {
          status = 'renamed'
        } else if (subLine.startsWith('copy from')) {
          status = 'copied'
        } else if (subLine.startsWith('rename from ')) {
          oldPath = subLine.slice('rename from '.length)
        } else if (subLine.startsWith('rename to ')) {
          newPath = subLine.slice('rename to '.length)
          displayPath = newPath
        } else if (subLine.startsWith('Binary files ') || subLine.includes('differ')) {
          isBinary = true
        } else if (subLine.startsWith('--- a/')) {
          oldPath = subLine.slice('--- a/'.length)
        } else if (subLine.startsWith('+++ b/')) {
          newPath = subLine.slice('+++ b/'.length)
          displayPath = newPath
        } else if (subLine.startsWith('@@ ')) {
          const hunkMatch = subLine.match(HUNK_HEADER_RE)
          if (hunkMatch) {
            const oldStart = parseInt(hunkMatch[1], 10)
            const oldLines = hunkMatch[2] ? parseInt(hunkMatch[2], 10) : 1
            const newStart = parseInt(hunkMatch[3], 10)
            const newLines = hunkMatch[4] ? parseInt(hunkMatch[4], 10) : 1
            const heading = hunkMatch[5] ? hunkMatch[5].trim() : ''

            const hunkLines: GitDiffLine[] = []
            let curOld = oldStart
            let curNew = newStart

            i += 1
            while (i < lines.length) {
              const hLine = lines[i]
              if (hLine.startsWith('diff --git ') || hLine.startsWith('@@ ')) {
                break
              }

              if (hLine.startsWith('+')) {
                fileAdditions += 1
                hunkLines.push({
                  type: 'add',
                  oldLineNumber: null,
                  newLineNumber: curNew,
                  content: hLine.slice(1),
                })
                curNew += 1
              } else if (hLine.startsWith('-')) {
                fileDeletions += 1
                hunkLines.push({
                  type: 'delete',
                  oldLineNumber: curOld,
                  newLineNumber: null,
                  content: hLine.slice(1),
                })
                curOld += 1
              } else if (hLine.startsWith('\\ No newline at end of file')) {
                // Ignore diff artifact
              } else {
                hunkLines.push({
                  type: 'normal',
                  oldLineNumber: curOld,
                  newLineNumber: curNew,
                  content: hLine.startsWith(' ') ? hLine.slice(1) : hLine,
                })
                curOld += 1
                curNew += 1
              }
              i += 1
            }

            hunks.push({
              oldStart,
              oldLines,
              newStart,
              newLines,
              heading,
              lines: hunkLines,
            })
            continue
          }
        }
        i += 1
      }

      if (displayPath.startsWith('dev/null')) {
        displayPath = oldPath || newPath
      }

      totalAdditions += fileAdditions
      totalDeletions += fileDeletions

      files.push({
        oldPath,
        newPath,
        displayPath,
        status,
        additions: fileAdditions,
        deletions: fileDeletions,
        isBinary,
        hunks,
      })
    } else {
      i += 1
    }
  }

  return {
    files,
    totalAdditions,
    totalDeletions,
    totalFilesChanged: files.length,
    rawDiff,
  }
}

export type GitCommandRunner = (
  cwd: string,
  args: readonly string[],
) => Promise<{ exitCode: number; stdout: string; stderr: string }>

export async function runGit(
  cwd: string,
  args: readonly string[],
  runner?: GitCommandRunner,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (runner) {
    return runner(cwd, args)
  }
  return { exitCode: 1, stdout: '', stderr: 'No process runner available' }
}

export interface LoadGitDiffOptions {
  cwd?: string
  baseBranch?: string
  compareTarget?: string
  mode?: 'workingTree' | 'branch'
  compareMode?: 'workingTree' | 'branch'
  runner?: GitCommandRunner
}

export async function loadGitDiff(
  projectPathOrOptions: string | LoadGitDiffOptions,
  maybeOptions?: LoadGitDiffOptions,
): Promise<GitDiffSummary> {
  const isStringPath = typeof projectPathOrOptions === 'string'
  const projectPath = isStringPath ? projectPathOrOptions : (projectPathOrOptions?.cwd ?? '')
  const options = isStringPath ? maybeOptions : projectPathOrOptions

  const mode = options?.mode ?? options?.compareMode ?? 'workingTree'
  const runner = options?.runner

  if (mode === 'branch' && options?.baseBranch && options?.compareTarget) {
    const res = await runGit(
      projectPath,
      ['diff', `${options.baseBranch}...${options.compareTarget}`],
      runner,
    )
    if (res.exitCode === 0) {
      return parseGitDiff(res.stdout)
    }
    return {
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
      totalFilesChanged: 0,
      rawDiff: '',
    }
  }

  // Working tree mode
  const headDiffRes = await runGit(projectPath, ['diff', 'HEAD'], runner)
  let rawDiff = ''
  if (headDiffRes.exitCode === 0) {
    rawDiff = headDiffRes.stdout
  } else {
    const indexDiffRes = await runGit(projectPath, ['diff'], runner)
    if (indexDiffRes.exitCode === 0) {
      rawDiff = indexDiffRes.stdout
    }
  }

  const summary = parseGitDiff(rawDiff)

  // Also include untracked files
  const statusRes = await runGit(
    projectPath,
    ['status', '--porcelain', '-uall'],
    runner,
  )
  if (statusRes.exitCode === 0 && statusRes.stdout) {
    const statusLines = statusRes.stdout.split(/\r?\n/)
    for (const sLine of statusLines) {
      if (sLine.startsWith('?? ')) {
        const untrackedPath = sLine.slice(3).trim()
        if (untrackedPath && !summary.files.some((f) => f.displayPath === untrackedPath)) {
          let untrackedDiff: GitDiffSummary | null = null
          try {
            const diffRes = await runGit(
              projectPath,
              ['diff', '--no-index', '--', '/dev/null', untrackedPath],
              runner,
            )
            if (diffRes.stdout && diffRes.stdout.trim()) {
              untrackedDiff = parseGitDiff(diffRes.stdout)
            }
          } catch {
            // Ignore error
          }

          const parsedFile = untrackedDiff?.files[0]
          if (parsedFile) {
            summary.files.push({
              ...parsedFile,
              oldPath: untrackedPath,
              newPath: untrackedPath,
              displayPath: untrackedPath,
              status: 'untracked',
            })
            summary.totalAdditions += parsedFile.additions
            summary.totalFilesChanged += 1
          } else {
            summary.files.push({
              oldPath: untrackedPath,
              newPath: untrackedPath,
              displayPath: untrackedPath,
              status: 'untracked',
              additions: 0,
              deletions: 0,
              isBinary: false,
              hunks: [],
            })
            summary.totalFilesChanged += 1
          }
        }
      }
    }
  }

  return summary
}

export async function loadGitRepoDetails(
  projectPath: string,
  runner?: GitCommandRunner,
): Promise<GitRepoDetails | null> {
  const rootRes = await runGit(projectPath, ['rev-parse', '--show-toplevel'], runner)
  const repoRoot = (rootRes.stdout ?? '').trim()
  if (rootRes.exitCode !== 0 || !repoRoot) {
    return null
  }

  const branchRes = await runGit(projectPath, ['branch', '--show-current'], runner)
  const currentBranch = branchRes.exitCode === 0 ? branchRes.stdout.trim() || null : null

  const defaultBranchRes = await runGit(
    projectPath,
    ['symbolic-ref', 'refs/remotes/origin/HEAD'],
    runner,
  )
  let defaultBranch: string | null = null
  if (defaultBranchRes.exitCode === 0) {
    const match = defaultBranchRes.stdout.trim().match(/refs\/remotes\/origin\/(.+)$/)
    if (match) defaultBranch = match[1]
  }
  if (!defaultBranch) {
    const allBranchesRes = await runGit(projectPath, ['branch', '-a'], runner)
    if (allBranchesRes.exitCode === 0) {
      if (allBranchesRes.stdout.includes('main')) defaultBranch = 'main'
      else if (allBranchesRes.stdout.includes('master')) defaultBranch = 'master'
    }
  }

  const branchesRes = await runGit(
    projectPath,
    ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'],
    runner,
  )
  const branches: string[] =
    branchesRes.exitCode === 0
      ? branchesRes.stdout
          .split(/\r?\n/)
          .map((b) => b.trim())
          .filter(Boolean)
      : []

  const remoteRes = await runGit(projectPath, ['config', '--get', 'remote.origin.url'], runner)
  const remoteUrl = remoteRes.exitCode === 0 ? remoteRes.stdout.trim() || null : null

  const statusRes = await runGit(projectPath, ['status', '--porcelain'], runner)
  const isClean = statusRes.exitCode === 0 && !statusRes.stdout.trim()

  return {
    repoRoot,
    currentBranch,
    defaultBranch: defaultBranch || 'main',
    branches,
    remoteUrl,
    isClean,
  }
}

export function buildGitHubCompareUrl(
  remoteUrl: string | null,
  base: string,
  target: string,
): string | null {
  if (!remoteUrl) return null
  let clean = remoteUrl.trim()
  if (clean.startsWith('git@github.com:')) {
    clean = clean.replace('git@github.com:', 'https://github.com/').replace(/\.git$/, '')
  } else if (clean.startsWith('https://github.com/')) {
    clean = clean.replace(/\.git$/, '')
  } else {
    return null
  }
  return `${clean}/compare/${base}...${target}`
}

export function buildPullRequestUrl(
  remoteUrl: string | null,
  base: string,
  target: string,
): string | null {
  const compare = buildGitHubCompareUrl(remoteUrl, base, target)
  return compare ? `${compare}?expand=1` : null
}
