import type { WebServerSettings } from '../../shared/types.js'

export interface WebServerStartupPlan {
    configureConfig?: Partial<WebServerSettings>
    startConfig: Partial<WebServerSettings> | null
}

export interface WebServerStartupPlanOptions {
    isHeadless?: boolean
    cliPort?: number
    cliHost?: string
}

export function resolveWebServerStartupPlan(
    appState: unknown,
    isDev: boolean,
    options?: WebServerStartupPlanOptions,
): WebServerStartupPlan {
    const state = appState as
        | {
              settings?: {
                  webServer?: Partial<WebServerSettings>
              }
          }
        | undefined
    const webServer = state?.settings?.webServer

    const port = options?.cliPort ?? webServer?.port ?? 18080
    const host = options?.cliHost ?? webServer?.host ?? '127.0.0.1'
    const password = webServer?.password ?? ''

    if (options?.isHeadless) {
        return {
            configureConfig: {
                ...webServer,
                host,
                port,
            },
            startConfig: {
                enabled: true,
                host,
                port,
                password,
            },
        }
    }

    const configureConfig = webServer

    let startConfig: Partial<WebServerSettings> | null = null
    if (webServer?.enabled) {
        startConfig = webServer
    } else if (isDev) {
        startConfig = {
            host,
            port,
            password,
        }
    }

    return {
        configureConfig,
        startConfig,
    }
}

export function resolveWebServerFallbackPlan(
    isDev: boolean,
    options?: WebServerStartupPlanOptions,
): Partial<WebServerSettings> | null {
    if (options?.isHeadless) {
        return {
            enabled: true,
            host: options.cliHost ?? '127.0.0.1',
            port: options.cliPort ?? 18080,
            password: '',
        }
    }
    if (isDev) {
        return { host: '127.0.0.1', port: 18080, password: '' }
    }
    return null
}

