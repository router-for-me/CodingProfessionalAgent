import { newQuickJSWASMModule } from 'quickjs-emscripten'
import variant from '@jitl/quickjs-ng-wasmfile-release-sync'

// Loaded only by the utility-process executor and Node-based contract tests.
export async function runQuickJSSmoke() {
    const module = await newQuickJSWASMModule(variant)
    const runtime = module.newRuntime()
    runtime.setMemoryLimit(128 * 1024 * 1024)
    const context = runtime.newContext()
    let callbackCount = 0
    let asyncResolved = false
    const deferred = context.newPromise()
    let timer
    try {
        const sum = context.unwrapResult(context.evalCode('1 + 1')).consume(context.getNumber)
        const host = context.newFunction('hostNumber', () => {
            callbackCount += 1
            timer = setTimeout(() => {
                asyncResolved = true
                context.newNumber(42).consume(deferred.resolve)
            }, 10)
            return deferred.handle
        })
        host.consume((handle) => context.setProp(context.global, 'hostNumber', handle))
        // Drive guest jobs only after the host function has returned its promise.
        void deferred.settled.then(() => runtime.executePendingJobs().unwrap())
        const result = context.unwrapResult(context.evalCode('(async () => await hostNumber())()'))
        try {
            const callback = context.unwrapResult(await context.resolvePromise(result)).consume(context.getNumber)
            if (sum !== 2 || callback !== 42 || callbackCount !== 1 || !asyncResolved) {
                throw new Error('QuickJS guest promise bridge assertions failed')
            }
            return { sum, callback, callbackCount, asyncResolved }
        } finally {
            result.dispose()
        }
    } finally {
        clearTimeout(timer)
        deferred.dispose()
        context.dispose()
        runtime.dispose()
    }
}
