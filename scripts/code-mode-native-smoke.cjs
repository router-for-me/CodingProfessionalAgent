const { app, utilityProcess } = require('electron')
const path = require('node:path')

// Run with Electron, never with a Node compatibility mode.
const addonPath = process.argv[2]
if (!process.versions.electron || !process.versions.electron.startsWith('44.') || !addonPath || !path.isAbsolute(addonPath)) {
    console.error('Usage: pnpm exec electron scripts/code-mode-native-smoke.cjs /absolute/path/to/isolated_vm.node')
    app.exit(1)
} else {
    app.whenReady().then(() => {
        let passed = false
        const child = utilityProcess.fork(path.join(__dirname, 'code-mode-native-smoke-utility.cjs'), [addonPath], {
            stdio: 'pipe',
            serviceName: 'Native isolate smoke test',
        })
        const timeout = setTimeout(() => {
            console.error('Utility-process smoke test timed out')
            child.kill()
            app.exit(1)
        }, 20000)
        child.stdout.on('data', (chunk) => process.stdout.write(chunk))
        child.stderr.on('data', (chunk) => process.stderr.write(chunk))
        child.on('message', (message) => {
            console.log(JSON.stringify(message))
            if (message.phase === 'passed' && message.sum === 2 && message.callback === 42) {
                passed = true
            }
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
}
