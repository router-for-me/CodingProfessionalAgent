import { describe, it, expect } from 'vitest'
import {
    resolveWebServerStartupPlan,
    resolveWebServerFallbackPlan,
} from '../src/main/utils/webServerStartup.js'

describe('resolveWebServerStartupPlan with headless options', () => {
    it('force-starts web server when isHeadless is true even if settings.enabled is false', () => {
        const appState = {
            settings: {
                webServer: {
                    enabled: false,
                    port: 18080,
                    host: '127.0.0.1',
                    password: 'secret',
                },
            },
        }

        const plan = resolveWebServerStartupPlan(appState, false, { isHeadless: true })
        expect(plan.startConfig).toEqual({
            enabled: true,
            port: 18080,
            host: '127.0.0.1',
            password: 'secret',
        })
    })

    it('overrides port and host when cliPort and cliHost are provided in headless mode', () => {
        const appState = {
            settings: {
                webServer: {
                    enabled: false,
                    port: 18080,
                    host: '127.0.0.1',
                },
            },
        }

        const plan = resolveWebServerStartupPlan(appState, false, {
            isHeadless: true,
            cliPort: 19999,
            cliHost: '0.0.0.0',
        })
        expect(plan.startConfig?.port).toBe(19999)
        expect(plan.startConfig?.host).toBe('0.0.0.0')
        expect(plan.startConfig?.enabled).toBe(true)
    })

    it('falls back to default 18080 and 127.0.0.1 in headless mode when appState is empty', () => {
        const plan = resolveWebServerStartupPlan(undefined, false, { isHeadless: true })
        expect(plan.startConfig?.port).toBe(18080)
        expect(plan.startConfig?.host).toBe('127.0.0.1')
        expect(plan.startConfig?.enabled).toBe(true)
    })

    it('returns fallback plan for headless mode in resolveWebServerFallbackPlan', () => {
        const fallback = resolveWebServerFallbackPlan(false, {
            isHeadless: true,
            cliPort: 19000,
            cliHost: '127.0.0.1',
        })
        expect(fallback).toEqual({
            enabled: true,
            host: '127.0.0.1',
            port: 19000,
            password: '',
        })
    })

    it('preserves existing non-headless behavior when isHeadless is not true', () => {
        const appStateDisabled = {
            settings: {
                webServer: {
                    enabled: false,
                    port: 18080,
                },
            },
        }
        const prodPlan = resolveWebServerStartupPlan(appStateDisabled, false)
        expect(prodPlan.startConfig).toBeNull()

        const devPlan = resolveWebServerStartupPlan(appStateDisabled, true)
        expect(devPlan.startConfig?.port).toBe(18080)
    })
})
