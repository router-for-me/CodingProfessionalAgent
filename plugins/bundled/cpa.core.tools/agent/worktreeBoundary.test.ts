import { describe, expect, it, vi } from 'vitest'
import { FakeNativeBridge } from './testUtils.js'
import {
    assertModificationWithinWorktree,
    assertRelativeReadWithinWorktree,
    createWorktreeFileBoundary,
} from './worktreeBoundary.js'

describe('worktree file boundary', () => {
    it('allows relative reads inside the worktree and explicit absolute reads outside', async () => {
        const bridge = new FakeNativeBridge()
        const boundary = await createWorktreeFileBoundary({
            worktreePath: '/worktrees/repo',
        }, bridge)

        await expect(assertRelativeReadWithinWorktree({
            requestedPath: 'src/a.ts',
            resolvedPath: '/worktrees/repo/src/a.ts',
            boundary,
            bridge,
        })).resolves.toBeUndefined()

        await expect(assertRelativeReadWithinWorktree({
            requestedPath: '/projects/repo/src/a.ts',
            resolvedPath: '/projects/repo/src/a.ts',
            boundary,
            bridge,
        })).resolves.toBeUndefined()
    })

    it('rejects lexical parent traversal for relative reads and all modifications', async () => {
        const bridge = new FakeNativeBridge()
        const boundary = await createWorktreeFileBoundary({
            worktreePath: '/worktrees/repo',
        }, bridge)

        await expect(assertRelativeReadWithinWorktree({
            requestedPath: '../repo/src/a.ts',
            resolvedPath: '/worktrees/repo/src/a.ts',
            boundary,
            bridge,
        })).resolves.toBeUndefined()

        await expect(assertRelativeReadWithinWorktree({
            requestedPath: '../outside/a.ts',
            resolvedPath: '/worktrees/outside/a.ts',
            boundary,
            bridge,
        })).rejects.toThrow(/Relative read paths must stay within/)

        await expect(assertModificationWithinWorktree({
            resolvedPath: '/projects/repo/src/a.ts',
            boundary,
            bridge,
        })).rejects.toThrow(/File modifications must stay within/)
    })

    it('rejects a realPath symlink escape and a new file below an external symlink', async () => {
        const bridge = new FakeNativeBridge()
        const realPath = vi.spyOn(bridge, 'realPath').mockImplementation(async (path) => {
            if (path === '/worktrees/repo') return '/real/worktrees/repo'
            if (path === '/worktrees/repo/link/file.ts') return '/projects/repo/file.ts'
            if (path === '/worktrees/repo/link/new/file.ts') {
                throw Object.assign(new Error('missing'), { code: 'ENOENT' })
            }
            if (path === '/worktrees/repo/link/new') {
                throw Object.assign(new Error('missing'), { code: 'ENOENT' })
            }
            if (path === '/worktrees/repo/link') return '/projects/repo'
            return path.replace('/worktrees/repo', '/real/worktrees/repo')
        })
        const boundary = await createWorktreeFileBoundary({
            worktreePath: '/worktrees/repo',
        }, bridge)

        await expect(assertRelativeReadWithinWorktree({
            requestedPath: 'link/file.ts',
            resolvedPath: '/worktrees/repo/link/file.ts',
            boundary,
            bridge,
        })).rejects.toThrow(/Relative read paths must stay within/)

        await expect(assertModificationWithinWorktree({
            resolvedPath: '/worktrees/repo/link/new/file.ts',
            boundary,
            bridge,
        })).rejects.toThrow(/File modifications must stay within/)

        expect(realPath).toHaveBeenCalled()
    })
})
