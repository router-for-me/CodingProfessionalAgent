import { afterEach, describe, expect, it } from 'vitest'
import { CellExecutor } from './cells.js'
import type { CellObservation, StartCell } from '../shared/messages.js'

const executors: CellExecutor[] = []
afterEach(() => { for (const executor of executors.splice(0)) executor.dispose() })
const input = (source: string, extra: Partial<StartCell> = {}): StartCell => ({ sessionId: 'one', source, tools: [], yieldTimeMs: 200, maxOutputTokens: 1000, ...extra })
const text = (observation: CellObservation) => observation.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
const create = () => {
    const executor = new CellExecutor((request) => {
        setTimeout(() => executor.deliver(request.invocationId, { content: [{ type: 'text', text: String(request.input) }] }), 10)
    })
    executors.push(executor)
    return executor
}

describe('QuickJS-ng sync WASM cells with guest promises', () => {
    it('awaits an asynchronous nested tool', async () => {
        const observation = await create().start(input('text((await tools.foo(42)).content[0].text)', { tools: [{ name: 'original', identifier: 'foo', description: '' }] }))
        expect(observation.status).toBe('completed')
        expect(text(observation)).toBe('42')
    })
    it('starts both Promise.all host calls before either settles', async () => {
        const requests: string[] = []
        const executor = new CellExecutor((request) => {
            requests.push(request.invocationId)
            if (requests.length === 2) for (const id of requests) setTimeout(() => executor.deliver(id, { content: [{ type: 'text', text: 'ok' }] }), 5)
        })
        executors.push(executor)
        const observation = await executor.start(input('const values = await Promise.all([tools.foo({}),tools.foo({})]); text(values.length)', { tools: [{ name: 'foo', identifier: 'foo', description: '' }] }))
        expect(observation.status).toBe('completed')
        expect(text(observation)).toBe('2')
        expect(requests).toHaveLength(2)
    })
    it('terminates a synchronous infinite loop at the yield deadline', async () => {
        const executor = create()
        const result = await executor.start(input('while(true) {}', { yieldTimeMs: 10 }))
        expect(result.status).toBe('terminated')
        expect(result.error).toContain('cannot be resumed')
        expect((await executor.start(input('text(2)'))).status).toBe('completed')
    })
    it('shares cloned store data only within one session', async () => {
        const executor = create()
        await executor.start(input('store("key", {value: 1})'))
        expect(text(await executor.start(input('const data = load("key"); data.value=3; text(load("key").value)')))).toBe('1')
        expect(text(await executor.start(input('text(load("key") === undefined)', { sessionId: 'two' })))).toBe('true')
        executor.cancel('one')
        expect(text(await executor.start(input('text(load("key") === undefined)')))).toBe('true')
    })
    it('yields while awaiting then returns only later output', async () => {
        const executor = create()
        const first = await executor.start(input('text("first"); await yield_control(); await new Promise(r=>setTimeout(r,15)); text("later")'))
        expect(first.status).toBe('yielded')
        expect(text(first)).toBe('first')
        const last = await executor.observe({ sessionId: 'one', cellId: first.cellId, yieldTimeMs: 200, maxOutputTokens: 1000 })
        expect(last.status).toBe('completed')
        expect(text(last)).toBe('later')
        expect(text(await executor.observe({ sessionId: 'one', cellId: first.cellId, yieldTimeMs: 1, maxOutputTokens: 1000 }))).toBe('')
    })
    it('supports explicit terminate and session isolation for wait', async () => {
        const executor = create()
        const first = await executor.start(input('await new Promise(()=>{})', { yieldTimeMs: 1 }))
        expect((await executor.observe({ sessionId: 'two', cellId: first.cellId, yieldTimeMs: 0, maxOutputTokens: 1 })).status).toBe('missing')
        expect((await executor.observe({ sessionId: 'one', cellId: first.cellId, terminate: true, yieldTimeMs: 0, maxOutputTokens: 1 })).status).toBe('terminated')
    })
    it('exit completes without subsequent output', async () => {
        const result = await create().start(input('text("before"); exit(); text("after")'))
        expect(result.status).toBe('completed')
        expect(text(result)).toBe('before')
    })
    it('unawaited timers do not keep the cell alive', async () => {
        expect(text(await create().start(input('setTimeout(()=>text("late"), 0); text("now")')))).toBe('now')
    })
    it('rejects static and dynamic import', async () => {
        expect((await create().start(input('import x from "fs"'))).status).toBe('failed')
        expect((await create().start(input('await import("fs")'))).status).toBe('failed')
    })
    it('enforces atomic single-value and session store budgets', async () => {
        const executor = create()
        await executor.start(input('store("key", "original")'))
        expect((await executor.start(input('store("key", "a".repeat(300000))'))).status).toBe('failed')
        expect(text(await executor.start(input('text(load("key"))')))).toBe('original')
        expect((await executor.start(input('for(let i=0;i<20;i++) store(String(i),"a".repeat(250000))'))).status).toBe('failed')
    })
    it('does not expose Node, network, console or WASM globals', async () => {
        expect(text(await create().start(input('text([typeof process,typeof require,typeof fetch,typeof console,typeof WebAssembly,typeof Atomics].join(","))')))).toBe('undefined,undefined,undefined,undefined,undefined,undefined')
    })
    it('rejects unknown tools with a catchable guest promise', async () => {
        expect(text(await create().start(input('try {await tools.unknown({})} catch(e) {text(e.message)}')))).toContain('Unknown nested tool')
    })
    it('releases the runtime on memory exhaustion without losing the host', async () => {
        const executor = new CellExecutor(() => {}, () => {}, () => {}, 2 * 1024 * 1024)
        executors.push(executor)
        expect((await executor.start(input('const a=[]; for(let i=0;i<1000000;i++) a.push({i})'))).status).toBe('failed')
        expect((await executor.start(input('text(2)'))).status).toBe('completed')
    })
    it('bounds output with an approximate token budget', async () => {
        const result = await create().start(input('text("abcdefghijk")', { maxOutputTokens: 1 }))
        expect(text(result)).toContain('abcd')
        expect(text(result)).toContain('truncated')
    })
})


