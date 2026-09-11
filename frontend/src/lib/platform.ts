/**
 * Platform and runtime environment detection utilities.
 */

import { useEffect, useState } from 'react'

/**
 * Checks whether the frontend is running on a Windows platform.
 */
export function isWindowsPlatform(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false
  const ua = (navigator.userAgent || '').toLowerCase()
  const platform = ((navigator as { platform?: string }).platform || '').toLowerCase()
  return ua.includes('win') || platform.includes('win')
}

/**
 * Checks whether the frontend is running inside a web browser rather than Electron desktop window.
 */
export function isBrowserEnvironment(): boolean {
  if (typeof window === 'undefined') return false
  return !navigator.userAgent.includes('Electron')
}

/**
 * Checks whether the frontend is running in a mobile browser environment.
 */
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

/**
 * React hook that returns whether the current environment is a mobile browser,
 * updating reactively on window resize and orientation change events.
 */
export function useIsMobileBrowser(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() => isMobileBrowser())

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(isMobileBrowser())
    }

    window.addEventListener('resize', handleResize)
    window.addEventListener('orientationchange', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
      window.removeEventListener('orientationchange', handleResize)
    }
  }, [])

  return isMobile
}

