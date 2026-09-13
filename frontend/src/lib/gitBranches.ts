/**
 * List local branches by parsing .git metadata (no git CLI).
 * Create / switch branches with `git switch` so the index and worktree update.
 */

import { createId } from '@/lib/id'
import {
  base64ToBytes,
  createDefaultBindings,
  ElectronNativeBridge,
} from '@/features/agent-runtime/native/electronNativeBridge'
import type { NativeEvent } from '@/features/agent-runtime/native/types'
import {
  dirnamePath,
  isAbsolutePath,
  isMissingPathError,
  resolveToCwd,
} from '@cpa/plugin-sdk'

export interface GitFs {
  stat(path: string): Promise<{ isDir: boolean }>
  readFile(path: string): Promise<Uint8Array>
  readFileIfExists?(path: string): Promise<Uint8Array | null>
  readDir(path: string): Promise<readonly { name: string; isDir: boolean }[]>
}

export interface GitCommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

export type GitCommandRunner = (
  cwd: string,
  args: readonly string[],
) => Promise<GitCommandResult>

export interface GitRepoInfo {
  repoRoot: string
  gitDir: string
  commonDir: string
  current: string | null
  detached: boolean
  headSha: string | null
  branches: string[]
}

const HEADS_PREFIX = 'refs/heads/'
const SHA_RE = /^[0-9a-f]{40,64}$/i
const PACKED_HEAD_RE = /^([0-9a-f]{40,64})\s+(refs\/heads\/\S+)\s*$/i
const MAX_REF_DEPTH = 20

export function createNativeGitFs(): GitFs {
  const bindings = createDefaultBindings()
  return {
    async stat(path) {
      const info = await bindings.Stat(path)
      return { isDir: info.isDir }
    },
    async readFile(path) {
      if (typeof bindings.ReadFileIfExists === 'function') {
        const file = await bindings.ReadFileIfExists(path)
        if (!file) {
          const err = new Error(`ENOENT: no such file or directory, open '${path}'`)
          ;(err as unknown as { code?: string }).code = 'ENOENT'
          throw err
        }
        return base64ToBytes(file.dataBase64)
      }
      const file = await bindings.ReadFile(path)
      return base64ToBytes(file.dataBase64)
    },
    async readFileIfExists(path) {
      if (typeof bindings.ReadFileIfExists === 'function') {
        const file = await bindings.ReadFileIfExists(path)
        if (!file?.dataBase64) return null
        return base64ToBytes(file.dataBase64)
      }
      try {
        const file = await bindings.ReadFile(path)
        return base64ToBytes(file.dataBase64)
      } catch (err) {
        if (isMissingPathError(err)) return null
        throw err
      }
    },
    async readDir(path) {
      return (await bindings.ReadDir(path)) ?? []
    },
  }
}

export async function readGitRepo(
  roots: readonly string[],
  fs: GitFs,
): Promise<GitRepoInfo | null> {
  for (const root of roots) {
    const trimmed = typeof root === 'string' ? root.trim() : ''
    if (!trimmed) continue
    try {
      const info = await readGitRepoFromRoot(trimmed, fs)
      if (info) return info
    } catch {
      // Try the next project folder.
    }
  }
  return null
}

export async function readGitRepoWithDefaultFs(
  roots: readonly string[],
): Promise<GitRepoInfo | null> {
  return readGitRepo(roots, createNativeGitFs())
}

export async function switchGitBranch(
  repo: Pick<GitRepoInfo, 'repoRoot'>,
  name: string,
  options: { create?: boolean; baseBranch?: string; run?: GitCommandRunner } = {},
): Promise<void> {
  if (!isValidGitBranchName(name)) {
    throw new Error('invalid branch name')
  }
  const run = options.run ?? runGitViaNativeBridge
  const switchArgs = options.create
    ? options.baseBranch
      ? (['switch', '-c', name, options.baseBranch] as const)
      : (['switch', '-c', name] as const)
    : (['switch', '--', name] as const)
  let result = await run(repo.repoRoot, switchArgs)
  if (result.exitCode !== 0 && isSwitchUnsupported(result)) {
    const checkoutArgs = options.create
      ? options.baseBranch
        ? (['checkout', '-b', name, options.baseBranch] as const)
        : (['checkout', '-b', name] as const)
      : (['checkout', '--', name] as const)
    result = await run(repo.repoRoot, checkoutArgs)
  }
  if (result.exitCode !== 0) {
    throw new Error(formatGitError(result))
  }
}

export async function switchGitBranchWithDefaultRunner(
  repo: Pick<GitRepoInfo, 'repoRoot'>,
  name: string,
  options: { create?: boolean; baseBranch?: string } = {},
): Promise<void> {
  await switchGitBranch(repo, name, options)
}

