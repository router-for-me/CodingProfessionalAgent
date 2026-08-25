import type { WebServerSettings } from '../../shared/types.js'

export interface WebServerStartupPlan {
  configureConfig?: Partial<WebServerSettings>
  startConfig: Partial<WebServerSettings> | null
}

export function resolveWebServerStartupPlan(
  appState: unknown,
  isDev: boolean,
): WebServerStartupPlan {
  const state = appState as
    | {
        settings?: {
          webServer?: Partial<WebServerSettings>
        }
      }
    | undefined
  const webServer = state?.settings?.webServer
  const configureConfig = webServer

  let startConfig: Partial<WebServerSettings> | null = null
  if (webServer?.enabled) {
    startConfig = webServer
  } else if (isDev) {
    startConfig = {
      host: webServer?.host || '127.0.0.1',
      port: webServer?.port || 18080,
      password: webServer?.password ?? '',
    }
  }

  return {
    configureConfig,
    startConfig,
  }
}

export function resolveWebServerFallbackPlan(
  isDev: boolean,
): Partial<WebServerSettings> | null {
  if (isDev) {
    return { host: '127.0.0.1', port: 18080, password: '' }
  }
  return null
}
