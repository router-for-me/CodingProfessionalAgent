import { useEffect, useState } from 'react'

export function isWindowsPlatform(): boolean {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return false
    const ua = (navigator.userAgent || '').toLowerCase()
    const platform = ((navigator as { platform?: string }).platform || '').toLowerCase()
    return ua.includes('win') || platform.includes('win')
}

export function isBrowserEnvironment(): boolean {
    if (typeof window === 'undefined') return false
    return !navigator.userAgent.includes('Electron')
}

export function isMobileBrowser(): boolean {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return false
    if (!isBrowserEnvironment()) return false

    const ua = navigator.userAgent || ''
    const isMobileUA =
        /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(ua)
    const isTouchDevice =
        (typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 0) ||
        'ontouchstart' in window
    const isSmallScreen =
        typeof window.innerWidth === 'number' && window.innerWidth > 0 && window.innerWidth <= 768

    return isMobileUA || (isTouchDevice && isSmallScreen)
}

export function useIsMobileBrowser(): boolean {
    const [isMobile, setIsMobile] = useState(() => isMobileBrowser())

    useEffect(() => {
        const update = () => setIsMobile(isMobileBrowser())
        window.addEventListener('resize', update)
        return () => window.removeEventListener('resize', update)
    }, [])

    return isMobile
}
