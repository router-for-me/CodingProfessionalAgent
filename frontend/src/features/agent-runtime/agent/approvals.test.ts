import { describe, expect, it, vi } from 'vitest'
import {
    ApprovalController,
    TOOL_REJECTED_MESSAGE,
} from './approvals'

describe('ApprovalController', () => {
    it('approves a pending waiter once and cleans up', async () => {
        const controller = new ApprovalController()
        const pending = controller.waitForApproval('run-1', 'call-1')
        expect(controller.hasPending('run-1', 'call-1')).toBe(true)
        expect(controller.approve('run-1', 'call-1')).toBe(true)
        await expect(pending).resolves.toBe('approved')
        expect(controller.hasPending('run-1', 'call-1')).toBe(false)
        // Second approve is a no-op.
        expect(controller.approve('run-1', 'call-1')).toBe(false)
    })

    it('rejects with fixed error text constant', async () => {
        expect(TOOL_REJECTED_MESSAGE).toBe('Tool execution rejected by user')
        const controller = new ApprovalController()
        const pending = controller.waitForApproval('run-2', 'call-2')
        expect(controller.reject('run-2', 'call-2')).toBe(true)
        await expect(pending).resolves.toBe('rejected')
        expect(controller.reject('run-2', 'call-2')).toBe(false)
    })

    it('keys waiters by runId + toolCallId and isolates runs', async () => {
        const controller = new ApprovalController()
        const a = controller.waitForApproval('run-a', 'same-id')
        const b = controller.waitForApproval('run-b', 'same-id')
        expect(controller.pendingCount()).toBe(2)
        expect(controller.approve('run-a', 'same-id')).toBe(true)
        await expect(a).resolves.toBe('approved')
        expect(controller.hasPending('run-b', 'same-id')).toBe(true)
        expect(controller.reject('run-b', 'same-id')).toBe(true)
        await expect(b).resolves.toBe('rejected')
    })

    it('rejects duplicate waiters for the same key', async () => {
        const controller = new ApprovalController()
        const first = controller.waitForApproval('run-1', 'dup')
        await expect(controller.waitForApproval('run-1', 'dup')).rejects.toThrow(
            /duplicate/i,
        )
        controller.approve('run-1', 'dup')
        await expect(first).resolves.toBe('approved')
    })

    it('abortAll for one run only releases that run', async () => {
        const controller = new ApprovalController()
        const a = controller.waitForApproval('run-a', 't1')
        const b = controller.waitForApproval('run-b', 't1')
        controller.abortAll('run-a')
        await expect(a).resolves.toBe('aborted')
        expect(controller.hasPending('run-b', 't1')).toBe(true)
        controller.abortAll()
        await expect(b).resolves.toBe('aborted')
        expect(controller.pendingCount()).toBe(0)
    })

    it('unknown resolve is no-op/false', () => {
        const controller = new ApprovalController()
        expect(controller.approve('missing', 'x')).toBe(false)
        expect(controller.reject('missing', 'x')).toBe(false)
    })

    it('signal abort settles waiter and removes listener (no leak)', async () => {
        const controller = new ApprovalController()
        const ac = new AbortController()
        const addSpy = vi.spyOn(ac.signal, 'addEventListener')
        const removeSpy = vi.spyOn(ac.signal, 'removeEventListener')
        const pending = controller.waitForApproval('run-1', 'sig', ac.signal)
        expect(addSpy).toHaveBeenCalled()
        ac.abort()
        await expect(pending).resolves.toBe('aborted')
        expect(controller.hasPending('run-1', 'sig')).toBe(false)
        expect(removeSpy).toHaveBeenCalled()
    })

    it('pre-aborted signal resolves immediately without pending waiter', async () => {
        const controller = new ApprovalController()
        const ac = new AbortController()
        ac.abort()
        await expect(
            controller.waitForApproval('run-1', 'pre', ac.signal),
        ).resolves.toBe('aborted')
        expect(controller.pendingCount()).toBe(0)
    })

    it('queued approvals can be resolved independently', async () => {
        const controller = new ApprovalController()
        const p1 = controller.waitForApproval('run-q', 'c1')
        const p2 = controller.waitForApproval('run-q', 'c2')
        const p3 = controller.waitForApproval('run-q', 'c3')
        expect(controller.reject('run-q', 'c2')).toBe(true)
        expect(controller.approve('run-q', 'c3')).toBe(true)
        expect(controller.approve('run-q', 'c1')).toBe(true)
        await expect(Promise.all([p1, p2, p3])).resolves.toEqual([
            'approved',
            'rejected',
            'approved',
        ])
    })

    it('supports NUL characters inside runId and toolCallId without key collision', async () => {
        const controller = new ApprovalController()
        const runA = 'run\u0000shared'
        const runB = 'run'
        const toolB = '\u0000shared'

        // Nested map must not treat ("run\0shared", "x") as ("run", "shared\0x").
        const p1 = controller.waitForApproval(runA, 'x')
        const p2 = controller.waitForApproval(runB, toolB)
        const p3 = controller.waitForApproval('plain', 'call\u0000id')

        expect(controller.pendingCount()).toBe(3)
        expect(controller.hasPending(runA, 'x')).toBe(true)
        expect(controller.hasPending(runB, toolB)).toBe(true)
        expect(controller.hasPending(runB, 'shared')).toBe(false)

        expect(controller.approve(runA, 'x')).toBe(true)
        expect(controller.reject(runB, toolB)).toBe(true)
        expect(controller.approve('plain', 'call\u0000id')).toBe(true)

        await expect(Promise.all([p1, p2, p3])).resolves.toEqual([
            'approved',
            'rejected',
            'approved',
        ])
        expect(controller.pendingCount()).toBe(0)

        // Same visual NUL-concat collision pair still isolates correctly.
        const again = controller.waitForApproval('a\u0000b', 'c')
        expect(controller.hasPending('a', 'b\u0000c')).toBe(false)
        expect(controller.approve('a\u0000b', 'c')).toBe(true)
        await expect(again).resolves.toBe('approved')
    })
})
