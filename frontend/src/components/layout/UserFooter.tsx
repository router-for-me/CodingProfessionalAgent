import { useEffect, useRef, useState } from 'react'
import { Activity, Component, Settings } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  requireAuthenticatedResponse,
  WebAuthenticationRequiredError,
} from '@/features/web-auth/webAuthClient'
import {
  isDevMode,
  isNativeRuntime,
  getHostBridge,
  saveFileDialog,
} from '@/application/services/hostTransport'
import { cn } from '@/lib/cn'
import { formatProfilingReportMarkdown } from '@/lib/profilingReport'
import {
  activateReactGrab,
  isReactGrabActive,
  isReactGrabLoading,
} from '@/lib/reactGrab'
import { useUiStore } from '@/stores/uiStore'
import { ResumePromptBanner } from './ResumePromptBanner'

function getProfileReportFilename(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const yyyy = date.getFullYear()
  const MM = pad(date.getMonth() + 1)
  const dd = pad(date.getDate())
  const HH = pad(date.getHours())
  const mm = pad(date.getMinutes())
  const ss = pad(date.getSeconds())
  return `cpa-profile-report-${yyyy}-${MM}-${dd}-${HH}${mm}${ss}.md`
}

function DevControls() {
  const { t } = useTranslation()
  const pushToast = useUiStore((s) => s.pushToast)

  // Dev Profiling state
  const [isProfiling, setIsProfiling] = useState(false)
  const [remainingSeconds, setRemainingSeconds] = useState(60)
  const isProfilingRef = useRef(false)
  const isStoppingRef = useRef(false)
  const isStartingRef = useRef(false)

  // React Grab activation state
  const [reactGrabActive, setReactGrabActive] = useState(isReactGrabActive)
  const [reactGrabLoading, setReactGrabLoading] = useState(isReactGrabLoading)

  useEffect(() => {
    if (!isProfiling) {
      return
    }

    const interval = setInterval(() => {
      setRemainingSeconds((prev) => (prev > 0 ? prev - 1 : 0))
    }, 1000)

    return () => {
      clearInterval(interval)
    }
  }, [isProfiling])

  useEffect(() => {
    if (isProfiling && remainingSeconds <= 0) {
      void stopAndSaveProfiling()
    }
  }, [isProfiling, remainingSeconds])

  const stopAndSaveProfiling = async () => {
    if (isStoppingRef.current) return
    isStoppingRef.current = true

    try {
      let stopRes: any
      if (isNativeRuntime()) {
        const bridge = getHostBridge()
        stopRes = await bridge.stopProfiling?.()
      } else {
        const res = await fetch('/api/profile/stop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }).catch((err) => {
          if (err instanceof WebAuthenticationRequiredError) throw err
          return null
        })
        if (res) {
          requireAuthenticatedResponse(res)
          if (res.ok) {
            stopRes = await res.json()
          }
        }
      }

      let report: any
      if (stopRes && stopRes.ok !== false && stopRes.report) {
        report = stopRes.report
      } else if (stopRes && !('ok' in stopRes) && stopRes.summary) {
        report = stopRes
      }

      // If stop failed or report is missing, fallback to getProfilingReport
      if (!report) {
        let fallbackRes: any
        if (isNativeRuntime()) {
          const bridge = getHostBridge()
          fallbackRes = await bridge.getProfilingReport?.()
        } else {
          const res = await fetch('/api/profile/report').catch((err) => {
            if (err instanceof WebAuthenticationRequiredError) throw err
            return null
          })
          if (res) {
            requireAuthenticatedResponse(res)
            if (res.ok) {
              fallbackRes = await res.json()
            }
          }
        }

        if (fallbackRes && fallbackRes.ok !== false && fallbackRes.report) {
          report = fallbackRes.report
        } else if (fallbackRes && fallbackRes.summary) {
          report = fallbackRes
        }
      }

      if (!report) {
        pushToast(t('toast.profileFailed'))
        return
      }

      const markdownReport = formatProfilingReportMarkdown(report)
      const defaultPath = getProfileReportFilename()

      const saveOptions = {
        defaultPath,
        title: t('nav.profile'),
        content: markdownReport,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      }

      const saveResult = await saveFileDialog(saveOptions)

      if (saveResult && saveResult.saved) {
        pushToast(t('toast.profileSaved'))
      }
    } catch (err) {
      if (err instanceof WebAuthenticationRequiredError) {
        return
      }
      pushToast(t('toast.profileFailed'))
    } finally {
      setIsProfiling(false)
      isProfilingRef.current = false
      setRemainingSeconds(60)
      isStoppingRef.current = false
    }
  }

  const handleReactGrabClick = async () => {
    if (reactGrabLoading) return
    if (reactGrabActive) {
      pushToast(t('toast.reactGrabActivated'))
      return
    }

    setReactGrabLoading(true)
    try {
      const activated = await activateReactGrab()
      if (activated) {
        setReactGrabActive(true)
        pushToast(t('toast.reactGrabActivated'))
      } else {
        pushToast(t('toast.reactGrabFailed'))
      }
    } catch {
      pushToast(t('toast.reactGrabFailed'))
    } finally {
      setReactGrabLoading(false)
    }
  }

  const handleProfilingClick = async () => {
    if (isStartingRef.current) {
      return
    }

    if (isProfilingRef.current) {
      await stopAndSaveProfiling()
      return
    }

    isStartingRef.current = true
    try {
      let startRes: any
      if (isNativeRuntime()) {
        const bridge = getHostBridge()
        startRes = await bridge.startProfiling?.({
          durationMs: 60000,
          target: 'all',
        })
      } else {
        const res = await fetch('/api/profile/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ durationMs: 60000, target: 'all' }),
        }).catch((err) => {
          if (err instanceof WebAuthenticationRequiredError) throw err
          return null
        })
        if (res) {
          requireAuthenticatedResponse(res)
          if (res.ok) {
            startRes = await res.json()
          }
        }
      }

      if (startRes && startRes.ok === false) {
        pushToast(t('toast.profileFailed'))
        setIsProfiling(false)
        isProfilingRef.current = false
        setRemainingSeconds(60)
        return
      }

      setRemainingSeconds(60)
      setIsProfiling(true)
      isProfilingRef.current = true
      isStoppingRef.current = false
    } catch (err) {
      if (err instanceof WebAuthenticationRequiredError) {
        return
      }
      pushToast(t('toast.profileFailed'))
      setIsProfiling(false)
      isProfilingRef.current = false
      setRemainingSeconds(60)
    } finally {
      isStartingRef.current = false
    }
  }

  return (
    <>
      <button
        type="button"
        aria-label={
          reactGrabActive
            ? t('nav.reactGrabActive')
            : reactGrabLoading
              ? t('nav.reactGrabLoading')
              : t('nav.reactGrab')
        }
        title={
          reactGrabActive
            ? t('nav.reactGrabActive')
            : reactGrabLoading
              ? t('nav.reactGrabLoading')
              : t('nav.reactGrab')
        }
        className={cn(
          'flex size-7 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
          reactGrabActive &&
            'bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 hover:text-emerald-300',
          reactGrabLoading && 'opacity-70 cursor-wait',
        )}
        onClick={handleReactGrabClick}
        disabled={reactGrabLoading}
      >
        <Component
          className={cn(
            'size-3.5',
            reactGrabLoading && 'animate-spin',
            reactGrabActive && 'text-emerald-400',
          )}
        />
      </button>
      <button
        type="button"
        aria-label={
          isProfiling
            ? t('nav.profilingActive', { seconds: remainingSeconds })
            : t('nav.profile')
        }
        title={
          isProfiling
            ? t('nav.profilingActive', { seconds: remainingSeconds })
            : t('nav.profile')
        }
        className={cn(
          'flex h-7 shrink-0 items-center justify-center gap-1 rounded-md px-1.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
          isProfiling &&
            'bg-red-500/10 text-red-400 hover:bg-red-500/20 hover:text-red-300',
        )}
        onClick={handleProfilingClick}
      >
        <Activity
          className={cn(
            'size-3.5',
            isProfiling && 'animate-pulse text-red-400',
          )}
        />
        {isProfiling && (
          <span className="text-[10px] font-mono font-medium leading-none">
            {remainingSeconds}s
          </span>
        )}
      </button>
    </>
  )
}

/**
 * Sidebar footer strip with dev controls and settings button.
 */
export function UserFooter() {
  const { t } = useTranslation()
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen)
  const isDev = Boolean(import.meta.env.DEV || isDevMode())

  return (
    <>
      <ResumePromptBanner />
      <div className="relative flex shrink-0 items-center justify-end gap-1 border-t border-[var(--border-subtle)] px-2.5 py-2">
        {isDev && <DevControls />}
        <button
          type="button"
          aria-label={t('settings.title')}
          title={t('settings.title')}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]"
          onClick={() => setSettingsOpen(true)}
        >
          <Settings className="size-4" />
        </button>
      </div>
    </>
  )
}
