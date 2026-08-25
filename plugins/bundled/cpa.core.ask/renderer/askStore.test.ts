import { describe, it, expect, beforeEach } from 'vitest'
import {
    defaultAskController,
    useAskStore,
    __resetAskStoreForTests,
} from '../shared/askStore.js'
import type { AskRequest } from '../shared/types.js'

describe('AskController and AskStore (cpa.core.ask/renderer)', () => {
    beforeEach(() => {
        __resetAskStoreForTests()
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
