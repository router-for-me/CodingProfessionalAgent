import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { UpdateStateStorage } from '../../../../src/main/services/update/updateStateStorage.js'

describe('UpdateStateStorage', () => {
    let tempDir: string
    let storage: UpdateStateStorage

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-update-test-'))
        storage = new UpdateStateStorage({ runtimeDir: tempDir, baseVersion: '1.0.0' })
    })

    afterEach(() => {
        try {
            fs.rmSync(tempDir, { recursive: true, force: true })
        } catch {}
    })

    it('initializes with default state when file does not exist', () => {
        const state = storage.loadState()
        expect(state.activeVersion).toBe('1.0.0')
        expect(state.baseBinaryVersion).toBe('1.0.0')
        expect(state.consecutiveFailures).toBe(0)
        expect(state.activeAsarPath).toBeNull()
        expect(state.pendingVersion).toBeNull()
        expect(state.pendingAsarPath).toBeNull()
        expect(state.lastCheckTime).toBeNull()
    })

    it('returns runtimeDir via getRuntimeDir', () => {
        expect(storage.getRuntimeDir()).toBe(tempDir)
    })

    it('uses fallback values on corrupted JSON state file', () => {
        const stateFile = path.join(tempDir, 'update-state.json')
        fs.writeFileSync(stateFile, 'invalid-json{{{', 'utf8')

        const state = storage.loadState()
        expect(state.activeVersion).toBe('1.0.0')
        expect(state.consecutiveFailures).toBe(0)
        expect(state.activeAsarPath).toBeNull()
    })

    it('ignores activatePendingVersion when no pending version exists', () => {
        const before = storage.loadState()
        storage.activatePendingVersion()
        const after = storage.loadState()
        expect(after).toEqual(before)
    })

    it('increments consecutive failures and triggers rollback after 2 failures', () => {
        storage.recordPendingVersion('1.1.0', 'versions/1.1.0/app.asar')
        storage.activatePendingVersion()

        expect(storage.loadState().activeVersion).toBe('1.1.0')

        // First crash before health check
        const failures1 = storage.incrementFailure()
        expect(failures1).toBe(1)
        expect(storage.shouldRollback()).toBe(false)

        // Second crash
        const failures2 = storage.incrementFailure()
        expect(failures2).toBe(2)
        expect(storage.shouldRollback()).toBe(true)

        // Trigger rollback
        const rolledBackState = storage.rollbackToBase()
        expect(rolledBackState.activeVersion).toBe('1.0.0')
        expect(rolledBackState.activeAsarPath).toBeNull()
        expect(rolledBackState.consecutiveFailures).toBe(0)
    })

    it('does not trigger rollback when consecutive failures >= 2 but activeAsarPath is null', () => {
        storage.incrementFailure()
        storage.incrementFailure()
        expect(storage.loadState().consecutiveFailures).toBe(2)
        expect(storage.loadState().activeAsarPath).toBeNull()
        expect(storage.shouldRollback()).toBe(false)
    })

    it('clears failure count upon health confirmation', () => {
        storage.incrementFailure()
        expect(storage.loadState().consecutiveFailures).toBe(1)
        storage.confirmHealthy()
        expect(storage.loadState().consecutiveFailures).toBe(0)

        // Calling when already 0 is a no-op
        storage.confirmHealthy()
        expect(storage.loadState().consecutiveFailures).toBe(0)
    })

    it('automatically updates baseBinaryVersion and resets hot-patch state when runtime baseVersion is newer than stored baseBinaryVersion', () => {
        // Setup state with an active hot patch from old base 1.0.0
        storage.recordPendingVersion('1.0.1', 'versions/1.0.1/app.asar')
        storage.activatePendingVersion()
        storage.incrementFailure()

        const stateBefore = storage.loadState()
        expect(stateBefore.baseBinaryVersion).toBe('1.0.0')
        expect(stateBefore.activeVersion).toBe('1.0.1')
        expect(stateBefore.activeAsarPath).toBe('versions/1.0.1/app.asar')
        expect(stateBefore.consecutiveFailures).toBe(1)

        // Now simulate user installing new full installer 1.1.0
        const upgradedStorage = new UpdateStateStorage({ runtimeDir: tempDir, baseVersion: '1.1.0' })
        const stateAfter = upgradedStorage.loadState()

        expect(stateAfter.baseBinaryVersion).toBe('1.1.0')
        expect(stateAfter.activeVersion).toBe('1.1.0')
        expect(stateAfter.activeAsarPath).toBeNull()
        expect(stateAfter.pendingVersion).toBeNull()
        expect(stateAfter.pendingAsarPath).toBeNull()
        expect(stateAfter.consecutiveFailures).toBe(0)
    })

    it('does not reset hot-patch state when runtime baseVersion matches activeVersion', () => {
        // Setup state with an active hot patch 1.0.14
        storage.recordPendingVersion('1.0.14', 'versions/1.0.14/app.asar')
        storage.activatePendingVersion()

        // When runtime incorrectly passes activeVersion as baseVersion (e.g. via app.getVersion()),
        // it must NOT treat it as a new full base binary installer.
        const sameStorage = new UpdateStateStorage({ runtimeDir: tempDir, baseVersion: '1.0.14' })
        const state = sameStorage.loadState()

        expect(state.baseBinaryVersion).toBe('1.0.0')
        expect(state.activeVersion).toBe('1.0.14')
        expect(state.activeAsarPath).toBe('versions/1.0.14/app.asar')
    })

    it('auto-heals missing activeAsarPath when activeVersion asar file exists on disk', () => {
        const versionsDir = path.join(tempDir, 'versions', '1.0.14')
        fs.mkdirSync(versionsDir, { recursive: true })
        fs.writeFileSync(path.join(versionsDir, 'app.asar'), 'dummy asar content')

        // Simulate a corrupted state where activeAsarPath is null but 1.0.14 is active
        const corruptedState = {
            activeVersion: '1.0.14',
            activeAsarPath: null,
            baseBinaryVersion: '1.0.14',
            consecutiveFailures: 0,
            pendingVersion: null,
            pendingAsarPath: null,
            lastCheckTime: null,
        }
        const stateFile = path.join(tempDir, 'update-state.json')
        fs.writeFileSync(stateFile, JSON.stringify(corruptedState, null, 2), 'utf8')

        const healingStorage = new UpdateStateStorage({ runtimeDir: tempDir, baseVersion: '1.0.0' })
        const state = healingStorage.loadState()

        expect(state.baseBinaryVersion).toBe('1.0.0')
        expect(state.activeVersion).toBe('1.0.14')
        expect(state.activeAsarPath).toBe(path.join('versions', '1.0.14', 'app.asar'))
    })

    it('constructs with default options', () => {
        const defaultStorage = new UpdateStateStorage()
        expect(defaultStorage.getRuntimeDir()).toContain('.coding-professional-agent')
    })
})
