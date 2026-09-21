import {
    useEffect,
    useState,
    type ReactNode,
} from 'react'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import { applyAppearanceToDOM } from '@/lib/theme'
import { useModelCatalogBootstrap } from '@/features/models/useModelCatalogBootstrap'
import {
    AgentServiceProvider,
    disposeAgentRuntime,
} from '@/features/agent/useAgentStream'
import type { AgentService } from '@/features/agent/AgentService'
import { HostServicesProvider } from '@/application/services/HostServicesContext'
import { CLIProxyAPIAgentService } from '@/features/agent-runtime/CLIProxyAPIAgentService'
import { ElectronNativeBridge } from '@/features/agent-runtime/native/electronNativeBridge'
import { useSettingsStore } from '@/stores/settingsStore'
import { getHostBridge, onHostReconnect } from '@/application/services/hostTransport'

interface AppProvidersProps {
    children: ReactNode
}

function useThemeEffect() {
    const settings = useSettingsStore((state) => state.settings)

    useEffect(() => {
        const media = window.matchMedia('(prefers-color-scheme: dark)')

        const apply = () => {
            applyAppearanceToDOM(settings, media.matches)
        }

        apply()

        const onChange = () => apply()
        media.addEventListener('change', onChange)
        return () => {
            media.removeEventListener('change', onChange)
        }
    }, [settings])
}

/**
 * Syncs the macOS menu bar (tray) toggle + locale to the main process.
 * No-op when the Electron bridge is absent (pure web dev mode).
 */
function useTraySyncEffect() {
    const showInMenuBar = useSettingsStore((state) => state.settings.showInMenuBar)
    const headlessCloseAction = useSettingsStore((state) => state.settings.headlessCloseAction)
    const locale = useSettingsStore((state) => state.settings.locale)

    useEffect(() => {
        const bridge = getHostBridge()
        if (!bridge?.SetTrayEnabled) {
            return
        }
        const isTrayEnabled = (headlessCloseAction ?? 'continue_headless') !== 'quit' && (showInMenuBar ?? true)
        void bridge.SetTrayEnabled(isTrayEnabled, locale).catch(() => {
            // Tray sync must never crash the renderer.
        })
    }, [showInMenuBar, headlessCloseAction, locale])
}

/**
 * Syncs the prevent sleep while running toggle to the main process.
 * Keeps system awake during active runs when enabled.
 */
function usePreventSleepSyncEffect() {
    const preventSleep = useSettingsStore((state) => state.settings.preventSleep ?? true)

    useEffect(() => {
        let isCancelled = false
        const sync = () => {
            const bridge = getHostBridge()
            if (!bridge?.SetPreventSleep) {
                return
            }
            const currentSetting = useSettingsStore.getState().settings.preventSleep ?? true
            void bridge.SetPreventSleep(currentSetting).catch((err) => {
                if (!isCancelled) {
                    console.warn('[PowerSave] Failed to sync preventSleep setting to host:', err)
                }
            })
        }

        sync()
        const unsub = onHostReconnect?.(() => {
            sync()
        })

        return () => {
            isCancelled = true
            unsub?.()
        }
    }, [preventSleep])
}

export type ProductionAgentRuntime = {
    service: AgentService
    dispose: () => Promise<void>
}

/** Testable factory counters for StrictMode lifecycle verification. */
let productionRuntimeCreateCount = 0
let productionRuntimeDisposeCount = 0

/** Test helper — reset factory counters. */
export function __resetProductionRuntimeCountersForTests(): void {
    productionRuntimeCreateCount = 0
    productionRuntimeDisposeCount = 0
}

/** Test helper — read factory counters. */
export function __getProductionRuntimeCountersForTests(): {
    create: number
    dispose: number
} {
    return {
        create: productionRuntimeCreateCount,
        dispose: productionRuntimeDisposeCount,
    }
}

/**
 * Serializing runtime lease: every acquire/dispose runs on one FIFO queue.
 * Guarantees StrictMode order create1 → dispose1 → create2 (never parallel).
 * No render-time side effects — only called from effect setup/cleanup.
 * Each created bundle disposes exactly once.
 *
 * When `isCancelled` is true after factory create, the bundle is disposed in the
 * same queue turn (before the next acquire) so StrictMode never observes two live bundles.
 */
