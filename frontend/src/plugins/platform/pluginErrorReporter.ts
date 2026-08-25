export interface PluginErrorSink {
    recordPluginError(pluginId: string, error: Error | string): void
}

let errorSinkRef: PluginErrorSink | null = null

/**
 * Attaches the authoritative runtime error sink to the error reporter
 * so UI execution exceptions can be written back to plugin runtime summaries.
 */
export function bindRuntimeHost(host: PluginErrorSink): void {
    errorSinkRef = host
}

/**
 * Report an execution error caught in a plugin UI surface back to the runtime host summary.
 */
export function reportSurfaceError(pluginId?: string, error?: unknown): void {
    if (!pluginId || !error) return
    const err = error instanceof Error ? error : new Error(String(error))
    if (errorSinkRef) {
        errorSinkRef.recordPluginError(pluginId, err)
    }
}
