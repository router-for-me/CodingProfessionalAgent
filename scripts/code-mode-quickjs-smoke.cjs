const { app, utilityProcess } = require('electron')
const path = require('node:path')

// Main only forks and observes; it never imports QuickJS or its WASM.
app.whenReady().then(() => {
    let passed = false
    const child = utilityProcess.fork(path.join(__dirname, 'code-mode-quickjs-smoke-utility.cjs'), [], {
        stdio: 'pipe',
        serviceName: 'QuickJS guest promise smoke test',
    })
    const timeout = setTimeout(() => {
        console.error('QuickJS utility-process smoke timed out')
        child.kill()
        app.exit(1)
    }, 20000)
    child.stdout.on('data', (chunk) => process.stdout.write(chunk))
    child.stderr.on('data', (chunk) => process.stderr.write(chunk))
    child.on('message', (message) => {
        console.log(JSON.stringify(message))
        passed = message.phase === 'passed' && message.sum === 2 && message.callback === 42
            && message.callbackCount === 1 && message.asyncResolved === true
    })
    child.on('exit', (code) => {
        clearTimeout(timeout)
        console.log(JSON.stringify({ phase: 'utility-exit', code, passed }))
        app.exit(passed && code === 0 ? 0 : 1)
    })
}).catch((error) => {
    console.error(error)
    app.exit(1)
})
