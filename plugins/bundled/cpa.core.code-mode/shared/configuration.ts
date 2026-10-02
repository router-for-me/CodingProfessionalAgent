import type { AppSettings } from '@cpa/plugin-api'

const integer = (value: unknown, fallback: number) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback
export function codeModeConfiguration(settings: Partial<AppSettings> = {}) {
    return {
        toolMode: settings.toolMode === 'code' || settings.toolMode === 'code-only' ? settings.toolMode : 'direct' as const,
        defaultExecYieldMs: integer(settings.defaultExecYieldMs, 30_000),
        defaultWaitYieldMs: integer(settings.defaultWaitYieldMs, 10_000),
        maxOutputTokens: integer(settings.maxOutputTokens, 10_000),
        excludedToolNames: Array.isArray(settings.excludedToolNames) ? settings.excludedToolNames.filter((name) => typeof name === 'string') : [],
        directOnlyToolNames: Array.isArray(settings.directOnlyToolNames) ? settings.directOnlyToolNames.filter((name) => typeof name === 'string') : [],
        disableWhenUnavailable: settings.disableWhenUnavailable !== false,
    }
}
