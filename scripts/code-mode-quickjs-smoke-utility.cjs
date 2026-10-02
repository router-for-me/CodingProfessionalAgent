const path = require('node:path')
const { pathToFileURL } = require('node:url')

async function main() {
    if (!process.parentPort) throw new Error('An Electron utility process is required')
    const url = pathToFileURL(path.join(__dirname, '../plugins/bundled/cpa.core.code-mode/main/quickjsSmoke.mjs'))
    const { runQuickJSSmoke } = await import(url.href)
    const result = await runQuickJSSmoke()
    process.parentPort.postMessage({ phase: 'passed', ...result })
}

main().then(() => process.exit(0)).catch((error) => {
    console.error(error)
    process.exit(1)
})
