import { describe, expect, it } from 'vitest'
import {
    createWorktreeForProject,
    sanitizeFolderName,
} from './worktreeManager'
import type { GitCommandResult } from './gitBranches'

describe('worktreeManager', () => {
    describe('sanitizeFolderName', () => {
        it('cleans illegal characters and replaces spaces', () => {
            expect(sanitizeFolderName('my project/feature:123')).toBe('my-project-feature-123')
            expect(sanitizeFolderName('  leading and trailing  ')).toBe('leading-and-trailing')
        })
    })

    describe('createWorktreeForProject', () => {
        it('throws error when sourceTreePath is empty', async () => {
            await expect(
                createWorktreeForProject({ sourceTreePath: '' }),
            ).rejects.toThrow(/sourceTreePath is required/i)
        })

        it('creates a new worktree with a generated branch when no branch is specified', async () => {
            const gitCalls: Array<{ cwd: string; args: readonly string[] }> = []
            const fakeGitRunner = async (
                cwd: string,
                args: readonly string[],
            ): Promise<GitCommandResult> => {
                gitCalls.push({ cwd, args })
                return { exitCode: 0, stdout: 'ok', stderr: '' }
            }

            const progressEvents: string[] = []
            const result = await createWorktreeForProject({
                sourceTreePath: '/Users/test/projects/my-repo',
                worktreeRootDir: '/Users/test/.coding-professional-agent/worktrees',
                fetchUpstream: true,
                gitRunner: fakeGitRunner,
                onProgress: (step) => progressEvents.push(step),
            })

            expect(progressEvents).toContain('preparing')
            expect(progressEvents).toContain('checking_out')
            expect(progressEvents).toContain('done')

            expect(result.worktreePath).toContain('/Users/test/.coding-professional-agent/worktrees/my-repo-')
            expect(result.branch).toMatch(/^cpa\/[0-9a-f]{8}$/)
            expect(result.isNewBranch).toBe(true)

            // Should have called git fetch first, then git worktree add -b
            expect(gitCalls[0]?.args).toEqual(['fetch', '--all'])
            expect(gitCalls[1]?.args[0]).toBe('worktree')
            expect(gitCalls[1]?.args[1]).toBe('add')
            expect(gitCalls[1]?.args[2]).toBe('-b')
        })

        it('creates a worktree for an existing requested branch', async () => {
            const gitCalls: Array<{ cwd: string; args: readonly string[] }> = []
            const fakeGitRunner = async (
                cwd: string,
                args: readonly string[],
            ): Promise<GitCommandResult> => {
                gitCalls.push({ cwd, args })
                return { exitCode: 0, stdout: 'ok', stderr: '' }
            }

            const result = await createWorktreeForProject({
                sourceTreePath: '/Users/test/projects/my-repo',
                branch: 'feature-xyz',
                worktreeRootDir: '/Users/test/.coding-professional-agent/worktrees',
                fetchUpstream: false,
                gitRunner: fakeGitRunner,
            })

            expect(result.worktreePath).toContain('my-repo-feature-xyz-')
            expect(result.branch).toBe('feature-xyz')
            expect(gitCalls[0]?.args).toEqual([
                'worktree',
                'add',
                result.worktreePath,
                'feature-xyz',
            ])
        })

        it('respects custom branchPrefix from settings', async () => {
            const gitCalls: Array<{ cwd: string; args: readonly string[] }> = []
            const fakeGitRunner = async (
                cwd: string,
                args: readonly string[],
            ): Promise<GitCommandResult> => {
                gitCalls.push({ cwd, args })
                return { exitCode: 0, stdout: 'ok', stderr: '' }
            }

            const result = await createWorktreeForProject({
                sourceTreePath: '/Users/test/projects/my-repo',
                branchPrefix: 'feat/',
                worktreeRootDir: '/Users/test/.coding-professional-agent/worktrees',
                fetchUpstream: false,
                gitRunner: fakeGitRunner,
            })

            expect(result.branch).toMatch(/^feat\/[0-9a-f]{8}$/)
            expect(result.isNewBranch).toBe(true)
            expect(gitCalls[0]?.args[2]).toBe('-b')
            expect(gitCalls[0]?.args[3]).toMatch(/^feat\/[0-9a-f]{8}$/)
        })

        it('creates a new branch with branchPrefix when requested branch is already checked out', async () => {
            const gitCalls: Array<{ cwd: string; args: readonly string[] }> = []
            const fakeGitRunner = async (
                cwd: string,
                args: readonly string[],
            ): Promise<GitCommandResult> => {
                gitCalls.push({ cwd, args })
                // First worktree add <path> main fails
                if (args[1] === 'add' && args[2] !== '-b' && args[3] === 'main') {
                    return { exitCode: 1, stdout: '', stderr: "fatal: 'main' is already checked out" }
                }
                // Second worktree add -b main <path> fails
                if (args[1] === 'add' && args[2] === '-b' && args[3] === 'main') {
                    return { exitCode: 1, stdout: '', stderr: "fatal: A branch named 'main' already exists" }
                }
                // Third worktree add -b cpa/xxxx <path> main succeeds
                return { exitCode: 0, stdout: 'ok', stderr: '' }
            }

            const result = await createWorktreeForProject({
                sourceTreePath: '/Users/test/projects/my-repo',
                branch: 'main',
                branchPrefix: 'cpa/',
                worktreeRootDir: '/Users/test/.coding-professional-agent/worktrees',
                fetchUpstream: false,
                gitRunner: fakeGitRunner,
            })

            expect(result.branch).toMatch(/^cpa\/[0-9a-f]{8}$/)
            expect(result.isNewBranch).toBe(true)
            // Check that it was called with git worktree add -b cpa/xxx <path> main
            const prefixCall = gitCalls.find((c) => c.args[2] === '-b' && c.args[3]?.startsWith('cpa/'))
            expect(prefixCall).toBeDefined()
            expect(prefixCall?.args[5]).toBe('main')
        })
    })
})
