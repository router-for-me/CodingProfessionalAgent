import { describe, expect, it } from 'vitest'
import type { UtilityExecutorHandle } from '@cpa/plugin-api'
import { CellSessionHost } from './session.js'
import { CellExecutor } from './cells.js'

class FakeUtility implements UtilityExecutorHandle {
    messages: any[] = []
    kills = 0
    constructor(private autoReady = true) {}
    listener: (event: any) => void = () => {}
    exitListener: (code: number) => void = () => {}
    onMessage(listener: (event: any) => void) { this.listener = listener; if (this.autoReady) setTimeout(() => listener({ type: 'ready' }), 0) }
    onExit(listener: (code: number) => void) { this.exitListener = listener }
    onStderr() {}
    postMessage(command: any) {
        this.messages.push(command)
        if (command.type === 'start' || command.type === 'observe') queueMicrotask(() => this.listener({ type: 'observation', requestId: command.requestId, observation: { cellId: command.input.cellId, status: 'yielded', content: [] } }))
    }
    kill() { this.kills += 1; this.exitListener(0) }
}

class ControlledUtility extends FakeUtility {
    private executor = new CellExecutor(() => {})
    constructor() { super(false) }
    override postMessage(command: any) {
        this.messages.push(command)
        if (command.type === 'cancel') {
            this.executor.cancel(command.sessionId, command.cellId)
            queueMicrotask(() => this.listener({ type: 'cancelled', cancelId: command.cancelId }))
        }
        if (command.type === 'start') {
            void this.executor.start(command.input).then((observation) => this.listener({ type: 'observation', requestId: command.requestId, observation }))
        }
    }
    override kill() { this.executor.dispose(); super.kill() }
}
const start = { sessionId: 's', source: 'await tools.foo({})', tools: [{ name: 'foo', identifier: 'foo', description: '' }], yieldTimeMs: 1, maxOutputTokens: 1 }

describe('dedicated cell session supervisor', () => {
    it('rebinds an existing cell to another client and accepts the original pending tool response', async () => {
        const child = new FakeUtility()
        const events: any[] = []
        const host = new CellSessionHost((event) => events.push(event), async () => child)
        try {
            const cell = await host.start('exec-request', start, 'first-client')
            child.listener({ type: 'tool-request', request: { cellId: cell.cellId, invocationId: 'call', toolName: 'foo', input: {} } })
            const next = await host.observe('wait-request', { sessionId: 's', cellId: cell.cellId, yieldTimeMs: 1, maxOutputTokens: 1 }, 'second-client')
            expect(next.cellId).toBe(cell.cellId)
            expect(events).toContainEqual({ requestId: 'exec-request', event: { type: 'replaced' } })
            host.deliver('exec-request', 'wrong-client', 'call', { content: [] })
            expect(child.messages.filter((message) => message.type === 'tool-result')).toHaveLength(0)
            host.deliver('exec-request', 'first-client', 'call', { content: [] })
            expect(child.messages.filter((message) => message.type === 'tool-result')).toHaveLength(1)
            await expect(host.observe('wrong-session', { sessionId: 'other', cellId: cell.cellId, yieldTimeMs: 0, maxOutputTokens: 1 }, 'first-client')).rejects.toThrow('mismatch')
        } finally { host.dispose() }
    })
    it('survives utility exit, reports old cells missing, and forks again on exec', async () => {
        const children: FakeUtility[] = []
        const host = new CellSessionHost(() => {}, async () => { const child = new FakeUtility(); children.push(child); return child })
        try {
            const old = await host.start('first', start, 'owner')
            children[0]!.kill()
            expect((await host.observe('wait', { sessionId: 's', cellId: old.cellId, yieldTimeMs: 1, maxOutputTokens: 1 }, 'owner')).status).toBe('missing')
            expect((await host.start('second', start, 'owner')).cellId).not.toBe(old.cellId)
            expect(children).toHaveLength(2)
        } finally { host.dispose() }
    })
    it('session close clears cells while a replaced observer cannot cancel the new route', async () => {
        const child = new FakeUtility()
        const host = new CellSessionHost(() => {}, async () => child)
        try {
            const cell = await host.start('first', start, 'owner')
            await host.observe('second', { sessionId: 's', cellId: cell.cellId, yieldTimeMs: 1, maxOutputTokens: 1 }, 'new-owner')
            host.detach('first', 'owner')
            expect(child.messages.some((message) => message.type === 'cancel')).toBe(false)
            host.cancel('s')
            expect((await host.observe('third', { sessionId: 's', cellId: cell.cellId, yieldTimeMs: 1, maxOutputTokens: 1 }, 'new-owner')).status).toBe('missing')
        } finally { host.dispose() }
    })
})


it.each([
    ['cancel', 'fork'], ['cancel', 'ready'],
    ['cancelAll', 'fork'], ['cancelAll', 'ready'],
    ['dispose', 'fork'], ['dispose', 'ready'],
] as const)('%s prevents submitted scripts while awaiting %s', async (action, phase) => {
    const child = new ControlledUtility()
    let releaseFork!: (child: UtilityExecutorHandle) => void
    const fork = new Promise<UtilityExecutorHandle>((resolve) => { releaseFork = resolve })
    const host = new CellSessionHost(() => {}, () => fork)
    const source = 'store("afterCancellation",true)'
    const submission = host.start('cancelled', { ...start, source, tools: [] }, 'owner')
    try {
        if (phase === 'ready') { releaseFork(child); await Promise.resolve() }
        if (action === 'cancel') host.cancel('s')
        else if (action === 'cancelAll') host.cancelAll()
        else host.dispose()
        if (phase === 'fork') { releaseFork(child); await Promise.resolve() }
        child.listener({ type: 'ready' })
        const result = await submission
        expect(result.status).toBe('terminated')
        expect(child.messages.filter((command) => command.type === 'start')).toHaveLength(0)
        expect((await host.observe('old', { sessionId: 's', cellId: result.cellId, yieldTimeMs: 0, maxOutputTokens: 1 }, 'owner')).status).toBe('missing')
        if (action === 'dispose') {
            expect(child.kills).toBe(1)
            await expect(host.start('late', start, 'owner')).rejects.toThrow('disposed')
        } else {
            const next = await host.start('fresh', { ...start, source: 'text(load("afterCancellation") === undefined)', tools: [], yieldTimeMs: 200 }, 'owner')
            expect(next.status).toBe('completed')
            expect(next.content).toEqual([{ type: 'text', text: 'true' }])
        }
    } finally { host.dispose() }
})

it('session cancellation during startup does not cancel another session submission', async () => {
    const child = new ControlledUtility()
    const host = new CellSessionHost(() => {}, async () => child)
    try {
        const cancelled = host.start('cancelled', { ...start, source: 'store("afterCancellation",true)', tools: [] }, 'owner')
        const other = host.start('other', { ...start, sessionId: 'other', source: 'text(2)', tools: [], yieldTimeMs: 200 }, 'owner')
        host.cancel('s')
        await Promise.resolve()
        child.listener({ type: 'ready' })
        expect((await cancelled).status).toBe('terminated')
        expect((await other).content).toEqual([{ type: 'text', text: '2' }])
        expect(child.messages.filter((command) => command.type === 'start').map((command) => command.requestId)).toEqual(['other'])
    } finally { host.dispose() }
})
