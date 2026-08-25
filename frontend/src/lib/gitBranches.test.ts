import { describe, expect, it } from 'vitest'
import {
  isValidGitBranchName,
  readGitRepo,
  switchGitBranch,
  type GitCommandResult,
  type GitFs,
} from './gitBranches'

class MemoryGitFs implements GitFs {
  private readonly entries = new Map<
    string,
    { type: 'file'; data: Uint8Array } | { type: 'dir' }
  >()

  constructor(files: Record<string, string> = {}) {
    this.entries.set('/', { type: 'dir' })
    for (const [path, content] of Object.entries(files)) {
      void this.writeFile(path, new TextEncoder().encode(content))
    }
  }

  async stat(path: string): Promise<{ isDir: boolean }> {
    const entry = this.entries.get(normalize(path))
    if (!entry) throw missing(path)
    return { isDir: entry.type === 'dir' }
  }

  async readFile(path: string): Promise<Uint8Array> {
    const entry = this.entries.get(normalize(path))
    if (!entry) throw missing(path)
    if (entry.type !== 'file') throw new Error(`not a file: ${path}`)
    return entry.data
  }

  async readDir(
    path: string,
  ): Promise<readonly { name: string; isDir: boolean }[]> {
    const dir = normalize(path)
    const entry = this.entries.get(dir)
    if (!entry) throw missing(path)
    if (entry.type !== 'dir') throw new Error(`not a directory: ${path}`)
    const prefix = dir === '/' ? '/' : `${dir}/`
    const children = new Map<string, boolean>()
    for (const [key, value] of this.entries) {
      if (!key.startsWith(prefix)) continue
      const name = key.slice(prefix.length).split('/')[0]
      if (!name) continue
      const child = this.entries.get(`${prefix}${name}`)
      children.set(name, (child ?? value).type === 'dir')
    }
    return [...children].map(([name, isDir]) => ({ name, isDir }))
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    const filePath = normalize(path)
    this.ensureDir(parentOf(filePath))
    this.entries.set(filePath, { type: 'file', data })
  }

  async mkdirAll(path: string): Promise<void> {
    this.ensureDir(normalize(path))
  }

  text(path: string): string {
    const entry = this.entries.get(normalize(path))
    if (!entry || entry.type !== 'file') throw missing(path)
    return new TextDecoder('utf-8').decode(entry.data)
  }

  private ensureDir(path: string): void {
    let current = path
    const pending: string[] = []
    while (current && !this.entries.has(current)) {
      pending.push(current)
      const parent = parentOf(current)
      if (parent === current) break
      current = parent
    }
    for (const dir of pending.reverse()) {
      this.entries.set(dir, { type: 'dir' })
    }
  }
}

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
}

function parentOf(path: string): string {
  const normalized = normalize(path)
  const index = normalized.lastIndexOf('/')
  return index <= 0 ? '/' : normalized.slice(0, index)
}

function missing(path: string): Error {
  return new Error(`no such file or directory: ${path}`)
}

const MAIN_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const DEV_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

