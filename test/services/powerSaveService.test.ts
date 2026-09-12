import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PowerSaveService, type PowerSaveBlockerLike } from '../../src/main/services/powerSaveService.js'

describe('PowerSaveService', () => {
  let mockBlocker: PowerSaveBlockerLike
  let startedBlockers: Set<number>
  let nextBlockerId = 1

  beforeEach(() => {
    startedBlockers = new Set()
    nextBlockerId = 1
    mockBlocker = {
      start: vi.fn((_type: 'prevent-app-suspension' | 'prevent-display-sleep') => {
        const id = nextBlockerId++
        startedBlockers.add(id)
        return id
      }),
      stop: vi.fn((id: number) => {
        startedBlockers.delete(id)
      }),
      isStarted: vi.fn((id: number) => startedBlockers.has(id)),
    }
  })

  it('initializes with preventSleep enabled by default and no active blocker when idle', () => {
    const service = new PowerSaveService({ blocker: mockBlocker })
    expect(service.isPreventSleepEnabled()).toBe(true)
    expect(service.getActiveSessionCount()).toBe(0)
    expect(service.isBlockerActive()).toBe(false)
    expect(service.getBlockerId()).toBeNull()
    expect(mockBlocker.start).not.toHaveBeenCalled()
  })

  it('starts powerSaveBlocker when a task runs and preventSleep is enabled', () => {
    const service = new PowerSaveService({ blocker: mockBlocker, preventSleepEnabled: true })

    service.handleRunStatus('session-1', 'running')

    expect(service.getActiveSessionCount()).toBe(1)
    expect(service.isBlockerActive()).toBe(true)
    expect(service.getBlockerId()).toBe(1)
    expect(mockBlocker.start).toHaveBeenCalledWith('prevent-app-suspension')
  })

  it('supports thinking and tool statuses as active tasks', () => {
    const service = new PowerSaveService({ blocker: mockBlocker, preventSleepEnabled: true })

    service.handleRunStatus('session-1', 'thinking')
    expect(service.isBlockerActive()).toBe(true)

    service.handleRunStatus('session-1', 'tool')
    expect(service.isBlockerActive()).toBe(true)
  })

  it('stops powerSaveBlocker when the task finishes and transitions to idle', () => {
    const service = new PowerSaveService({ blocker: mockBlocker, preventSleepEnabled: true })

    service.handleRunStatus('session-1', 'running')
    expect(service.isBlockerActive()).toBe(true)

    service.handleRunStatus('session-1', 'idle')
    expect(service.getActiveSessionCount()).toBe(0)
    expect(service.isBlockerActive()).toBe(false)
    expect(service.getBlockerId()).toBeNull()
    expect(mockBlocker.stop).toHaveBeenCalledWith(1)
  })

  it('stops powerSaveBlocker when task errors or aborts', () => {
    const service = new PowerSaveService({ blocker: mockBlocker, preventSleepEnabled: true })

    service.handleRunStatus('session-1', 'running')
    expect(service.isBlockerActive()).toBe(true)

    service.handleRunStatus('session-1', 'error')
    expect(service.isBlockerActive()).toBe(false)

    service.handleRunStatus('session-2', 'running')
    expect(service.isBlockerActive()).toBe(true)

    service.handleRunStatus('session-2', 'aborted')
    expect(service.isBlockerActive()).toBe(false)
  })

  it('tracks subagents lifecycle independently', () => {
    const service = new PowerSaveService({ blocker: mockBlocker, preventSleepEnabled: true })

    service.handleSubAgentStatus('sub-1', 'queued')
    expect(service.getActiveSessionCount()).toBe(1)
    expect(service.isBlockerActive()).toBe(true)

    service.handleSubAgentStatus('sub-1', 'running')
    expect(service.getActiveSessionCount()).toBe(1)
    expect(service.isBlockerActive()).toBe(true)

    service.handleSubAgentStatus('sub-1', 'completed')
    expect(service.getActiveSessionCount()).toBe(0)
    expect(service.isBlockerActive()).toBe(false)
  })

  it('keeps blocker active when parent session completes but subagent is still running', () => {
    const service = new PowerSaveService({ blocker: mockBlocker, preventSleepEnabled: true })

    service.handleRunStatus('parent-session', 'running')
    service.handleSubAgentStatus('sub-agent-1', 'running')
    expect(service.getActiveSessionCount()).toBe(2)
    expect(service.isBlockerActive()).toBe(true)

    // Parent completes, subagent continues
    service.handleRunStatus('parent-session', 'idle')
    expect(service.getActiveSessionCount()).toBe(1)
    expect(service.isBlockerActive()).toBe(true)
    expect(mockBlocker.stop).not.toHaveBeenCalled()

    // Subagent completes
    service.handleSubAgentStatus('sub-agent-1', 'completed')
    expect(service.getActiveSessionCount()).toBe(0)
    expect(service.isBlockerActive()).toBe(false)
    expect(mockBlocker.stop).toHaveBeenCalledWith(1)
  })

  it('cleans up runs only for the specified client on desktop renderer gone, preserving web tasks', () => {
    const service = new PowerSaveService({ blocker: mockBlocker, preventSleepEnabled: true })

    // Desktop main task and Web task running concurrently
    service.handleRunStatus('desktop-sess', 'running', 'desktop-main')
    service.handleRunStatus('web-sess', 'running', 'web:client-123')
    expect(service.getActiveSessionCount()).toBe(2)
    expect(service.isBlockerActive()).toBe(true)

    // Desktop crashes/cleans up
    service.cleanupClient('desktop-main')

    // Web task is still running, blocker MUST remain active
    expect(service.getActiveSessionCount()).toBe(1)
    expect(service.isBlockerActive()).toBe(true)
    expect(mockBlocker.stop).not.toHaveBeenCalled()

    // Web task finishes
    service.handleRunStatus('web-sess', 'idle', 'web:client-123')
    expect(service.getActiveSessionCount()).toBe(0)
    expect(service.isBlockerActive()).toBe(false)
    expect(mockBlocker.stop).toHaveBeenCalledWith(1)
  })

  it('protects against KV startup read overwriting explicit user RPC update', () => {
    const service = new PowerSaveService({ blocker: mockBlocker })

    // User explicitly switches off via RPC
    service.setPreventSleepEnabled(false, false)
    expect(service.isPreventSleepEnabled()).toBe(false)

    // Late startup KV load returns true (old persisted state)
    service.setPreventSleepEnabled(true, true)
    // Must NOT be overwritten
    expect(service.isPreventSleepEnabled()).toBe(false)
  })

  it('stops active blocker when preventSleep is toggled off while tasks are running', () => {
    const service = new PowerSaveService({ blocker: mockBlocker, preventSleepEnabled: true })

    service.handleRunStatus('session-1', 'running')
    expect(service.isBlockerActive()).toBe(true)

    service.setPreventSleepEnabled(false)
    expect(service.isBlockerActive()).toBe(false)
    expect(mockBlocker.stop).toHaveBeenCalledWith(1)
  })

  it('starts blocker when preventSleep is toggled on while tasks are already running', () => {
    const service = new PowerSaveService({ blocker: mockBlocker, preventSleepEnabled: false })

    service.handleRunStatus('session-1', 'running')
    expect(service.isBlockerActive()).toBe(false)

    service.setPreventSleepEnabled(true)
    expect(service.isBlockerActive()).toBe(true)
    expect(mockBlocker.start).toHaveBeenCalledWith('prevent-app-suspension')
  })

  it('does not start blocker when toggled on if no tasks are running', () => {
    const service = new PowerSaveService({ blocker: mockBlocker, preventSleepEnabled: false })

    service.setPreventSleepEnabled(true)
    expect(service.isBlockerActive()).toBe(false)
    expect(mockBlocker.start).not.toHaveBeenCalled()
  })

  it('syncs active sessions in batch', () => {
    const service = new PowerSaveService({ blocker: mockBlocker, preventSleepEnabled: true })

    service.syncActiveSessions(['sess-a', 'sess-b'])
    expect(service.getActiveSessionCount()).toBe(2)
    expect(service.isBlockerActive()).toBe(true)

    service.syncActiveSessions([])
    expect(service.getActiveSessionCount()).toBe(0)
    expect(service.isBlockerActive()).toBe(false)
  })

  it('clears active sessions and stops blocker', () => {
    const service = new PowerSaveService({ blocker: mockBlocker, preventSleepEnabled: true })

    service.handleRunStatus('session-1', 'running')
    expect(service.isBlockerActive()).toBe(true)

    service.clearActiveSessions()
    expect(service.getActiveSessionCount()).toBe(0)
    expect(service.isBlockerActive()).toBe(false)
  })

  it('handles exceptions in blocker gracefully without unhandled crash', () => {
    const failingBlocker: PowerSaveBlockerLike = {
      start: vi.fn(() => {
        throw new Error('OS permission denied')
      }),
      stop: vi.fn(() => {
        throw new Error('OS stop error')
      }),
      isStarted: vi.fn(() => true),
    }

    const service = new PowerSaveService({ blocker: failingBlocker, preventSleepEnabled: true })
    expect(() => service.handleRunStatus('sess-1', 'running')).not.toThrow()
    expect(service.getBlockerId()).toBeNull()
  })

  it('disposes cleanly and refuses to re-activate on late task events', () => {
    const service = new PowerSaveService({ blocker: mockBlocker, preventSleepEnabled: true })

    service.handleRunStatus('session-1', 'running')
    expect(service.isBlockerActive()).toBe(true)

    service.dispose()
    expect(service.isBlockerActive()).toBe(false)
    expect(service.getActiveSessionCount()).toBe(0)
    expect(mockBlocker.stop).toHaveBeenCalledWith(1)

    // Late run status event after dispose
    service.handleRunStatus('session-2', 'running')
    expect(service.isBlockerActive()).toBe(false)
    expect(mockBlocker.start).toHaveBeenCalledTimes(1) // Only the initial one
  })

  it('handles empty or invalid inputs gracefully', () => {
    const service = new PowerSaveService({ blocker: mockBlocker })
    service.handleRunStatus('', 'running')
    service.handleSubAgentStatus('', 'running')
    expect(service.getActiveSessionCount()).toBe(0)
    expect(service.isBlockerActive()).toBe(false)
  })
})
