import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import { AppProviders } from './app/providers'
import { dismissSplashScreen } from './lib/splash'
import { initBrowserBridge } from './features/agent-runtime/native/browserBridge'
import { bootstrapApplication } from './application/services/bootstrapApplication'
import { ensureBrowserHostTransport } from './application/services/hostTransport'
import { initReactGrab } from './lib/reactGrab'
import { observeReactPerformanceMeasures } from './lib/reactPerformanceMeasures'
import { initMacScrollbars } from './lib/macScrollbar'
import { waitForWebAuthentication } from './features/web-auth/WebAuthGate'
import './styles/app.css'
import type { Root } from 'react-dom/client'

if (import.meta.env.DEV) {
    const stopObservingReactMeasures = observeReactPerformanceMeasures()
    import.meta.hot?.dispose(stopObservingReactMeasures)
}

export interface StartupDependencies {
  root?: Root
  waitForWebAuth?: (root: Root) => Promise<void>
  initBrowserBridge?: () => void
  initReactGrab?: () => Promise<void> | void
  bootstrapApp?: () => Promise<void> | void
  renderApp?: (root: Root) => void
  dismissSplash?: () => void
}

export async function runStartup(deps?: StartupDependencies): Promise<void> {
  const root = deps?.root ?? createRoot(document.getElementById('root')!)
  try {
    await (deps?.waitForWebAuth ?? waitForWebAuthentication)(root)
    ;(deps?.initBrowserBridge ?? initBrowserBridge)()
    // Warm browser RPC transport so persistence reuses desktop settings/KV store.
    ensureBrowserHostTransport()
    initMacScrollbars()
    await (deps?.initReactGrab ?? initReactGrab)()
    await (deps?.bootstrapApp ?? bootstrapApplication)()
    if (deps?.renderApp) {
      deps.renderApp(root)
    } else {
      root.render(
        <AppProviders>
          <App />
        </AppProviders>,
      )
    }
    requestAnimationFrame(() => {
      ;(deps?.dismissSplash ?? dismissSplashScreen)()
    })
  } catch (err) {
    console.error('Fatal application startup error:', err)
    root.render(
      <div
        style={{
          padding: 32,
          fontFamily: 'var(--font-sans, system-ui, sans-serif)',
          fontSize: 'var(--ui-font-size, 14px)',
          color: 'var(--accent-orange, #ef4444)',
          backgroundColor: 'var(--bg-app, #0e0e0e)',
          height: '100vh',
          boxSizing: 'border-box',
        }}
      >
        <h2 style={{ color: 'var(--text-primary, #ffffff)', marginBottom: 8 }}>
          Application Initialization Failed
        </h2>
        <p style={{ color: 'var(--accent-orange, #ef4444)' }}>
          {err instanceof Error ? err.message : String(err)}
        </p>
      </div>,
    )
    requestAnimationFrame(() => {
      ;(deps?.dismissSplash ?? dismissSplashScreen)()
    })
    throw err
  }
}

// Only auto-run when executing in actual document environment and not in test runner
if (typeof document !== 'undefined' && document.getElementById('root') && !import.meta.env.VITEST) {
  void runStartup()
}
