/**
 * Configuration directory names and helpers for release and dev environments.
 */

export const DEFAULT_APP_CONFIG_DIR_NAME = '.coding-professional-agent'
export const DEV_APP_CONFIG_DIR_NAME = '.coding-professional-agent-dev'

/**
 * Returns the configuration directory name based on whether running in dev mode.
 * Falls back to environment variables (CPA_CONFIG_DIR_NAME, CPA_DEV, NODE_ENV) or import.meta.env.DEV.
 */
export function getAppConfigDirName(isDev?: boolean): string {
    if (typeof isDev === 'boolean') {
        return isDev ? DEV_APP_CONFIG_DIR_NAME : DEFAULT_APP_CONFIG_DIR_NAME
    }
    if (typeof process !== 'undefined' && process.env) {
        if (process.env.CPA_CONFIG_DIR_NAME) {
            return process.env.CPA_CONFIG_DIR_NAME
        }
        if (process.env.CPA_DEV === '1' || process.env.CPA_DEV === 'true') {
            return DEV_APP_CONFIG_DIR_NAME
        }
        if (process.env.CPA_DEV === '0' || process.env.CPA_DEV === 'false') {
            return DEFAULT_APP_CONFIG_DIR_NAME
        }
        if (process.env.NODE_ENV === 'development') {
            return DEV_APP_CONFIG_DIR_NAME
        }
        if (process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST)) {
            return DEFAULT_APP_CONFIG_DIR_NAME
        }
    }
    if (typeof import.meta !== 'undefined') {
        const env = (import.meta as any)?.env
        if (env?.MODE === 'test' || env?.VITEST) {
            return DEFAULT_APP_CONFIG_DIR_NAME
        }
        if (env?.DEV) {
            return DEV_APP_CONFIG_DIR_NAME
        }
    }
    return DEFAULT_APP_CONFIG_DIR_NAME
}
