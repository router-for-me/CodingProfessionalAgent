import { describe, expect, it } from 'vitest'
import {
  resolveWebServerStartupPlan,
  resolveWebServerFallbackPlan,
} from '../src/main/utils/webServerStartup.js'

describe('WebServer Startup Options Resolution', () => {
  describe('resolveWebServerStartupPlan', () => {
    describe('production mode (isDev = false)', () => {
      it('starts web server with full config including password when enabled', () => {
        const appState = {
          settings: {
            webServer: {
              enabled: true,
              host: '0.0.0.0',
              port: 19000,
              password: 'prod-secret-password',
            },
          },
        }

        const plan = resolveWebServerStartupPlan(appState, false)

        expect(plan.configureConfig).toEqual({
          enabled: true,
          host: '0.0.0.0',
          port: 19000,
          password: 'prod-secret-password',
        })
        expect(plan.startConfig).toEqual({
          enabled: true,
          host: '0.0.0.0',
          port: 19000,
          password: 'prod-secret-password',
        })
      })

      it('does not start web server when enabled is false, but passes configureConfig', () => {
        const appState = {
          settings: {
            webServer: {
              enabled: false,
              host: '127.0.0.1',
              port: 18080,
              password: 'saved-password',
            },
          },
        }

        const plan = resolveWebServerStartupPlan(appState, false)

        expect(plan.configureConfig).toEqual({
          enabled: false,
          host: '127.0.0.1',
          port: 18080,
          password: 'saved-password',
        })
        expect(plan.startConfig).toBeNull()
      })

      it('does not start and returns undefined configureConfig when state has no webServer settings', () => {
        expect(resolveWebServerStartupPlan(null, false)).toEqual({
          configureConfig: undefined,
          startConfig: null,
        })
        expect(resolveWebServerStartupPlan({}, false)).toEqual({
          configureConfig: undefined,
          startConfig: null,
        })
        expect(resolveWebServerStartupPlan({ settings: {} }, false)).toEqual({
          configureConfig: undefined,
          startConfig: null,
        })
      })
    })

    describe('development mode (isDev = true)', () => {
      it('starts with enabled config when enabled is true in dev mode', () => {
        const appState = {
          settings: {
            webServer: {
              enabled: true,
              host: '127.0.0.1',
              port: 18080,
              password: 'dev-custom-password',
            },
          },
        }

        const plan = resolveWebServerStartupPlan(appState, true)

        expect(plan.configureConfig).toEqual({
          enabled: true,
          host: '127.0.0.1',
          port: 18080,
          password: 'dev-custom-password',
        })
        expect(plan.startConfig).toEqual({
          enabled: true,
          host: '127.0.0.1',
          port: 18080,
          password: 'dev-custom-password',
        })
      })

      it('auto-starts in dev mode even if enabled is false, using persisted host/port/password', () => {
        const appState = {
          settings: {
            webServer: {
              enabled: false,
              host: '0.0.0.0',
              port: 18081,
              password: 'dev-password',
            },
          },
        }

        const plan = resolveWebServerStartupPlan(appState, true)

        expect(plan.configureConfig).toEqual({
          enabled: false,
          host: '0.0.0.0',
          port: 18081,
          password: 'dev-password',
        })
        expect(plan.startConfig).toEqual({
          host: '0.0.0.0',
          port: 18081,
          password: 'dev-password',
        })
      })

      it('auto-starts in dev mode with defaults when webServer settings are empty or password missing', () => {
        const appState = {
          settings: {
            webServer: {
              enabled: false,
            },
          },
        }

        const plan = resolveWebServerStartupPlan(appState, true)

        expect(plan.startConfig).toEqual({
          host: '127.0.0.1',
          port: 18080,
          password: '',
        })

        const emptyPlan = resolveWebServerStartupPlan(null, true)
        expect(emptyPlan.configureConfig).toBeUndefined()
        expect(emptyPlan.startConfig).toEqual({
          host: '127.0.0.1',
          port: 18080,
          password: '',
        })
      })
    })
  })

  describe('resolveWebServerFallbackPlan', () => {
    it('returns default fallback startup config in dev mode', () => {
      expect(resolveWebServerFallbackPlan(true)).toEqual({
        host: '127.0.0.1',
        port: 18080,
        password: '',
      })
    })

    it('returns null in production mode when settings read fails', () => {
      expect(resolveWebServerFallbackPlan(false)).toBeNull()
    })
  })
})