it('notify emits live output without consuming the final observation', async () => {
    const updates: CellObservation[] = []
    const executor = new CellExecutor(() => {}, (_cellId, observation) => updates.push(observation))
    executors.push(executor)
    const result = await executor.start(input('notify("live"); text(undefined)'))
    expect(text(updates[0]!)).toBe('live')
    expect(text(result)).toBe('live\nundefined')
})

it('rejects failed tools through a catchable real guest promise', async () => {
    const executor = new CellExecutor((request) => setTimeout(() => executor.deliver(request.invocationId, { content: [{ type: 'text', text: 'approval denied' }], isError: true }), 10))
    executors.push(executor)
    const result = await executor.start(input('try { await tools.foo({}); } catch(error) {text(error.message)}', { tools: [{ name: 'foo', identifier: 'foo', description: '' }] }))
    expect(result.status).toBe('completed')
    expect(text(result)).toBe('approval denied')
})

it('timer callback errors release the cell without crashing the host', async () => {
    const executor = create()
    const result = await executor.start(input('await new Promise(resolve => setTimeout(()=>{throw new Error("timer error")}, 1))'))
    expect(result.status).toBe('failed')
    expect(result.error).toContain('timer error')
    expect((await executor.start(input('text(2)'))).status).toBe('completed')
})


it('bounds outstanding tool promises instead of flooding host approvals', async () => {
    const executor = create()
    const result = await executor.start(input('await Promise.all(Array.from({length:33}, () => tools.foo({})))', { tools: [{ name: 'foo', identifier: 'foo', description: '' }] }))
    expect(result.status).toBe('failed')
    expect(result.error).toContain('32 outstanding')
})


it('exit cannot be caught to keep a cell alive or mutate its store afterward', async () => {
    const executor = create()
    const result = await executor.start(input('store("before",1); try {exit()} catch {} try {store("after",2)} catch {} await new Promise(()=>{})'))
    expect(result.status).toBe('completed')
    expect(text(await executor.start(input('text([load("before"),load("after")])')))).toBe('[1,null]')
})


it('cancels concurrent initializing cells before source or store effects run', async () => {
    const executor = create()
    const first = executor.start(input('store("afterCancellation",true)'))
    const second = executor.start(input('store("afterCancellation",true)'))
    const other = executor.start(input('store("unaffected",true)', { sessionId: 'other' }))
    executor.cancel('one')
    expect((await first).status).toBe('terminated')
    expect((await second).status).toBe('terminated')
    expect((await other).status).toBe('completed')
    expect(text(await executor.start(input('text(load("afterCancellation") === undefined)')))).toBe('true')
    expect(text(await executor.start(input('text(load("unaffected"))', { sessionId: 'other' })))).toBe('true')
})

it('disposal cancels initialization before any script runs', async () => {
    const executor = create()
    const starting = executor.start(input('store("afterCancellation",true)'))
    executor.dispose()
    expect((await starting).status).toBe('terminated')
    expect(text(await executor.start(input('text(load("afterCancellation") === undefined)')))).toBe('true')
})


it.each(['spawn_agent', 'send_message', 'send_input', 'stop_agent'])('blocks forged nested specifications for %s before dispatch', async (name) => {
    const requests: unknown[] = []
    const executor = new CellExecutor((request) => requests.push(request))
    executors.push(executor)
    const result = await executor.start(input('try { await tools.alias({}) } catch (error) { text(error.message) }', { tools: [{ name, identifier: 'alias', description: '' }] }))
    expect(result.status).toBe('completed')
    expect(text(result)).toContain('direct-only: ' + name)
    expect(requests).toEqual([])
})
