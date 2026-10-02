import { describe, expect, it } from 'vitest'
import { runQuickJSSmoke } from './quickjsSmoke.mjs'

describe('QuickJS-ng sync WASM guest promise gate', () => {
    it('evaluates arithmetic and awaits a genuinely asynchronous host callback', async () => {
        expect(await runQuickJSSmoke()).toEqual({ sum: 2, callback: 42, callbackCount: 1, asyncResolved: true })
    })
})