/** Subset of git-check-ref-format rules for branch names (not full refs). */
export function isValidGitBranchName(name: string): boolean {
  if (!name || name === '@' || name.startsWith('-')) return false
  if (
    name.startsWith('/') ||
    name.endsWith('/') ||
    name.startsWith('.') ||
    name.endsWith('.') ||
    name.endsWith('.lock')
  ) {
    return false
  }
  if (
    name.includes('//') ||
    name.includes('..') ||
    name.includes('@{') ||
    /[\x00-\x20~^:?*[\\]/.test(name)
  ) {
    return false
  }
  for (const part of name.split('/')) {
    if (!part || part.startsWith('.') || part.endsWith('.lock')) return false
  }
  return true
}

export function sortBranchNames(
  names: readonly string[],
  current: string | null,
): string[] {
  return [...new Set(names)].sort((left, right) => {
    if (left === current) return -1
    if (right === current) return 1
    return left.localeCompare(right)
  })
}

async function readGitRepoFromRoot(
  start: string,
  fs: GitFs,
): Promise<GitRepoInfo | null> {
  const located = await findGitDirs(start, fs)
  if (!located) return null

  const headText = await readText(fs, joinPath(located.gitDir, 'HEAD'))
  if (headText === null) return null

  const parsedHead = parseHead(headText)
  const packed = await readPackedHeads(fs, located.commonDir)
  const loose = await listLooseBranchNames(
    fs,
    joinPath(located.commonDir, 'refs/heads'),
    '',
    0,
  )

  const branchSet = new Set<string>([...loose, ...packed.keys()])
  if (parsedHead.current) branchSet.add(parsedHead.current)

  let headSha = parsedHead.sha
  if (!headSha && parsedHead.current) {
    headSha = await resolveBranchSha(
      fs,
      located.commonDir,
      parsedHead.current,
      packed,
    )
  }

  return {
    repoRoot: located.repoRoot,
    gitDir: located.gitDir,
    commonDir: located.commonDir,
    current: parsedHead.current,
    detached: parsedHead.detached,
    headSha,
    branches: sortBranchNames([...branchSet], parsedHead.current),
  }
}

async function findGitDirs(
  start: string,
  fs: GitFs,
): Promise<{ repoRoot: string; gitDir: string; commonDir: string } | null> {
  let current = normalizeAbs(start)
  const seen = new Set<string>()

  while (!seen.has(current)) {
    seen.add(current)
    const resolved = await resolveGitDir(joinPath(current, '.git'), current, fs)
    if (resolved) {
      return { repoRoot: current, ...resolved }
    }
    const parent = dirnamePath(current)
    if (parent === current) break
    current = parent
  }
  return null
}

async function resolveGitDir(
  gitPath: string,
  repoRoot: string,
  fs: GitFs,
): Promise<{ gitDir: string; commonDir: string } | null> {
  try {
    const stat = await fs.stat(gitPath)
    if (stat.isDir) {
      return {
        gitDir: gitPath,
        commonDir: await readCommonDir(gitPath, fs),
      }
    }
    const text = await readText(fs, gitPath)
    const gitDir = parseGitDirPointer(text ?? '', repoRoot)
    if (!gitDir) return null
    return {
      gitDir,
      commonDir: await readCommonDir(gitDir, fs),
    }
  } catch (error) {
    if (isMissingPathError(error)) return null
    return null
  }
}

async function readCommonDir(gitDir: string, fs: GitFs): Promise<string> {
  const text = await readText(fs, joinPath(gitDir, 'commondir'))
  const value = text?.trim()
  if (!value) return gitDir
  return resolveMaybeRelative(value, gitDir)
}

function parseGitDirPointer(text: string, repoRoot: string): string | null {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    const match = /^gitdir:\s*(.+)$/i.exec(line)
    const value = match?.[1]?.trim()
    if (!value) continue
    return resolveMaybeRelative(value, repoRoot)
  }
  return null
}

function parseHead(text: string): {
  current: string | null
  detached: boolean
  sha: string | null
} {
  const line = text.split(/\r?\n/)[0]?.trim() ?? ''
  if (line.startsWith('ref:')) {
    const ref = line.slice('ref:'.length).trim()
    if (ref.startsWith(HEADS_PREFIX)) {
      const current = ref.slice(HEADS_PREFIX.length)
      return { current: current || null, detached: false, sha: null }
    }
    return { current: null, detached: false, sha: null }
  }
  if (SHA_RE.test(line)) {
    return { current: null, detached: true, sha: line.toLowerCase() }
  }
  return { current: null, detached: false, sha: null }
}

async function listLooseBranchNames(
  fs: GitFs,
  dir: string,
  prefix: string,
  depth: number,
): Promise<string[]> {
  if (depth > MAX_REF_DEPTH) return []
  let entries: readonly { name: string; isDir: boolean }[]
  try {
    entries = await fs.readDir(dir)
  } catch (error) {
    if (isMissingPathError(error)) return []
    throw error
  }

  const names: string[] = []
  for (const entry of entries) {
    if (!entry.name || entry.name === '.' || entry.name === '..') continue
    if (entry.name.endsWith('.lock')) continue
    if (entry.isDir) {
      const nested = await listLooseBranchNames(
        fs,
        joinPath(dir, entry.name),
        `${prefix}${entry.name}/`,
        depth + 1,
      )
      names.push(...nested)
      continue
    }
    names.push(`${prefix}${entry.name}`)
  }
  return names
}

