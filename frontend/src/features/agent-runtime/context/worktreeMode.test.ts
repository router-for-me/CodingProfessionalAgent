import { describe, expect, it } from 'vitest'
import {
    createWorktreeRunPolicy,
    formatWorktreeModePrompt,
    recoverWorktreeRunPolicy,
} from './worktreeMode'

describe('worktree mode policy', () => {
    it('validates, copies, and freezes a policy bound to projectCwd', () => {
        const input = {
            worktreePath: '/worktrees/repo-session',
            sourceTreePath: '/projects/repo',
        }
        const policy = createWorktreeRunPolicy(input, '/worktrees/repo-session/.')

        expect(policy).toEqual(input)
        expect(policy).not.toBe(input)
        expect(Object.isFrozen(policy)).toBe(true)
    })

    it('rejects relative, control-character, and mismatched worktree paths', () => {
        expect(() => createWorktreeRunPolicy({
            worktreePath: 'relative/worktree',
            sourceTreePath: '/projects/repo',
        }, '/worktrees/repo')).toThrow(/absolute/i)

        expect(() => createWorktreeRunPolicy({
            worktreePath: '/worktrees/repo\nmalicious',
            sourceTreePath: '/projects/repo',
        }, '/worktrees/repo')).toThrow(/control/i)

        expect(() => createWorktreeRunPolicy({
            worktreePath: '/worktrees/other',
            sourceTreePath: '/projects/repo',
        }, '/worktrees/repo')).toThrow(/projectCwd/i)
    })

    it('formats the exact shared worktree mode instructions', () => {
        const policy = createWorktreeRunPolicy({
            worktreePath: 'C:\\worktrees\\repo-session',
            sourceTreePath: 'C:\\projects\\repo',
        }, 'C:\\worktrees\\repo-session')

        expect(formatWorktreeModePrompt(policy)).toBe([
            '<worktree_mode>',
            'Git worktree mode is active.',
            'Worktree directory: C:/worktrees/repo-session',
            'Original source tree: C:/projects/repo',
            'All relative paths resolve from the worktree directory.',
            'Relative file reads must stay within the worktree directory.',
            'All file modifications must stay within the worktree directory.',
            'The original source tree is read-only. Read it only by passing an absolute path to read or a shell command.',
            'Never use .. or symbolic links to escape the worktree directory.',
            'Do not use bash or pwsh to modify the original source tree or any path outside the worktree directory.',
            '</worktree_mode>',
        ].join('\n'))
    })

    it('recovers a persisted policy and backfills a legacy source path from project paths', () => {
        expect(recoverWorktreeRunPolicy({
            worktreePath: '/worktrees/repo-session',
            sourceTreePath: '/repo',
            projectPaths: ['/repo'],
        })).toEqual({
            policy: {
                worktreePath: '/worktrees/repo-session',
                sourceTreePath: '/repo',
            },
            sourceTreePathRecovered: false,
        })

        expect(recoverWorktreeRunPolicy({
            worktreePath: '/worktrees/repo-session',
            projectPaths: ['/repo'],
        })).toEqual({
            policy: {
                worktreePath: '/worktrees/repo-session',
                sourceTreePath: '/repo',
            },
            sourceTreePathRecovered: true,
        })
    })

    it('fails closed when persisted worktree or source paths cannot be recovered', () => {
        expect(() => recoverWorktreeRunPolicy({
            sourceTreePath: '/repo',
            projectPaths: ['/repo'],
        })).toThrow(/worktreePath/i)
        expect(() => recoverWorktreeRunPolicy({
            worktreePath: '/worktrees/repo-session',
            projectPaths: [],
        })).toThrow(/sourceTreePath/i)
    })
})
