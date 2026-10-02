const { app, utilityProcess } = require('electron')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const assert = require('node:assert/strict')

// Main only exercises the supervisor and forwards messages, never imports WASM.
app.whenReady().then(async () => {
    const moduleUrl = pathToFileURL(path.join(__dirname, '../dist-electron/plugins/bundled/cpa.core.code-mode/main/session.js'))
    const { CellSessionHost } = await import(moduleUrl.href)
    let child
    const calls = []
    const host = new CellSessionHost((payload) => {
        if (payload.event.type !== 'tool-request') return
        const request = payload.event.request
        calls.push({ requestId: payload.requestId, request })
        if (calls.length === 2) for (const call of calls) setTimeout(() => host.deliver(call.requestId, 'owner', call.request.invocationId, { content: [{ type: 'text', text: 'async result' }] }), 10)
    }, async () => {
        const current = utilityProcess.fork(path.join(__dirname, '../dist-electron/plugins/bundled/cpa.core.code-mode/main/executor.js'), [], { stdio: 'pipe', serviceName: 'Code cell contract smoke' })
        child = current
        return {
            postMessage: (message) => current.postMessage(message),
            onMessage: (listener) => current.on('message', listener),
            onExit: (listener) => current.on('exit', listener),
            onStderr: (listener) => current.stderr.on('data', (data) => listener(String(data))),
            kill: () => current.kill(),
        }
    })
    const watchdog = setTimeout(() => { host.dispose(); console.error('Cell contract smoke timed out'); app.exit(1) }, 20000)
    const input = (source, sessionId = 'session', yieldTimeMs = 500) => ({ sessionId, source, tools: [{ name: 'read', identifier: 'read', description: '' }], yieldTimeMs, maxOutputTokens: 1000 })
    const text = (result) => result.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
    try {
        const parallel = await host.start('parallel', input('const results=await Promise.all([tools.read({path:"a"}),tools.read({path:"b"})]); text(results.length)'), 'owner')
        assert.equal(parallel.status, 'completed')
        assert.equal(text(parallel), '2')
        assert.equal(calls.length, 2)
        await host.start('save', input('store("key", {value:42})'), 'owner')
        assert.equal(text(await host.start('load', input('text(load("key").value)'), 'owner')), '42')
        assert.equal(text(await host.start('isolated', input('text(load("key") === undefined)', 'another'), 'owner')), 'true')
        const yielded = await host.start('yield', input('text("first"); await yield_control(); await new Promise(r=>setTimeout(r,20)); text("later")'), 'owner')
        assert.equal(yielded.status, 'yielded')
        assert.equal(text(yielded), 'first')
        const observed = await host.observe('reconnected-wait', { sessionId: 'session', cellId: yielded.cellId, yieldTimeMs: 500, maxOutputTokens: 1000 }, 'second-client')
        assert.equal(observed.status, 'completed')
        assert.equal(text(observed), 'later')
        const loop = await host.start('loop', input('while(true) {}', 'session', 10), 'owner')
        assert.equal(loop.status, 'terminated')
        assert.match(loop.error, /cannot be resumed/)
        host.cancel('session')
        assert.equal((await host.observe('deleted', { sessionId: 'session', cellId: yielded.cellId, yieldTimeMs: 0, maxOutputTokens: 1000 }, 'owner')).status, 'missing')
        const old = await host.start('old', input('await new Promise(()=>{})', 'session', 1), 'owner')
        child.kill()
        await new Promise((resolve) => setTimeout(resolve, 100))
        assert.equal((await host.observe('missing', { sessionId: 'session', cellId: old.cellId, yieldTimeMs: 0, maxOutputTokens: 1 }, 'owner')).status, 'missing')
        assert.equal(text(await host.start('restart', input('text(load("key") === undefined)'), 'owner')), 'true')
        const blocked = host.start('cancel-blocked', input('while(true) {}', 'session', 5000), 'owner')
        setTimeout(() => host.cancel('session'), 20)
        await assert.rejects(blocked, /executor exited/)
        assert.equal(text(await host.start('after-cancel', input('text(2)'), 'owner')), '2')
        console.log(JSON.stringify({ phase: 'passed', parallelCalls: calls.length, storeIsolation: true, incrementalWait: true, syncLoopTerminated: true, utilityRestart: true, blockedCancellation: true }))
        clearTimeout(watchdog)
        host.dispose()
        app.exit(0)
    } catch (error) {
        clearTimeout(watchdog)
        host.dispose()
        console.error(error)
        app.exit(1)
    }
}).catch((error) => { console.error(error); app.exit(1) })
