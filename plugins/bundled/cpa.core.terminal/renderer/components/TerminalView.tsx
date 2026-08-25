import { useEffect, useRef } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal, type ITheme } from '@xterm/xterm'
import { cn, useHostServices, useTranslation } from '@cpa/plugin-ui'
import { getTerminalCapabilityClient } from '../utils/capability.js'
import {
    createDefaultPtyBindings,
    createDefaultPtyEventSource,
    startPtySession,
    type PtyBindings,
    type PtySessionHandle,
} from '../utils/ptyHost.js'
import '@xterm/xterm/css/xterm.css'

function readXtermTheme(): ITheme {
    const isDark =
        typeof document !== 'undefined' &&
        document.documentElement.getAttribute('data-theme') !== 'light'
    return isDark
        ? {
            background: '#0e0e0e',
            foreground: '#ececec',
            cursor: '#ececec',
            selectionBackground: '#3a3a3a',
        }
        : {
            background: '#f5f5f5',
            foreground: '#171717',
            cursor: '#171717',
            selectionBackground: '#d0d0d0',
        }
}

export interface TerminalViewProps {
    tabId: string
    cwd: string
    active: boolean
    visible: boolean
    ptyBindings?: PtyBindings
}

export function TerminalView({
    tabId,
    cwd,
    active,
    visible,
    ptyBindings,
}: TerminalViewProps) {
    const { t } = useTranslation()
    const containerRef = useRef<HTMLDivElement>(null)
    const fitRef = useRef<FitAddon | null>(null)
    const visibleRef = useRef(visible)
    const activeRef = useRef(active)
    const termRef = useRef<Terminal | null>(null)
    const services = useHostServices()
    const codeFontSize = services?.settings?.getSnapshot?.()?.codeFontSize ?? 12

    visibleRef.current = visible
    activeRef.current = active

    useEffect(() => {
        const element = containerRef.current
        if (!element) return

        const term = new Terminal({
            cursorBlink: true,
            fontSize: codeFontSize,
            fontFamily: 'Menlo, Monaco, ui-monospace, "SF Mono", monospace',
            theme: readXtermTheme(),
            scrollback: 5000,
        })
        termRef.current = term
        const fit = new FitAddon()
        term.loadAddon(fit)
        term.open(element)
        try {
            fit.fit()
        } catch {
            // Empty or hidden container — fit again when shown.
        }

        fitRef.current = fit
        let disposed = false
        let session: PtySessionHandle | null = null

        const capabilityClient = getTerminalCapabilityClient()
        const bindings = ptyBindings ?? createDefaultPtyBindings(capabilityClient)
        const events = createDefaultPtyEventSource(capabilityClient)

        const sessionPromise = startPtySession(
            {
                operationId: tabId,
                cwd,
                cols: term.cols || 80,
                rows: term.rows || 24,
                onData: (bytes) => {
                    term.write(bytes)
                },
                onExit: (event) => {
                    if (event.kind === 'error' && event.error) {
                        term.writeln(`\r\n${event.error}`)
                        return
                    }
                    term.writeln(`\r\n[${t('terminal.exited')}]`)
                },
            },
            bindings,
            events,
        )
            .then((handle) => {
                if (disposed) {
                    void handle.dispose()
                    return null
                }
                session = handle
                return handle
            })
            .catch((error: unknown) => {
                const message =
                    error instanceof Error ? error.message : String(error ?? '')
                term.writeln(t('terminal.startFailed', { message }))
                return null
            })

        const dataDisposable = term.onData((data: string) => {
            void session?.write(data)
        })
        const resizeDisposable = term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
            void session?.resize(cols, rows)
        })

        const observer = typeof ResizeObserver !== 'undefined'
            ? new ResizeObserver(() => {
                if (!visibleRef.current || !activeRef.current) return
                try {
                    fit.fit()
                } catch {
                    // Ignore fit errors while collapsing
                }
            })
            : null

        if (observer) {
            observer.observe(element)
        }

        return () => {
            disposed = true
            dataDisposable.dispose()
            resizeDisposable.dispose()
            observer?.disconnect()
            void sessionPromise.then((handle) => {
                void handle?.dispose()
            })
            session = null
            term.dispose()
            termRef.current = null
            fitRef.current = null
        }
    }, [tabId, cwd, ptyBindings, services, t])

    useEffect(() => {
        if (termRef.current && fitRef.current) {
            termRef.current.options.fontSize = codeFontSize
            try {
                fitRef.current.fit()
            } catch {
                // ignore
            }
        }
    }, [codeFontSize])

    useEffect(() => {
        if (!visible || !active) return
        try {
            fitRef.current?.fit()
        } catch {
            // Ignore fit errors while collapsing
        }
    }, [visible, active])

    return (
        <div
            ref={containerRef}
            className={cn('h-full min-h-0 w-full px-3 py-2', !active && 'hidden')}
            data-testid="terminal-view"
        />
    )
}
