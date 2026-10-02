import { CellExecutor } from './cells.js'
import type { ExecutorCommand, ExecutorEvent } from '../shared/messages.js'

const port = process.parentPort
if (!port) throw new Error('Code cells require an Electron utility process')
const send = (event: ExecutorEvent | { type: 'ready' }) => port.postMessage(event)
const executor = new CellExecutor(
    (request) => send({ type: 'tool-request', request }),
    (cellId, observation) => send({ type: 'notify', cellId, observation }),
    (cellId) => send({ type: 'completed', cellId }),
)

port.on('message', ({ data }: { data: ExecutorCommand }) => {
    void (async () => {
        if (data.type === 'tool-result') executor.deliver(data.invocationId, data.result)
        else if (data.type === 'cancel') {
            executor.cancel(data.sessionId, data.cellId)
            if (data.cancelId) send({ type: 'cancelled', cancelId: data.cancelId })
        }
        else {
            const observation = data.type === 'start' ? await executor.start(data.input) : await executor.observe(data.input)
            send({ type: 'observation', requestId: data.requestId, observation })
        }
    })().catch((error) => {
        if (data.type === 'start' || data.type === 'observe') {
            send({ type: 'observation', requestId: data.requestId, observation: { cellId: data.input.cellId ?? '', status: 'failed', content: [], error: String(error) } })
        }
    })
})

// Announce availability only after the actual WASM runtime has evaluated code.
void executor.start({ sessionId: '__probe', source: 'text(1+1)', tools: [], yieldTimeMs: 1000, maxOutputTokens: 10 }).then((result) => {
    if (result.status !== 'completed' || result.content[0]?.type !== 'text' || result.content[0].text !== '2') throw new Error('Executor startup check failed')
    executor.cancel('__probe')
    send({ type: 'ready' })
}).catch((error) => {
    console.error(error)
    process.exit(1)
})
process.on('exit', () => executor.dispose())
