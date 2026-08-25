import type { MouseEvent } from 'react'
import { Link, useNavigate, useRouterState } from '@tanstack/react-router'
import {
    cn,
    createHashRouteUrl,
    getHashRoutePathname,
    useHostService,
    useNavigationItems,
    useTranslation,
    PlusCircle,
    Compass,
} from '@cpa/plugin-ui'
import {
    NavigationServiceToken,
    SessionServiceToken,
    UiServiceToken,
} from '@cpa/plugin-api'
import { useIsMobileBrowser } from '../utils/platform.js'

export interface SidebarNavTopProps {
    items?: Array<{
        id: string
        labelKey: string
        viewId: string
        path?: string
        icon?: any
    }>
    currentPath?: string
}

function useCurrentPathname(explicitPath?: string): string {
    if (explicitPath) return explicitPath
    try {
        const path = useRouterState({ select: (s: any) => s.location.pathname })
        return typeof path === 'string' ? path : '/'
    } catch {
        return getHashRoutePathname()
    }
}

/**
 * Top navigation links rendered into `layout.sidebar.nav.top` slot.
 */
export function SidebarNavTop({ items, currentPath }: SidebarNavTopProps) {
    const { t } = useTranslation()
    const isMobile = useIsMobileBrowser()
    const sessionService = useHostService(SessionServiceToken)
    const navigationService = useHostService(NavigationServiceToken)
    const uiService = useHostService(UiServiceToken)
    const registeredNavItems = useNavigationItems()

    let navigate: any = null
    try {
        navigate = useNavigate()
    } catch {}

    const defaultItems = [
        {
            id: 'nav-home',
            labelKey: 'nav.newChat',
            viewId: 'home',
            path: '/',
            icon: PlusCircle,
        },
        {
            id: 'nav-explore',
            labelKey: 'nav.explore',
            viewId: 'explore',
            path: '/explore',
            icon: Compass,
        },
    ]

    const sourceItems = items && items.length > 0
        ? items
        : registeredNavItems && registeredNavItems.length > 0
            ? registeredNavItems
            : defaultItems

    const pathname = useCurrentPathname(currentPath)

    const handleNewChat = (e: MouseEvent) => {
        e.preventDefault()
        sessionService?.setCurrentSessionId?.(null)
        uiService?.setPendingSessionContext?.({
            projectId: null,
            branch: null,
        })
        if (isMobile) {
            uiService?.setSidebarCollapsed?.(true)
        }
        if (navigate) {
            void navigate({ to: '/' })
        } else if (navigationService) {
            void navigationService.navigate('/')
        } else if (typeof window !== 'undefined') {
            window.location.assign(createHashRouteUrl('/'))
        }
        const triggerFocus = () => {
            uiService?.emitEvent?.('composer:focus')
        }
        triggerFocus()
        if (typeof requestAnimationFrame !== 'undefined') {
            requestAnimationFrame(triggerFocus)
        }
        setTimeout(triggerFocus, 50)
    }

    return (
        <nav className="flex flex-col gap-0.5 px-2 pb-3" aria-label="Primary">
            {sourceItems.map((item) => {
                const targetPath = item.path ?? `/${item.viewId}`
                const Icon = item.icon ?? Compass
                const isNewChat = item.viewId === 'home' || targetPath === '/'
                const active = isNewChat
                    ? pathname === '/'
                    : pathname === targetPath || pathname.startsWith(`${targetPath}/`)

                const className = cn(
                    'flex items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[13px] transition-colors',
                    active
                        ? 'bg-[var(--bg-sidebar-hover)] font-medium text-[var(--text-primary)]'
                        : 'text-[var(--text-secondary)] hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
                )

                if (isNewChat) {
                    return (
                        <button
                            key={item.id}
                            type="button"
                            className={className}
                            onClick={handleNewChat}
                        >
                            <Icon className="size-3.5 shrink-0 opacity-80" aria-hidden />
                            <span className="truncate">{t(item.labelKey)}</span>
                        </button>
                    )
                }

                return (
                    <Link
                        key={item.id}
                        to={targetPath}
                        className={className}
                        onClick={() => {
                            if (isMobile) {
                                uiService?.setSidebarCollapsed?.(true)
                            }
                        }}
                    >
                        <Icon className="size-3.5 shrink-0 opacity-80" aria-hidden />
                        <span className="truncate">{t(item.labelKey)}</span>
                    </Link>
                )
            })}
        </nav>
    )
}

export default SidebarNavTop
