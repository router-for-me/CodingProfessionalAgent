import { app, Notification, type BrowserWindow } from 'electron'
import type { NativeEvent } from '../../shared/types.js'
import { createWindowsBadgeOverlay } from './badgeIconHelper.js'

export interface TaskCompletedNotificationPayload {
  sessionId: string
  sessionTitle?: string
}

export interface NotificationBadgeStatus {
  badgeCount: number
  isWindowFocused: boolean
}

export const APP_USER_MODEL_ID = 'com.earendil.coding-professional-agent'

/**
 * Registers the Windows Application User Model ID (AppUserModelId) on Windows for proper
 * taskbar icon grouping, notification routing, and badge overlay support.
 *
 * @param appInstance - Optional Electron app instance (defaults to electron app)
 * @param platform - Optional platform string (defaults to process.platform)
 * @returns true if registered on win32, false otherwise
 */
export function registerWin32AppUserModelId(
  appInstance?: Pick<typeof app, 'setAppUserModelId'>,
  platform: string = process.platform
): boolean {
  const targetApp = appInstance ?? app
  if (platform === 'win32' && typeof targetApp?.setAppUserModelId === 'function') {
    targetApp.setAppUserModelId(APP_USER_MODEL_ID)
    return true
  }
  return false
}

export class NotificationBadgeService {
  private badgeCount = 0
  private getMainWindow: () => BrowserWindow | null
  private attachedWindow: BrowserWindow | null = null
  private emitEvent?: (event: NativeEvent) => void

  constructor(
    getMainWindow?: () => BrowserWindow | null,
    emitEvent?: (event: NativeEvent) => void
  ) {
    this.getMainWindow = getMainWindow ?? (() => this.attachedWindow)
    this.emitEvent = emitEvent
  }

  /**
   * Attaches the main browser window to listen for focus events and automatically clear badges.
   */
  attachWindow(win: BrowserWindow): void {
    this.attachedWindow = win
    if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return
    win.on('focus', () => {
      this.clearBadge()
    })
  }

  /**
   * Returns current unread badge count and window focus status.
   */
  getStatus(): NotificationBadgeStatus {
    const win = this.getMainWindow()
    const isFocused = Boolean(
      win &&
      !win.isDestroyed() &&
      win.isFocused() &&
      !win.isMinimized()
    )
    return {
      badgeCount: this.badgeCount,
      isWindowFocused: isFocused,
    }
  }

  /**
   * Notifies the user that a background task has completed if window is unfocused or minimized.
   */
  notifyTaskCompleted(payload: TaskCompletedNotificationPayload): void {
    const win = this.getMainWindow()
    const isFocused = Boolean(
      win &&
      !win.isDestroyed() &&
      win.isFocused() &&
      !win.isMinimized()
    )

    // If application is active and focused in foreground, do not disturb user
    if (isFocused) {
      return
    }

    this.badgeCount += 1
    this.applyPlatformBadge()

    const rawTitle = (payload.sessionTitle || '').trim()
    const title = rawTitle ? (rawTitle.length > 40 ? `${rawTitle.slice(0, 40)}...` : rawTitle) : ''
    const bodyText = title ? `${title} 任务已经完成` : '任务已经完成'

    try {
      const notification = new Notification({
        title: 'Coding Professional Agent',
        body: bodyText,
        silent: false,
      })

      notification.on('click', () => {
        try {
          const activeWin = this.getMainWindow()
          if (activeWin && !activeWin.isDestroyed()) {
            if (activeWin.isMinimized?.()) activeWin.restore()
            if (!activeWin.isVisible || !activeWin.isVisible()) activeWin.show()
            activeWin.focus()
            if (activeWin.webContents && !activeWin.webContents.isDestroyed()) {
              activeWin.webContents.send('notification:navigate-session', payload.sessionId)
            }
          }
        } catch {
          // Ignore window activation or IPC errors
        } finally {
          this.emitEvent?.({
            operationId: `notif-${Date.now()}`,
            sequence: Date.now(),
            kind: 'notification:navigate-session',
            data: JSON.stringify({ sessionId: payload.sessionId }),
          })
          this.clearBadge()
        }
      })

      notification.show()
    } catch {
      // Ignore native notification errors (e.g. headless Linux or missing notification daemon)
    }
  }

  /**
   * Clears dock/taskbar badges and stops window frame flashing.
   */
  clearBadge(): void {
    if (this.badgeCount === 0) {
      const win = this.getMainWindow()
      if (win && !win.isDestroyed()) {
        try {
          win.flashFrame(false)
        } catch {
          // Ignore window disposal race
        }
      }
      return
    }

    this.badgeCount = 0

    if (process.platform === 'darwin') {
      try {
        app.dock?.setBadge('')
      } catch {
        // Ignore dock error
      }
    } else if (process.platform === 'win32') {
      const win = this.getMainWindow()
      if (win && !win.isDestroyed()) {
        try {
          win.setOverlayIcon(null, '')
          win.flashFrame(false)
        } catch {
          // Ignore overlay error
        }
      }
    } else {
      const win = this.getMainWindow()
      if (win && !win.isDestroyed()) {
        try {
          win.flashFrame(false)
        } catch {
          // Ignore flashFrame error
        }
      }
      try {
        app.setBadgeCount?.(0)
      } catch {
        // Ignore setBadgeCount error
      }
    }
  }

  /**
   * Applies the platform-specific visual badge indicator.
   */
  private applyPlatformBadge(): void {
    const count = this.badgeCount
    if (process.platform === 'darwin') {
      try {
        app.dock?.setBadge(String(count))
        app.dock?.bounce?.('informational')
      } catch {
        // Ignore dock error
      }
    } else if (process.platform === 'win32') {
      const win = this.getMainWindow()
      if (win && !win.isDestroyed()) {
        try {
          const overlay = createWindowsBadgeOverlay(count)
          win.setOverlayIcon(overlay, `${count} unread completed tasks`)
          win.flashFrame(true)
        } catch {
          // Ignore overlay error
        }
      }
    } else {
      const win = this.getMainWindow()
      if (win && !win.isDestroyed()) {
        try {
          win.flashFrame(true)
        } catch {
          // Ignore flashFrame error
        }
      }
      try {
        app.setBadgeCount?.(count)
      } catch {
        // Ignore setBadgeCount error
      }
    }
  }
}
