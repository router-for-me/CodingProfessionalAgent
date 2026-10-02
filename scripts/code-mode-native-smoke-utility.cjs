const assert = require('node:assert/strict')

function report(phase, details = {}) {
    const message = { phase, ...details }
    process.parentPort.postMessage(message)
    // Preserve the last checkpoint even if native code crashes immediately after it.
    process.stderr.write(`${JSON.stringify(message)}\n`)
}

async function run() {
    assert.ok(process.parentPort, 'This test requires a real Electron utility process')
    assert.ok(process.versions.electron.startsWith('44.'))
    report('loading-addon', { versions: process.versions, pid: process.pid })
    // The main process never imports the addon or creates an isolate.
    const ivm = require(process.argv[2]).ivm
    report('creating-isolate')
    const isolate = new ivm.Isolate({ memoryLimit: 128 })
    try {
        report('creating-context')
        const context = await isolate.createContext()
        report('evaluating-sum')
        const sum = await context.eval('1 + 1', { timeout: 1000 })
        assert.equal(sum, 2)
        report('installing-callback', { sum })
        let callbackCalls = 0
        await context.global.set('hostCallback', new ivm.Callback((value) => {
            callbackCalls += 1
            return value + 1
        }))
        report('invoking-callback')
        const callback = await context.eval('hostCallback(41)', { timeout: 1000 })
        assert.equal(callback, 42)
        assert.equal(callbackCalls, 1)
        report('passed', { sum, callback, callbackCalls })
    } finally {
        isolate.dispose()
    }
}

run().then(() => {
    process.exit(0)
}).catch((error) => {
    report('failed', { error: String(error), stack: error.stack })
    process.exit(1)
})