export function createRuntimeLease<T>(factory: () => {
    resource: T
    dispose: () => void | Promise<void>
}): {
    acquire: (isCancelled?: () => boolean) => Promise<{
        resource: T
        dispose: () => Promise<void>
    }>
    /** Await all pending acquire/dispose work (tests / flush). */
    flush: () => Promise<void>
} {
    let tail: Promise<void> = Promise.resolve()

    const enqueue = <R,>(fn: () => Promise<R>): Promise<R> => {
        const run = tail.then(fn, fn)
        // Keep the chain alive regardless of success/failure.
        tail = run.then(
            () => undefined,
            () => undefined,
        )
        return run
    }

    return {
        acquire: (isCancelled) =>
            enqueue(async () => {
                const bundle = factory()
                let disposed = false
                const disposeOnce = async (): Promise<void> => {
                    if (disposed) return
                    disposed = true
                    await Promise.resolve(bundle.dispose())
                }
                if (isCancelled?.()) {
                    // Dispose inline so the next queued acquire sees a clean slate.
                    await disposeOnce()
                    throw new DOMException('Runtime lease cancelled', 'AbortError')
                }
                return {
                    resource: bundle.resource,
                    dispose: () => enqueue(disposeOnce),
                }
            }),
        flush: async () => {
            await tail
        },
    }
}

/**
 * Explicit lifecycle factory for bridge+service.
 * Not invoked from useState initializers so StrictMode discarded inits never leak.
 */
export function createProductionAgentRuntime(): ProductionAgentRuntime {
    productionRuntimeCreateCount += 1
    const bridge = new ElectronNativeBridge()
    const service = new CLIProxyAPIAgentService({ bridge })
    let disposed = false
    return {
        service,
        dispose: async () => {
            if (disposed) return
            disposed = true
            productionRuntimeDisposeCount += 1
            // Hook runtime first (abort flight / clear listeners), then service, then bridge.
            try {
                await disposeAgentRuntime(service)
            } catch {
                // observe
            }
            try {
                await Promise.resolve(bridge.dispose())
            } catch {
                // observe
            }
        },
    }
}

/** Module-level lease so StrictMode remounts serialize create/dispose. */
const productionRuntimeLease = createRuntimeLease(() => {
    const runtime = createProductionAgentRuntime()
    return {
        resource: runtime.service,
        dispose: () => runtime.dispose(),
    }
})

/**
 * Mount-time async-safe runtime: create in effect, dispose exactly once per create.
 * StrictMode remount waits for the previous dispose before creating the next bundle.
 * Renders null until the lease is acquired (no render-time side effects).
 */
function useProductionAgentService(): AgentService | null {
    const [service, setService] = useState<AgentService | null>(null)

    useEffect(() => {
        let active = true
        let release: (() => Promise<void>) | null = null

        void (async () => {
            try {
                const lease = await productionRuntimeLease.acquire(() => !active)
                // acquire already disposed inline when cancelled mid-wait.
                if (!active) {
                    await lease.dispose()
                    return
                }
                release = () => lease.dispose()
                setService(lease.resource)
            } catch {
                // Cancelled or bootstrap failure — stay on null service.
            }
        })()

        return () => {
            active = false
            setService(null)
            if (release) {
                const done = release()
                // Observe the promise so dispose rejections never go unhandled.
                void done.catch(() => {
                    // Provider cleanup must never surface unhandled rejections.
                })
                release = null
            }
        }
    }, [])

    return service
}

/**
 * App shell providers: i18n + theme + production agent service.
 * Persistence bootstrap is awaited in main before first paint.
 */
export function AppProviders({ children }: AppProvidersProps) {
    useThemeEffect()
    useTraySyncEffect()
    usePreventSleepSyncEffect()
    useModelCatalogBootstrap()
    const agentService = useProductionAgentService()

    return (
        <I18nextProvider i18n={i18n}>
            <HostServicesProvider>
                <AgentServiceProvider service={agentService}>
                    {children}
                </AgentServiceProvider>
            </HostServicesProvider>
        </I18nextProvider>
    )
}
