import { describe, expect, it } from 'vitest'
import {
  deleteWorktree,
  listWorktreesUnderDir,
  resolveWorktreeRootDir,
  type DiscoveredWorktree,
  type WorktreeFsBridge,
} from './worktrees'
import type { GitCommandResult } from './gitBranches'

describe('worktrees lib', () => {
  describe('resolveWorktreeRootDir', () => {
    it('returns custom absolute path as-is', async () => {
      const resolved = await resolveWorktreeRootDir('/custom/path/worktrees', '/home/user')
      expect(resolved).toBe('/custom/path/worktrees')
    })

    it('expands ~ using homeDir', async () => {
      const resolved = await resolveWorktreeRootDir('~/worktrees', '/Users/testuser')
      expect(resolved).toBe('/Users/testuser/worktrees')
    })

    it('falls back to default path when rootDir is empty', async () => {
      const resolved = await resolveWorktreeRootDir('', '/Users/testuser')
      expect(resolved).toBe('/Users/testuser/.coding-professional-agent/worktrees')
    })
  })

  describe('listWorktreesUnderDir', () => {
    it('returns empty array if rootDir is empty', async () => {
      const result = await listWorktreesUnderDir('')
      expect(result).toEqual([])
    })

    it('returns empty array if readDir returns null or empty', async () => {
      const bridge: WorktreeFsBridge = {
        readDir: async () => null,
      }
      const result = await listWorktreesUnderDir('/test/dir', bridge)
      expect(result).toEqual([])
    })

    it('lists subdirectories and ignores files and dot-folders', async () => {
      const bridge: WorktreeFsBridge = {
        readDir: async (dir) => {
          if (dir === '/test/worktrees') {
            return [
              { name: 'wt-alpha', isDir: true },
              { name: 'wt-beta', isDir: true },
              { name: '.hidden', isDir: true },
              { name: 'some-file.txt', isDir: false },
            ]
          }
          return null
        },
        readFile: async () => null,
      }

      const result = await listWorktreesUnderDir('/test/worktrees', bridge)
      expect(result).toHaveLength(2)
      expect(result[0]?.name).toBe('wt-alpha')
      expect(result[0]?.path).toBe('/test/worktrees/wt-alpha')
      expect(result[1]?.name).toBe('wt-beta')
      expect(result[1]?.path).toBe('/test/worktrees/wt-beta')
    })

    it('parses git worktree metadata with gitdir pointer file', async () => {
      const files: Record<string, string> = {
        '/test/worktrees/feat-x/.git': 'gitdir: /repo/project-a/.git/worktrees/feat-x\n',
        '/repo/project-a/.git/worktrees/feat-x/HEAD': 'ref: refs/heads/feature/awesome\n',
        '/repo/project-a/.git/worktrees/feat-x/commondir': '../..\n',
      }

      const bridge: WorktreeFsBridge = {
        readDir: async () => [{ name: 'feat-x', isDir: true }],
        readFile: async (path) => files[path] ?? null,
      }

      const result = await listWorktreesUnderDir('/test/worktrees', bridge)
      expect(result).toHaveLength(1)
      const wt = result[0]!
      expect(wt.name).toBe('feat-x')
      expect(wt.isGitWorktree).toBe(true)
      expect(wt.branch).toBe('feature/awesome')
      expect(wt.mainRepo).toBe('project-a')
    })

    it('parses detached HEAD SHA', async () => {
      const files: Record<string, string> = {
        '/test/worktrees/detached-wt/.git': 'gitdir: /repo/my-app/.git/worktrees/detached-wt\n',
        '/repo/my-app/.git/worktrees/detached-wt/HEAD': 'a1b2c3d4e5f607182930415263748596a7b8c9d0\n',
      }

      const bridge: WorktreeFsBridge = {
        readDir: async () => [{ name: 'detached-wt', isDir: true }],
        readFile: async (path) => files[path] ?? null,
      }

      const result = await listWorktreesUnderDir('/test/worktrees', bridge)
      expect(result).toHaveLength(1)
      const wt = result[0]!
      expect(wt.headSha).toBe('a1b2c3d')
      expect(wt.branch).toBeUndefined()
    })
  })

  describe('deleteWorktree', () => {
    it('returns error when target path is empty', async () => {
      const res = await deleteWorktree('')
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(/path is required/i)
    })

    it('removes git worktree in main repo and removes directory', async () => {
      const gitCalls: Array<{ cwd: string; args: readonly string[] }> = []
      const fakeGitRunner = async (
        cwd: string,
        args: readonly string[],
      ): Promise<GitCommandResult> => {
        gitCalls.push({ cwd, args })
        return { exitCode: 0, stdout: '', stderr: '' }
      }

      const files: Record<string, string> = {
        '/test/worktrees/feat-x/.git': 'gitdir: /repo/project-a/.git/worktrees/feat-x\n',
        '/repo/project-a/.git/worktrees/feat-x/commondir': '../..\n',
      }
      const removedDirs: string[] = []

      const bridge: WorktreeFsBridge = {
        readDir: async () => [{ name: 'feat-x', isDir: true }],
        readFile: async (path) => files[path] ?? null,
        removeDir: async (dir) => {
          removedDirs.push(dir)
        },
      }

      const res = await deleteWorktree('/test/worktrees/feat-x', {
        fsBridge: bridge,
        gitRunner: fakeGitRunner,
      })

      expect(res.ok).toBe(true)
      // Git command called on main repo /repo/project-a
      expect(gitCalls).toHaveLength(1)
      expect(gitCalls[0]?.cwd).toBe('/repo/project-a')
      expect(gitCalls[0]?.args).toEqual([
        'worktree',
        'remove',
        '--force',
        '/test/worktrees/feat-x',
      ])
      // Directory removed
      expect(removedDirs).toContain('/test/worktrees/feat-x')
    })

    it('prunes git worktree when git worktree remove fails and cleans up directory', async () => {
      const gitCalls: Array<{ cwd: string; args: readonly string[] }> = []
      const fakeGitRunner = async (
        cwd: string,
        args: readonly string[],
      ): Promise<GitCommandResult> => {
        gitCalls.push({ cwd, args })
        if (args[1] === 'remove') {
          return { exitCode: 1, stdout: '', stderr: 'fatal: worktree locked' }
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      }

      const files: Record<string, string> = {
        '/test/worktrees/feat-locked/.git': 'gitdir: /repo/project-b/.git/worktrees/feat-locked\n',
        '/repo/project-b/.git/worktrees/feat-locked/commondir': '../..\n',
      }
      const removedDirs: string[] = []

      const bridge: WorktreeFsBridge = {
        readDir: async () => [{ name: 'feat-locked', isDir: true }],
        readFile: async (path) => files[path] ?? null,
        removeDir: async (dir) => {
          removedDirs.push(dir)
        },
      }

      const wt: DiscoveredWorktree = {
        name: 'feat-locked',
        path: '/test/worktrees/feat-locked',
        mainRepoPath: '/repo/project-b',
        gitDir: '/repo/project-b/.git/worktrees/feat-locked',
        isGitWorktree: true,
      }

      const res = await deleteWorktree(wt, {
        fsBridge: bridge,
        gitRunner: fakeGitRunner,
      })

      expect(res.ok).toBe(true)
      expect(gitCalls[0]?.args).toEqual([
        'worktree',
        'remove',
        '--force',
        '/test/worktrees/feat-locked',
      ])
      // Fallback to git worktree prune
      expect(gitCalls[1]?.args).toEqual(['worktree', 'prune'])
      // Cleans up gitDir and target directory
      expect(removedDirs).toContain('/repo/project-b/.git/worktrees/feat-locked')
      expect(removedDirs).toContain('/test/worktrees/feat-locked')
    })

    it('deletes non-git worktree folder directly', async () => {
      const removedDirs: string[] = []
      const bridge: WorktreeFsBridge = {
        readDir: async () => [{ name: 'orphaned-dir', isDir: true }],
        readFile: async () => null,
        removeDir: async (dir) => {
          removedDirs.push(dir)
        },
      }

      const wt: DiscoveredWorktree = {
        name: 'orphaned-dir',
        path: '/test/worktrees/orphaned-dir',
        isGitWorktree: false,
      }

      const res = await deleteWorktree(wt, { fsBridge: bridge })
      expect(res.ok).toBe(true)
      expect(removedDirs).toContain('/test/worktrees/orphaned-dir')
    })
  })
})