async function readPackedHeads(
  fs: GitFs,
  commonDir: string,
): Promise<Map<string, string>> {
  const text = await readText(fs, joinPath(commonDir, 'packed-refs'))
  const packed = new Map<string, string>()
  if (!text) return packed
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith('^')) continue
    const match = PACKED_HEAD_RE.exec(line)
    if (!match) continue
    const sha = match[1]
    const ref = match[2]
    if (!sha || !ref) continue
    packed.set(ref.slice(HEADS_PREFIX.length), sha.toLowerCase())
  }
  return packed
}

async function resolveBranchSha(
  fs: GitFs,
  commonDir: string,
  branch: string,
  packed: Map<string, string>,
): Promise<string | null> {
  const loose = await readText(fs, joinPath(commonDir, HEADS_PREFIX + branch))
  if (loose !== null) {
    const line = loose.split(/\r?\n/)[0]?.trim() ?? ''
    if (SHA_RE.test(line)) return line.toLowerCase()
    if (line.startsWith('ref:')) {
      const ref = line.slice('ref:'.length).trim()
      if (ref.startsWith(HEADS_PREFIX)) {
        const target = ref.slice(HEADS_PREFIX.length)
        if (target && target !== branch) {
          return resolveBranchSha(fs, commonDir, target, packed)
        }
      }
    }
  }
  return packed.get(branch) ?? null
}

async function readText(fs: GitFs, path: string): Promise<string | null> {
  try {
    if (typeof fs.readFileIfExists === 'function') {
      const data = await fs.readFileIfExists(path)
      return data ? new TextDecoder('utf-8').decode(data) : null
    }
    return new TextDecoder('utf-8').decode(await fs.readFile(path))
  } catch (error) {
    if (isMissingPathError(error)) return null
    throw error
  }
}

function resolveMaybeRelative(value: string, base: string): string {
  return isAbsolutePath(value)
    ? resolveToCwd(value, value)
    : resolveToCwd(value, base)
}

function normalizeAbs(path: string): string {
  return isAbsolutePath(path) ? resolveToCwd(path, path) : path
}

function joinPath(base: string, relative: string): string {
  return resolveToCwd(relative, base)
}

function isSwitchUnsupported(result: GitCommandResult): boolean {
  const text = `${result.stderr}\n${result.stdout}`
  return /is not a git command|unknown command|not a git-command/i.test(text)
}

function formatGitError(result: GitCommandResult): string {
  const text = [result.stderr, result.stdout]
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n')
  return text || `git exited with code ${result.exitCode}`
}

export async function runGitViaNativeBridge(
  cwd: string,
  args: readonly string[],
): Promise<GitCommandResult> {
  const bridge = new ElectronNativeBridge()
  try {
    const git = await bridge.lookPath('git')
    if (!git) {
      return {
        exitCode: 127,
        stdout: '',
        stderr: 'git executable not found',
      }
    }
    const operation = await bridge.startProcess({
      operationId: createId(),
      executable: git,
      args,
      cwd,
    })
    let stdout = ''
    let stderr = ''
    let exitCode = 1
    let terminalKind = ''
    try {
      for await (const event of operation.events) {
        if (event.kind === 'process-stdout') {
          stdout += decodeEventText(event)
        } else if (event.kind === 'process-stderr') {
          stderr += decodeEventText(event)
        } else if (event.kind === 'done') {
          terminalKind = 'done'
          exitCode =
            typeof event.exitCode === 'number' ? event.exitCode : 1
          break
        } else if (event.kind === 'error' || event.kind === 'cancelled') {
          terminalKind = event.kind
          const extra = event.error || event.reason || event.kind
          stderr = [stderr, extra].filter(Boolean).join('\n')
          break
        }
      }
    } finally {
      try {
        await bridge.removeFile(operation.fullOutputPath)
      } catch {
        // Best-effort cleanup of the native process log.
      }
    }
    if (terminalKind !== 'done') {
      return {
        exitCode: exitCode || 1,
        stdout,
        stderr: stderr || terminalKind || 'git process ended without status',
      }
    }
    return { exitCode, stdout, stderr }
  } finally {
    await bridge.dispose()
  }
}

function decodeEventText(event: NativeEvent): string {
  if (event.data === undefined || event.data === '') return ''
  if (event.encoding === 'base64') {
    return new TextDecoder('utf-8').decode(base64ToBytes(event.data))
  }
  if (event.encoding === 'utf8') return event.data
  throw new Error(
    `unsupported process output encoding: ${event.encoding ?? '(missing)'}`,
  )
}
