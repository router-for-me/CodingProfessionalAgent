import * as electron from 'electron'

export interface PowerSaveBlockerLike {
  start(type: 'prevent-app-suspension' | 'prevent-display-sleep'): number
  stop(id: number): void
  isStarted(id: number): boolean
}

export interface PowerSaveServiceOptions {
  blocker?: PowerSaveBlockerLike
  preventSleepEnabled?: boolean
}

/**
 * Service that manages system sleep prevention via Electron's powerSaveBlocker.
 * Automatically keeps the system awake while tasks, subagents, or runs are active
 * when the preventSleep setting is enabled.
 */
export class PowerSaveService {
  private readonly blocker: PowerSaveBlockerLike | undefined
  private blockerId: number | null = null
  private preventSleepEnabled: boolean
  private hasExplicitUpdate = false
  private isDisposed = false

  // Maps sessionId -> clientId (e.g. 'desktop-main' or web clientId)
  private readonly activeSessions = new Map<string, string>()
  // Active subagent IDs (e.g. subagent:id)
  private readonly activeSubAgents = new Set<string>()

  constructor(options?: PowerSaveServiceOptions) {
    this.preventSleepEnabled = options?.preventSleepEnabled ?? true

    let resolvedBlocker: PowerSaveBlockerLike | undefined = options?.blocker
    if (!resolvedBlocker) {
      try {
        const psb = Reflect.get(electron, 'powerSaveBlocker')
        if (psb && typeof psb.start === 'function') {
          resolvedBlocker = psb as PowerSaveBlockerLike
        }
      } catch {
        // Fallback when electron or powerSaveBlocker is not available
      }
    }
    this.blocker = resolvedBlocker
  }

  /**
   * Sets whether sleep prevention is enabled according to user settings.
   * If isInitialKvLoad is true, it will not overwrite explicit user RPC updates.
   */
  public setPreventSleepEnabled(enabled: boolean, isInitialKvLoad = false): void {
    if (this.isDisposed) {
      return
    }
    if (isInitialKvLoad && this.hasExplicitUpdate) {
      return
    }
    if (!isInitialKvLoad) {
      this.hasExplicitUpdate = true
    }
    if (this.preventSleepEnabled === enabled) {
      return
    }
    this.preventSleepEnabled = enabled
    this.updateBlocker()
  }

  /**
   * Returns whether the prevent sleep setting is enabled.
   */
  public isPreventSleepEnabled(): boolean {
    return this.preventSleepEnabled
  }

  /**
   * Updates session run status and adjusts sleep blocker accordingly.
   * Active statuses: 'running' | 'thinking' | 'tool'.
   * Inactive statuses: 'idle' | 'error' | 'aborted'.
   */
  public handleRunStatus(sessionId: string, status: string, clientId = 'desktop-main'): void {
    if (this.isDisposed || !sessionId) {
      return
    }

    if (status === 'running' || status === 'thinking' || status === 'tool') {
      this.activeSessions.set(sessionId, clientId)
    } else if (status === 'idle' || status === 'error' || status === 'aborted') {
      this.activeSessions.delete(sessionId)
    }

    this.updateBlocker()
  }

  /**
   * Updates subagent status and adjusts sleep blocker accordingly.
   * Active statuses: 'queued' | 'running'.
   * Inactive statuses: 'completed' | 'error' | 'aborted' | 'idle'.
   */
  public handleSubAgentStatus(agentId: string, status: string): void {
    if (this.isDisposed || !agentId) {
      return
    }

    if (status === 'running' || status === 'queued') {
      this.activeSubAgents.add(agentId)
    } else if (status === 'completed' || status === 'error' || status === 'aborted' || status === 'idle') {
      this.activeSubAgents.delete(agentId)
    }

    this.updateBlocker()
  }

  /**
   * Cleans up runs for a specific client (e.g. on web client disconnect or desktop renderer gone)
   * without wiping runs from other clients.
   */
  public cleanupClient(clientId: string): void {
    if (this.isDisposed || !clientId) {
      return
    }

    let changed = false
    for (const [sessionId, client] of this.activeSessions.entries()) {
      if (client === clientId) {
        this.activeSessions.delete(sessionId)
        changed = true
      }
    }

    if (changed) {
      this.updateBlocker()
    }
  }

  /**
   * Synchronizes active session IDs in batch.
   */
  public syncActiveSessions(sessionIds: string[], clientId = 'desktop-main'): void {
    if (this.isDisposed) {
      return
    }
    this.activeSessions.clear()
    for (const id of sessionIds) {
      if (id) {
        this.activeSessions.set(id, clientId)
      }
    }
    this.updateBlocker()
  }

  /**
   * Clears all active sessions and subagents (e.g. on full service reset).
   */
  public clearActiveSessions(): void {
    if (this.isDisposed || (this.activeSessions.size === 0 && this.activeSubAgents.size === 0)) {
      return
    }
    this.activeSessions.clear()
    this.activeSubAgents.clear()
    this.updateBlocker()
  }

  /**
   * Returns the number of currently active task sessions and subagents combined.
   */
  public getActiveSessionCount(): number {
    return this.activeSessions.size + this.activeSubAgents.size
  }

  /**
   * Returns whether the powerSaveBlocker is currently active.
   */
  public isBlockerActive(): boolean {
    return this.blockerId !== null
  }

  /**
   * Returns the current powerSaveBlocker ID, or null if none active.
   */
  public getBlockerId(): number | null {
    return this.blockerId
  }

  /**
   * Disposes the service and ensures any active blocker is released.
   */
  public dispose(): void {
    this.isDisposed = true
    this.stopBlocker()
    this.activeSessions.clear()
    this.activeSubAgents.clear()
  }

  private hasActiveTasks(): boolean {
    return this.activeSessions.size > 0 || this.activeSubAgents.size > 0
  }

  private updateBlocker(): void {
    if (this.isDisposed) {
      this.stopBlocker()
      return
    }

    const shouldBlock = this.preventSleepEnabled && this.hasActiveTasks()

    if (shouldBlock) {
      this.startBlocker()
    } else {
      this.stopBlocker()
    }
  }

  private startBlocker(): void {
    if (this.isDisposed) {
      return
    }

    if (this.blockerId !== null) {
      try {
        if (this.blocker?.isStarted(this.blockerId)) {
          return
        }
      } catch {
        // Query failed, reset handle
      }
      this.blockerId = null
    }

    if (!this.blocker || typeof this.blocker.start !== 'function') {
      return
    }

    try {
      this.blockerId = this.blocker.start('prevent-app-suspension')
    } catch (err) {
      console.warn('[PowerSaveService] Failed to start powerSaveBlocker:', err)
      this.blockerId = null
    }
  }

  private stopBlocker(): void {
    if (this.blockerId === null) {
      return
    }

    const idToStop = this.blockerId

    if (!this.blocker || typeof this.blocker.stop !== 'function') {
      this.blockerId = null
      return
    }

    try {
      let isRunning = true
      if (typeof this.blocker.isStarted === 'function') {
        isRunning = this.blocker.isStarted(idToStop)
      }
      if (isRunning) {
        this.blocker.stop(idToStop)
      }
      this.blockerId = null
    } catch (err) {
      console.warn('[PowerSaveService] Failed to stop powerSaveBlocker:', err)
      // Retain blockerId so a subsequent stop or dispose can retry
    }
  }
}