describe('readGitRepo', () => {
  it('reads the current branch and loose refs from a regular repo', async () => {
    const fs = new MemoryGitFs({
      '/repo/.git/HEAD': 'ref: refs/heads/dev\n',
      '/repo/.git/refs/heads/main': `${MAIN_SHA}\n`,
      '/repo/.git/refs/heads/dev': `${DEV_SHA}\n`,
      '/repo/.git/refs/heads/feature/agent': `${MAIN_SHA}\n`,
    })

    await expect(readGitRepo(['/repo/src'], fs)).resolves.toMatchObject({
      repoRoot: '/repo',
      current: 'dev',
      detached: false,
      headSha: DEV_SHA,
      branches: ['dev', 'feature/agent', 'main'],
    })
  })

  it('includes packed-only branches and resolves HEAD from packed-refs', async () => {
    const fs = new MemoryGitFs({
      '/repo/.git/HEAD': 'ref: refs/heads/main\n',
      '/repo/.git/packed-refs': [
        '# pack-refs with: peeled fully-peeled sorted',
        `${MAIN_SHA} refs/heads/main`,
        `${DEV_SHA} refs/heads/dev`,
        `${MAIN_SHA} refs/tags/v1.0`,
        `^${DEV_SHA}`,
      ].join('\n'),
    })

    await expect(readGitRepo(['/repo'], fs)).resolves.toMatchObject({
      current: 'main',
      headSha: MAIN_SHA,
      branches: ['main', 'dev'],
    })
  })

  it('follows a worktree gitdir pointer and commondir', async () => {
    const fs = new MemoryGitFs({
      '/work/.git': 'gitdir: /repo/.git/worktrees/feature\n',
      '/repo/.git/worktrees/feature/HEAD': 'ref: refs/heads/dev\n',
      '/repo/.git/worktrees/feature/commondir': '../..\n',
      '/repo/.git/refs/heads/main': `${MAIN_SHA}\n`,
      '/repo/.git/refs/heads/dev': `${DEV_SHA}\n`,
    })

    await expect(readGitRepo(['/work'], fs)).resolves.toMatchObject({
      repoRoot: '/work',
      gitDir: '/repo/.git/worktrees/feature',
      commonDir: '/repo/.git',
      current: 'dev',
      headSha: DEV_SHA,
      branches: ['dev', 'main'],
    })
  })

  it('reports detached HEAD without inventing a branch name', async () => {
    const fs = new MemoryGitFs({
      '/repo/.git/HEAD': `${MAIN_SHA}\n`,
      '/repo/.git/refs/heads/main': `${MAIN_SHA}\n`,
    })

    await expect(readGitRepo(['/repo'], fs)).resolves.toMatchObject({
      current: null,
      detached: true,
      headSha: MAIN_SHA,
      branches: ['main'],
    })
  })

  it('returns null when no git metadata exists', async () => {
    const fs = new MemoryGitFs({
      '/plain/README.md': 'hello\n',
    })
    await expect(readGitRepo(['/plain'], fs)).resolves.toBeNull()
  })
})

describe('switchGitBranch', () => {
  it('runs git switch for an existing branch', async () => {
    const calls: string[][] = []
    await switchGitBranch({ repoRoot: '/repo' }, 'main', {
      run: async (_cwd, args) => {
        calls.push([...args])
        return ok()
      },
    })
    expect(calls).toEqual([['switch', '--', 'main']])
  })

  it('creates a branch with git switch -c', async () => {
    const calls: string[][] = []
    await switchGitBranch({ repoRoot: '/repo' }, 'feature/search', {
      create: true,
      run: async (_cwd, args) => {
        calls.push([...args])
        return ok()
      },
    })
    expect(calls).toEqual([['switch', '-c', 'feature/search']])
  })

  it('falls back to git checkout when switch is unavailable', async () => {
    const calls: string[][] = []
    await switchGitBranch({ repoRoot: '/repo' }, 'main', {
      run: async (_cwd, args) => {
        calls.push([...args])
        if (args[0] === 'switch') {
          return {
            exitCode: 1,
            stdout: '',
            stderr: "git: 'switch' is not a git command. See 'git --help'.",
          }
        }
        return ok()
      },
    })
    expect(calls).toEqual([
      ['switch', '--', 'main'],
      ['checkout', '--', 'main'],
    ])
  })

  it('does not fall back when the worktree is dirty', async () => {
    const calls: string[][] = []
    await expect(
      switchGitBranch({ repoRoot: '/repo' }, 'main', {
        run: async (_cwd, args) => {
          calls.push([...args])
          return {
            exitCode: 1,
            stdout: '',
            stderr:
              'error: Your local changes to the following files would be overwritten by checkout',
          }
        },
      }),
    ).rejects.toThrow(/local changes/i)
    expect(calls).toEqual([['switch', '--', 'main']])
  })
})

function ok(): GitCommandResult {
  return { exitCode: 0, stdout: '', stderr: '' }
}

describe('isValidGitBranchName', () => {
  it('accepts ordinary hierarchical names', () => {
    expect(isValidGitBranchName('main')).toBe(true)
    expect(isValidGitBranchName('feature/search')).toBe(true)
    expect(isValidGitBranchName('fix-4595')).toBe(true)
  })

  it('rejects names git would refuse', () => {
    expect(isValidGitBranchName('')).toBe(false)
    expect(isValidGitBranchName('foo bar')).toBe(false)
    expect(isValidGitBranchName('foo..bar')).toBe(false)
    expect(isValidGitBranchName('foo.lock')).toBe(false)
    expect(isValidGitBranchName('-bad')).toBe(false)
    expect(isValidGitBranchName('foo@{bar')).toBe(false)
  })
})
