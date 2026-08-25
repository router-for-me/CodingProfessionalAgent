import type { PluginInvocationResult } from '@cpa/plugin-api'
import { PluginError } from '@cpa/plugin-api'

export interface SafeInvokeOptions {
    timeoutMs?: number
    pluginId?: string
    actionName?: string
}

/**
 * Safely executes a synchronous or asynchronous function within an error boundary.
 * Catches synchronous exceptions and Promise rejections, optionally enforcing a timeout,
 * and returns a structured PluginInvocationResult.
 */
export async function safeInvoke<T>(
    fn: () => T | Promise<T>,
    options?: SafeInvokeOptions,
): Promise<PluginInvocationResult<T>> {
    const timeoutMs = options?.timeoutMs
    const pluginId = options?.pluginId
    const actionName = options?.actionName

    let timer: NodeJS.Timeout | undefined

    try {
        const actionPromise = (async () => {
            return await fn()
        })()

        if (timeoutMs !== undefined && timeoutMs > 0) {
            const timeoutPromise = new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    const desc = actionName ? `action "${actionName}"` : 'invocation'
                    const target = pluginId ? ` on plugin "${pluginId}"` : ''
                    reject(
                        new PluginError(`Timeout: ${desc}${target} exceeded ${timeoutMs}ms`, {
                            code: 'PLUGIN_TIMEOUT',
                            pluginId,
                        }),
                    )
                }, timeoutMs)
            })

            const value = await Promise.race([actionPromise, timeoutPromise])
            return { ok: true, value }
        }

        const value = await actionPromise
        return { ok: true, value }
    } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        return { ok: false, error }
    } finally {
        if (timer) {
            clearTimeout(timer)
        }
    }
}
