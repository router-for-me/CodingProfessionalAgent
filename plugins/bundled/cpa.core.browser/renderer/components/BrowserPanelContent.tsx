import React, { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, RotateCw, cn, useTranslation } from '@cpa/plugin-ui'

export interface BrowserPanelContentProps {
    sessionId?: string | null
    url?: string
    className?: string
    params?: {
        url?: string
        [key: string]: unknown
    }
    events?: {
        on?: (event: string, handler: (...args: any[]) => void) => () => void
    }
}

export function normalizeBrowserUrl(rawUrl: string): string {
    const trimmed = (rawUrl || '').trim()
    if (!trimmed) {
        return 'http://localhost:3000'
    }
    if (/^https?:\/\//i.test(trimmed)) {
        return trimmed
    }
    return `http://${trimmed}`
}

/**
 * Browser preview tab content for right sidebar panel.
 */
export function BrowserPanelContent({
    url: urlProp,
    className,
    params,
    events,
}: BrowserPanelContentProps) {
    const { t } = useTranslation()
    const iframeRef = useRef<HTMLIFrameElement>(null)
    const urlInputRef = useRef<HTMLInputElement>(null)
    const initialUrl =
        (typeof urlProp === 'string' && urlProp.trim()) ||
        (typeof params?.url === 'string' && params.url.trim()) ||
        'http://localhost:3000'

    const [url, setUrl] = useState(initialUrl)
    const [activeUrl, setActiveUrl] = useState(normalizeBrowserUrl(initialUrl))
    const [history, setHistory] = useState<string[]>([normalizeBrowserUrl(initialUrl)])
    const [historyIndex, setHistoryIndex] = useState(0)

    const navigateTo = (targetUrl: string) => {
        const normalized = normalizeBrowserUrl(targetUrl)
        setUrl(normalized)
        setActiveUrl(normalized)
        setHistory((prev) => [...prev.slice(0, historyIndex + 1), normalized])
        setHistoryIndex((prev) => prev + 1)
    }

    const handleBack = () => {
        if (historyIndex > 0) {
            const nextIndex = historyIndex - 1
            const nextUrl = history[nextIndex]!
            setHistoryIndex(nextIndex)
            setUrl(nextUrl)
            setActiveUrl(nextUrl)
        }
    }

    const handleForward = () => {
        if (historyIndex < history.length - 1) {
            const nextIndex = historyIndex + 1
            const nextUrl = history[nextIndex]!
            setHistoryIndex(nextIndex)
            setUrl(nextUrl)
            setActiveUrl(nextUrl)
        }
    }

    const handleReload = () => {
        if (iframeRef.current) {
            iframeRef.current.src = activeUrl
        } else {
            setActiveUrl((prev) => `${prev}`)
        }
    }

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault()
        navigateTo(url)
    }

    useEffect(() => {
        if (!events?.on) return

        const unsubReload = events.on('browser:reload', () => handleReload())
        const unsubForceReload = events.on('browser:force-reload', () => handleReload())
        const unsubBack = events.on('browser:back', () => handleBack())
        const unsubForward = events.on('browser:forward', () => handleForward())
        const unsubFocusAddress = events.on('browser:focus-address-bar', () => {
            urlInputRef.current?.focus()
            urlInputRef.current?.select()
        })

        return () => {
            unsubReload?.()
            unsubForceReload?.()
            unsubBack?.()
            unsubForward?.()
            unsubFocusAddress?.()
        }
    }, [events, activeUrl, historyIndex, history])

    const canGoBack = historyIndex > 0
    const canGoForward = historyIndex < history.length - 1

    return (
        <div
            data-testid="right-sidebar-browser-view"
            className={cn(
                'flex h-full min-h-0 flex-col overflow-hidden text-[var(--text-primary)]',
                className,
            )}
        >
            <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-[var(--border-subtle)] px-2 bg-[var(--bg-app)]">
                <button
                    type="button"
                    aria-label="Back"
                    data-testid="browser-back-btn"
                    disabled={!canGoBack}
                    onClick={handleBack}
                    className={cn(
                        'flex size-6 items-center justify-center rounded text-[var(--text-muted)] transition-colors',
                        canGoBack
                            ? 'hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]'
                            : 'opacity-40 cursor-not-allowed',
                    )}
                >
                    <ArrowLeft className="size-3.5" />
                </button>
                <button
                    type="button"
                    aria-label="Forward"
                    data-testid="browser-forward-btn"
                    disabled={!canGoForward}
                    onClick={handleForward}
                    className={cn(
                        'flex size-6 items-center justify-center rounded text-[var(--text-muted)] transition-colors',
                        canGoForward
                            ? 'hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]'
                            : 'opacity-40 cursor-not-allowed',
                    )}
                >
                    <ArrowRight className="size-3.5" />
                </button>
                <button
                    type="button"
                    aria-label="Reload"
                    data-testid="browser-reload-btn"
                    onClick={handleReload}
                    className="flex size-6 items-center justify-center rounded text-[var(--text-muted)] hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)] transition-colors"
                >
                    <RotateCw className="size-3" />
                </button>
                <form onSubmit={handleSubmit} className="flex-1">
                    <input
                        ref={urlInputRef}
                        type="text"
                        value={url}
                        onChange={(e) => setUrl(e.target.value)}
                        placeholder={t('rightSidebar.browser.placeholder')}
                        className="h-6 w-full rounded bg-[var(--bg-elevated)] px-2 text-[11px] text-[var(--text-primary)] border border-[var(--border-subtle)] focus:outline-none focus:border-[var(--border-strong)]"
                    />
                </form>
            </div>
            <div className="relative flex flex-1 flex-col items-center justify-center overflow-hidden bg-[var(--bg-app)]">
                <iframe
                    ref={iframeRef}
                    src={activeUrl}
                    title="Browser View"
                    className="h-full w-full border-0 bg-white dark:bg-zinc-900"
                    sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                />
            </div>
        </div>
    )
}
