import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
    AskController,
    defaultAskController,
    useAskStore,
    __resetAskStoreForTests,
} from '../shared/askStore.js'
import type { AskRequest } from '../shared/types.js'

describe('AskController and AskStore (cpa.core.ask/renderer)', () => {
    beforeEach(() => {
        __resetAskStoreForTests()
    })

    afterEach(() => {
        __resetAskStoreForTests()
        vi.useRealTimers()
    })

    it('does not allocate session maps for already aborted signals', async () => {
        vi.useFakeTimers()
        const controller = new AskController()
        const signalController = new AbortController()
        signalController.abort()
        for (const sessionId of ['s1', 's2', 's3']) {
            await expect(controller.waitForAnswer(sessionId, 'c', signalController.signal, {
                timeoutMs: 180_000, decision: { type: 'skipped' },
            })).resolves.toEqual({ type: 'aborted' })
        }
        // Inspect retained session state without adding a production-only diagnostic API.
        const waiters = Reflect.get(controller, 'waiters') as Map<string, unknown>
        expect(waiters.size).toBe(0)
        expect(vi.getTimerCount()).toBe(0)
    })

    it('clears only the request owning the unique request ID', () => {
        const request: AskRequest = {
            id: 'new', sessionId: 's', toolCallId: 'shared-call', question: 'New', options: [],
            allowCustom: true, allowSkip: true, createdAt: Date.now(),
        }
        useAskStore.getState().setRequest('s', request)
        useAskStore.getState().clearRequest('s', 'old')
        expect(useAskStore.getState().getRequest('s')).toBe(request)
        useAskStore.getState().clearRequest('s', 'new')
        expect(useAskStore.getState().getRequest('s')).toBeUndefined()
    })

    it('resolves a timeout and cleans up its timer', async () => {
        vi.useFakeTimers()
        const decision = { type: 'timeout' as const, option: { title: 'A' }, index: 0 }
        const pending = defaultAskController.waitForAnswer('s', 'c', undefined, { timeoutMs: 180_000, decision })
        await vi.advanceTimersByTimeAsync(180_000)
        await expect(pending).resolves.toEqual(decision)
        expect(vi.getTimerCount()).toBe(0)
    })

    it('cancels only the countdown and keeps waiting for an answer', async () => {
        vi.useFakeTimers()
        const pending = defaultAskController.waitForAnswer('s', 'c', undefined, {
            timeoutMs: 180_000, decision: { type: 'timeout', option: { title: 'A' }, index: 0 },
        })
        const resolved = vi.fn()
        void pending.then(resolved)
        expect(defaultAskController.cancelCountdown('s', 'wrong')).toBe(false)
        expect(defaultAskController.cancelCountdown('s', 'c')).toBe(true)
        expect(defaultAskController.cancelCountdown('s', 'c')).toBe(false)
        await vi.advanceTimersByTimeAsync(180_000)
        expect(resolved).not.toHaveBeenCalled()
        defaultAskController.submitAnswer('s', 'c', { type: 'skipped' })
        await expect(pending).resolves.toEqual({ type: 'skipped' })
    })

    it('replaces a different call in the same session and releases its timer without affecting other sessions', async () => {
        vi.useFakeTimers()
        const signalController = new AbortController()
        const removeAbortListener = vi.spyOn(signalController.signal, 'removeEventListener')
        const countdown = { timeoutMs: 180_000, decision: { type: 'timeout' as const, option: { title: 'Default' }, index: 0 } }
        const first = defaultAskController.waitForAnswer('s', 'a', signalController.signal, countdown)
        const firstResolved = vi.fn()
        void first.then(firstResolved)
        const otherSession = defaultAskController.waitForAnswer('other', 'a', undefined, countdown)
        const otherResolved = vi.fn()
        void otherSession.then(otherResolved)
        await vi.advanceTimersByTimeAsync(60_000)
        const second = defaultAskController.waitForAnswer('s', 'b', undefined, countdown)
        const secondResolved = vi.fn()
        void second.then(secondResolved)
        await vi.advanceTimersByTimeAsync(0)
        expect(firstResolved).toHaveBeenCalledExactlyOnceWith({ type: 'cancelled' })
        expect(removeAbortListener).toHaveBeenCalledWith('abort', expect.any(Function))
        expect(vi.getTimerCount()).toBe(2)
        expect(defaultAskController.cancelCountdown('s', 'a')).toBe(false)
        expect(defaultAskController.submitAnswer('s', 'a', { type: 'skipped' })).toBe(false)
        expect(otherResolved).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(120_001)
        expect(firstResolved).toHaveBeenCalledExactlyOnceWith({ type: 'cancelled' })
        await expect(first).resolves.toEqual({ type: 'cancelled' })
        await expect(otherSession).resolves.toEqual(countdown.decision)
        expect(secondResolved).not.toHaveBeenCalled()
        expect(vi.getTimerCount()).toBe(1)
        defaultAskController.cancel('s', 'b')
        await expect(second).resolves.toEqual({ type: 'cancelled' })
        expect(vi.getTimerCount()).toBe(0)
    })

    it('clears timers on abort and waiter replacement', async () => {
        vi.useFakeTimers()
        const countdown = { timeoutMs: 180_000, decision: { type: 'skipped' as const } }
        const first = defaultAskController.waitForAnswer('s', 'c', undefined, countdown)
        const second = defaultAskController.waitForAnswer('s', 'c', undefined, countdown)
        await expect(first).resolves.toEqual({ type: 'cancelled' })
        expect(vi.getTimerCount()).toBe(1)
        defaultAskController.abortSession('s')
        await expect(second).resolves.toEqual({ type: 'aborted' })
        expect(vi.getTimerCount()).toBe(0)
    })

    it('cancels the stored deadline only for the matching request without resolving it', async () => {
        vi.useFakeTimers()
        const request: AskRequest = {
            id: 'r', sessionId: 's', toolCallId: 'c', question: 'Pick', options: [{ title: 'A' }],
            allowCustom: true, allowSkip: true, createdAt: Date.now(), countdownDeadline: Date.now() + 180_000,
        }
        useAskStore.getState().setRequest('s', request)
        const pending = defaultAskController.waitForAnswer('s', 'c', undefined, {
            timeoutMs: 180_000, decision: { type: 'timeout', option: request.options[0], index: 0 },
        })
        const resolved = vi.fn()
        void pending.then(resolved)
        useAskStore.getState().cancelCountdown('s', 'stale-call')
        expect(useAskStore.getState().getRequest('s')).toBe(request)
        useAskStore.getState().cancelCountdown('s', 'c')
        expect(useAskStore.getState().getRequest('s')?.countdownDeadline).toBeUndefined()
        expect(useAskStore.getState().getRequest('s')?.toolCallId).toBe('c')
        await vi.advanceTimersByTimeAsync(180_000)
        expect(resolved).not.toHaveBeenCalled()
        useAskStore.getState().submitAnswer('s', 'c', { type: 'custom', text: 'Later' })
        await expect(pending).resolves.toEqual({ type: 'custom', text: 'Later' })
        expect(vi.getTimerCount()).toBe(0)
    })

    it('manages request state per session', () => {
        const req: AskRequest = {
            id: 'req-1',
            toolCallId: 'call-1',
            sessionId: 'sess-1',
            question: 'What is your favorite color?',
            options: [{ title: 'Red' }, { title: 'Blue' }],
            allowCustom: true,
            allowSkip: true,
            createdAt: Date.now(),
        }

        useAskStore.getState().setRequest('sess-1', req)
        expect(useAskStore.getState().getRequest('sess-1')).toEqual(req)

        useAskStore.getState().setRequest('sess-1', null)
        expect(useAskStore.getState().getRequest('sess-1')).toBeUndefined()
    })

    it('resolves waitForAnswer when submitAnswer is called with selected option', async () => {
        const promise = defaultAskController.waitForAnswer('sess-1', 'call-1')

        defaultAskController.submitAnswer('sess-1', 'call-1', {
            type: 'selected',
            option: { title: 'Option A', description: 'Desc A' },
            index: 0,
        })

        const result = await promise
        expect(result).toEqual({
            type: 'selected',
            option: { title: 'Option A', description: 'Desc A' },
            index: 0,
        })
    })

    it('resolves waitForAnswer when submitAnswer is called with custom text', async () => {
        const promise = defaultAskController.waitForAnswer('sess-1', 'call-2')

        defaultAskController.submitAnswer('sess-1', 'call-2', {
            type: 'custom',
            text: 'My custom answer',
        })

        const result = await promise
        expect(result).toEqual({
            type: 'custom',
            text: 'My custom answer',
        })
    })

    it('resolves with cancelled when cancel is called', async () => {
        const promise = defaultAskController.waitForAnswer('sess-1', 'call-3')
        defaultAskController.cancel('sess-1', 'call-3')

        const result = await promise
        expect(result).toEqual({ type: 'cancelled' })
    })

    it('resolves with aborted when signal is aborted', async () => {
        const controller = new AbortController()
        const promise = defaultAskController.waitForAnswer(
            'sess-1',
            'call-4',
            controller.signal
        )

        controller.abort()
        const result = await promise
        expect(result).toEqual({ type: 'aborted' })
    })

    it('resolves with aborted when abortSession is called', async () => {
        const promise1 = defaultAskController.waitForAnswer('sess-1', 'call-5')
        const promise2 = defaultAskController.waitForAnswer('sess-2', 'call-6')

        defaultAskController.abortSession('sess-1')

        const result1 = await promise1
        expect(result1).toEqual({ type: 'aborted' })

        defaultAskController.submitAnswer('sess-2', 'call-6', { type: 'skipped' })
        const result2 = await promise2
        expect(result2).toEqual({ type: 'skipped' })
    })

    it('submits answer through useAskStore helper and clears active request', async () => {
        const req: AskRequest = {
            id: 'req-7',
            toolCallId: 'call-7',
            sessionId: 'sess-7',
            question: 'Pick one',
            options: [{ title: 'One' }],
            allowCustom: true,
            allowSkip: true,
            createdAt: Date.now(),
        }

        useAskStore.getState().setRequest('sess-7', req)
        const promise = defaultAskController.waitForAnswer('sess-7', 'call-7')

        useAskStore.getState().submitAnswer('sess-7', 'call-7', {
            type: 'selected',
            option: { title: 'One' },
            index: 0,
        })

        const result = await promise
        expect(result).toEqual({
            type: 'selected',
            option: { title: 'One' },
            index: 0,
        })
        expect(useAskStore.getState().getRequest('sess-7')).toBeUndefined()
    })
})
