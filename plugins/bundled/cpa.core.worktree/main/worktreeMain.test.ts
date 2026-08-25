import { describe, expect, it, vi } from 'vitest'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'
import { createPluginTestHarness } from '@cpa/plugin-sdk'
import { worktreeMainEntry, WorktreeCoordinationService } from './index.js'
import manifest from '../manifest.json' with { type: 'json' }

describe('cpa.core.worktree main entry', () => {
    it('activates and registers coordination service and RPCs', async () => {
        const harness = createPluginTestHarness(worktreeMainEntry, {
            manifest,
        })

        await harness.activate()

        // 1. Check registered services
        const serviceRegs = harness.registrations.filter((r) => r.kind === 'service')
        expect(serviceRegs.some((r) => r.id === 'worktreeCoordinationService')).toBe(true)

        // 2. Check registered RPC descriptors
        const rpcRegs = harness.registrations.filter((r) => r.kind === 'rpc')
        const rpcMethods = rpcRegs.map((r) => r.id)
        expect(rpcMethods).toContain('worktree:setup')
        expect(rpcMethods).toContain('worktree:list')
        expect(rpcMethods).toContain('worktree:delete')
        expect(rpcMethods).toContain('worktree:resolve-root')

        // 3. Test resolve-root RPC execution
        const resolveRpc = rpcRegs.find((r) => r.id === 'worktree:resolve-root')
        const resolved = await (resolveRpc?.value as any)?.invoke({}, ['~/test-wt'])
        expect(resolved).toBe(path.join(os.homedir(), 'test-wt'))

        // 4. Deactivate cleanly
        await harness.deactivate()
    })

    it('WorktreeCoordinationService handles root dir resolution without hardcoded luis codex paths', () => {
        const service = new WorktreeCoordinationService()
        const resolvedDefault = service.resolveRootDir()
        expect(resolvedDefault).toBe(path.join(os.homedir(), '.coding-professional-agent', 'worktrees'))
        expect(resolvedDefault).not.toContain('/Users/luis/.codex/worktrees')

        const resolvedCustom = service.resolveRootDir('/var/custom/wt')
        expect(resolvedCustom).toBe('/var/custom/wt')

        const resolvedTilde = service.resolveRootDir('~/my-worktrees')
        expect(resolvedTilde).toBe(path.join(os.homedir(), 'my-worktrees'))
    })

    it('WorktreeCoordinationService lists worktrees by scanning git directory structures', async () => {
        const tempDir = path.join(os.tmpdir(), `wt-test-${Date.now()}`)
        const repoDir = path.join(tempDir, 'repo')
        const wt1Dir = path.join(tempDir, 'wt1')
        const gitDir = path.join(repoDir, '.git', 'worktrees', 'wt1')

        fs.mkdirSync(gitDir, { recursive: true })
        fs.mkdirSync(wt1Dir, { recursive: true })

        fs.writeFileSync(path.join(wt1Dir, '.git'), `gitdir: ${gitDir}\n`)
        fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/feat/test-branch\n')
        fs.writeFileSync(path.join(gitDir, 'commondir'), '../..\n')

        const service = new WorktreeCoordinationService()
        const list = await service.listWorktrees(tempDir)

        expect(list).toHaveLength(1)
        expect(list[0].name).toBe('wt1')
        expect(list[0].branch).toBe('feat/test-branch')
        expect(list[0].mainRepo).toBe('repo')

        // Clean up
        fs.rmSync(tempDir, { recursive: true, force: true })
    })

    it('WorktreeCoordinationService deletes worktree directories', async () => {
        const tempDir = path.join(os.tmpdir(), `wt-delete-${Date.now()}`)
        const wtDir = path.join(tempDir, 'to-delete')
        fs.mkdirSync(wtDir, { recursive: true })
        expect(fs.existsSync(wtDir)).toBe(true)

        const service = new WorktreeCoordinationService()
        const result = await service.deleteWorktree(wtDir)

        expect(result.ok).toBe(true)
        expect(fs.existsSync(wtDir)).toBe(false)

        fs.rmSync(tempDir, { recursive: true, force: true })
    })
})
