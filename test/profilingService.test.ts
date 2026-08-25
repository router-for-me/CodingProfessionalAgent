import { EventEmitter } from 'node:events'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
    ProfilingService,
    isProfilingEnabled,
    mergeProfiles,
    type V8CpuProfile,
} from '../src/main/services/profilingService.js'

describe('isProfilingEnabled', () => {
    const originalEnv = process.env.CPA_PROFILE

    afterEach(() => {
        if (originalEnv !== undefined) {
            process.env.CPA_PROFILE = originalEnv
        } else {
            delete process.env.CPA_PROFILE
        }
    })

    it('should respect CPA_PROFILE=1 or true', () => {
        process.env.CPA_PROFILE = '1'
        expect(isProfilingEnabled(false)).toBe(true)

        process.env.CPA_PROFILE = 'true'
        expect(isProfilingEnabled(false)).toBe(true)
    })

    it('should respect CPA_PROFILE=0 or false', () => {
        process.env.CPA_PROFILE = '0'
        expect(isProfilingEnabled(true)).toBe(false)

        process.env.CPA_PROFILE = 'false'
        expect(isProfilingEnabled(true)).toBe(false)
    })

    it('should fallback to isDebug when CPA_PROFILE is unset', () => {
        delete process.env.CPA_PROFILE
        expect(isProfilingEnabled(true)).toBe(true)
        expect(isProfilingEnabled(false)).toBe(false)
        expect(isProfilingEnabled(undefined)).toBe(false)
    })
})

describe('mergeProfiles', () => {
    it('returns undefined when both profiles are undefined', () => {
        expect(mergeProfiles(undefined, undefined)).toBeUndefined()
    })

    it('returns single profile when only one is provided', () => {
        const profile: V8CpuProfile = {
            nodes: [
                { id: 1, callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: 0, columnNumber: 0 } },
            ],
            startTime: 1000,
            endTime: 2000,
        }

        expect(mergeProfiles(profile, undefined)).toBe(profile)
        expect(mergeProfiles(undefined, profile)).toBe(profile)
    })

    it('returns other profile when one has empty nodes array', () => {
        const validProfile: V8CpuProfile = {
            nodes: [
                { id: 1, callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: 0, columnNumber: 0 } },
            ],
            startTime: 1000,
            endTime: 2000,
        }
        const emptyProfile: V8CpuProfile = {
            nodes: [],
            startTime: 1000,
            endTime: 2000,
        }

        expect(mergeProfiles(validProfile, emptyProfile)).toBe(validProfile)
        expect(mergeProfiles(emptyProfile, validProfile)).toBe(validProfile)
    })

    it('merges main and renderer profiles with ID offset and attached root children', () => {
        const mainProfile: V8CpuProfile = {
            nodes: [
                { id: 1, callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: 0, columnNumber: 0 }, children: [2] },
                { id: 2, callFrame: { functionName: 'mainFunc', scriptId: '1', url: 'src/main/foo.ts', lineNumber: 10, columnNumber: 1 }, hitCount: 5 },
            ],
            samples: [2, 2, 2],
            timeDeltas: [1000, 1000, 1000],
            startTime: 10000,
            endTime: 13000,
        }

        const rendererProfile: V8CpuProfile = {
            nodes: [
                { id: 1, callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: 0, columnNumber: 0 }, children: [2] },
                { id: 2, callFrame: { functionName: 'rendererFunc', scriptId: '2', url: 'frontend/src/bar.tsx', lineNumber: 20, columnNumber: 2 }, hitCount: 8 },
            ],
            samples: [2, 2],
            timeDeltas: [1000, 1000],
            startTime: 9000,
            endTime: 14000,
        }

        const merged = mergeProfiles(mainProfile, rendererProfile)
        expect(merged).toBeDefined()
        expect(merged?.startTime).toBe(9000)
        expect(merged?.endTime).toBe(14000)

        // Main root (id 1) should now have both node 2 and the offset renderer node
        const mainRoot = merged?.nodes.find((n) => n.id === 1)
        expect(mainRoot).toBeDefined()
        expect(mainRoot?.children).toContain(2)
        // Renderer node 2 was offset by (maxMainId 2 + 1000) = 1002, so offset id is 1004
        expect(mainRoot?.children).toContain(1004)

        // Merged nodes should contain mainFunc and rendererFunc
        const mainNode = merged?.nodes.find((n) => n.callFrame.functionName === 'mainFunc')
        const rendererNode = merged?.nodes.find((n) => n.callFrame.functionName === 'rendererFunc')
        expect(mainNode).toBeDefined()
        expect(rendererNode).toBeDefined()
        expect(rendererNode?.id).toBe(1004)

        // Samples should contain both main samples and offset renderer samples
        expect(merged?.samples).toEqual([2, 2, 2, 1004, 1004])
        expect(merged?.timeDeltas).toEqual([1000, 1000, 1000, 1000, 1000])
    })
})

describe('ProfilingService', () => {
    let service: ProfilingService
    const originalEnv = process.env.CPA_PROFILE

    function createMockRendererWindow(options?: {
        initiallyAttached?: boolean
        attachThrows?: boolean
        rendererProfile?: V8CpuProfile
        delayEnable?: boolean
        delayEnableOnce?: boolean
    }) {
        let attached = Boolean(options?.initiallyAttached)
        let isDestroyed = false
        const commandsSent: string[] = []
        const debuggerEmitter = new EventEmitter()
        const webContentsEmitter = new EventEmitter()
        let enableResolve: (() => void) | null = null
        let delayEnableOncePending = Boolean(options?.delayEnableOnce)

        const defaultProfile: V8CpuProfile = options?.rendererProfile || {
            nodes: [
                { id: 1, callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: 0, columnNumber: 0 }, children: [2] },
                { id: 2, callFrame: { functionName: 'renderComponent', scriptId: '10', url: 'frontend/src/components/App.tsx', lineNumber: 50, columnNumber: 4 }, hitCount: 15 },
            ],
            samples: [2, 2, 2],
            timeDeltas: [1000, 1000, 1000],
            startTime: 20000,
            endTime: 23000,
        }

        const mockDebugger = Object.assign(debuggerEmitter, {
            isAttached: vi.fn(() => attached),
            attach: vi.fn(() => {
                if (options?.attachThrows) {
                    throw new Error('Another debugger is already attached to the target')
                }
                attached = true
            }),
            detach: vi.fn(() => {
                attached = false
                debuggerEmitter.emit('detach', {}, 'target_closed')
            }),
            sendCommand: vi.fn(async (method: string) => {
                commandsSent.push(method)
                if (method === 'Profiler.enable' && (options?.delayEnable || delayEnableOncePending)) {
                    delayEnableOncePending = false
                    await new Promise<void>((resolve) => {
                        enableResolve = resolve
                    })
                }
                if (method === 'Profiler.stop') {
                    return { profile: defaultProfile }
                }
                return {}
            }),
        })

        const mockWebContents = Object.assign(webContentsEmitter, {
            isDestroyed: vi.fn(() => isDestroyed),
            debugger: mockDebugger,
        })

        const mockWin = {
            isDestroyed: vi.fn(() => isDestroyed),
            webContents: mockWebContents,
            destroy: () => {
                isDestroyed = true
                webContentsEmitter.emit('destroyed')
            },
        }

        return {
            mockWin,
            mockDebugger,
            mockWebContents,
            commandsSent,
            defaultProfile,
            resolveEnable: () => {
                if (enableResolve) {
                    enableResolve()
                }
            },
        }
    }

    beforeEach(() => {
        delete process.env.CPA_PROFILE
    })

    afterEach(() => {
        if (originalEnv !== undefined) {
            process.env.CPA_PROFILE = originalEnv
        } else {
            delete process.env.CPA_PROFILE
        }
        service?.dispose()
    })

    it('should report correct initial status when idle', () => {
        service = new ProfilingService({ isDebug: true })
        expect(service.isEnabled()).toBe(true)

        const status = service.getStatus()
        expect(status.running).toBe(false)
        expect(status.enabled).toBe(true)
        expect(status.target).toBe('all')
    })

    it('should reject starting when profiling is disabled', async () => {
        service = new ProfilingService({ isDebug: false })
        expect(service.isEnabled()).toBe(false)

        const result = await service.start({ target: 'main' })
        expect(result.ok).toBe(false)
        expect(result.message).toContain('disabled')
        expect(service.getStatus().running).toBe(false)
    })

    it('should start when CPA_PROFILE=1 even if isDebug is false', async () => {
        process.env.CPA_PROFILE = '1'
        service = new ProfilingService({ isDebug: false })
        expect(service.isEnabled()).toBe(true)

        const startResult = await service.start({ target: 'main' })
        expect(startResult.ok).toBe(true)
        expect(service.getStatus().running).toBe(true)

        const stopResult = await service.stop()
        expect(stopResult.ok).toBe(true)
    })

    it('should start and stop main process profiling and capture V8 cpuprofile', async () => {
        service = new ProfilingService({ isDebug: true })

        const startResult = await service.start({ target: 'main', durationMs: 5000 })
        expect(startResult.ok).toBe(true)

        const statusRunning = service.getStatus()
        expect(statusRunning.running).toBe(true)
        expect(statusRunning.target).toBe('main')
        expect(statusRunning.startedAt).toBeDefined()
        expect(statusRunning.durationMs).toBe(5000)

        // Perform some CPU-bound work
        let sum = 0
        for (let i = 0; i < 50000; i++) {
            sum += Math.sqrt(i)
        }
        expect(sum).toBeGreaterThan(0)

        const stopResult = await service.stop()
        expect(stopResult.ok).toBe(true)
        expect(stopResult.rawProfile).toBeDefined()
        expect(stopResult.rawProfile?.nodes).toBeInstanceOf(Array)
        expect(stopResult.rawProfile?.nodes.length).toBeGreaterThan(0)
        expect(service.getLastProfile()).toEqual(stopResult.rawProfile)

        // Verify report is analyzed and stored
        expect(stopResult.report).toBeDefined()
        expect(stopResult.report?.summary).toBeDefined()
        expect(stopResult.report?.summary.target).toBe('main')
        expect(service.getLastReport()).toEqual(stopResult.report)

        const statusStopped = service.getStatus()
        expect(statusStopped.running).toBe(false)
    })

    it('should profile renderer via CDP when target is renderer', async () => {
        const { mockWin, mockDebugger, commandsSent } = createMockRendererWindow()

        service = new ProfilingService({
            isDebug: true,
            getMainWindow: () => mockWin as any,
        })

        const startResult = await service.start({ target: 'renderer', durationMs: 5000 })
        expect(startResult.ok).toBe(true)
        expect(service.getStatus().running).toBe(true)
        expect(mockDebugger.attach).toHaveBeenCalledWith('1.3')
        expect(commandsSent).toContain('Profiler.enable')
        expect(commandsSent).toContain('Profiler.start')

        const stopResult = await service.stop()
        expect(stopResult.ok).toBe(true)
        expect(commandsSent).toContain('Profiler.stop')
        expect(commandsSent).toContain('Profiler.disable')
        expect(mockDebugger.detach).toHaveBeenCalled()

        expect(stopResult.rawProfile).toBeDefined()
        expect(stopResult.report).toBeDefined()
        expect(stopResult.report?.summary.target).toBe('renderer')
        expect(stopResult.report?.hotspots.some((h) => h.functionName === 'renderComponent')).toBe(true)
    })

    it('should not detach debugger on stop if debugger was already attached before profiling', async () => {
        const { mockWin, mockDebugger } = createMockRendererWindow({ initiallyAttached: true })

        service = new ProfilingService({
            isDebug: true,
            getMainWindow: () => mockWin as any,
        })

        const startResult = await service.start({ target: 'renderer' })
        expect(startResult.ok).toBe(true)
        expect(mockDebugger.attach).not.toHaveBeenCalled()

        const stopResult = await service.stop()
        expect(stopResult.ok).toBe(true)
        expect(mockDebugger.detach).not.toHaveBeenCalled()
    })

    it('should profile both main and renderer when target is all and combine reports', async () => {
        const { mockWin, mockDebugger } = createMockRendererWindow()

        service = new ProfilingService({
            isDebug: true,
        })
        service.attachRenderer(() => mockWin as any)

        const startResult = await service.start({ target: 'all', durationMs: 4000 })
        expect(startResult.ok).toBe(true)
        expect(mockDebugger.attach).toHaveBeenCalledWith('1.3')

        // Do some main work
        let total = 0
        for (let i = 0; i < 20000; i++) total += i
        expect(total).toBeGreaterThan(0)

        const stopResult = await service.stop()
        expect(stopResult.ok).toBe(true)
        expect(mockDebugger.detach).toHaveBeenCalled()

        expect(stopResult.rawProfile).toBeDefined()
        expect(stopResult.report).toBeDefined()
        expect(stopResult.report?.summary.target).toBe('all')
        // Hotspots should include the renderer function
        expect(stopResult.report?.hotspots.some((h) => h.functionName === 'renderComponent')).toBe(true)
    })

    it('should gracefully fallback to main profiling when renderer CDP attach fails', async () => {
        const { mockWin } = createMockRendererWindow({ attachThrows: true })

        service = new ProfilingService({
            isDebug: true,
            getMainWindow: () => mockWin as any,
        })

        // Target 'all' with renderer attach failure
        const startResult = await service.start({ target: 'all' })
        expect(startResult.ok).toBe(true)

        const stopResult = await service.stop()
        expect(stopResult.ok).toBe(true)
        expect(stopResult.rawProfile).toBeDefined()
        expect(stopResult.report?.summary.target).toBe('all')
    })

    it('should gracefully fallback to main profiling when target is renderer but CDP fails', async () => {
        const { mockWin } = createMockRendererWindow({ attachThrows: true })

        service = new ProfilingService({
            isDebug: true,
            getMainWindow: () => mockWin as any,
        })

        // Target 'renderer' with CDP failure falls back to main
        const startResult = await service.start({ target: 'renderer' })
        expect(startResult.ok).toBe(true)

        const stopResult = await service.stop()
        expect(stopResult.ok).toBe(true)
        expect(stopResult.rawProfile).toBeDefined()
    })

    it('should handle destroyed window without crashing on start or stop', async () => {
        const { mockWin } = createMockRendererWindow()
        mockWin.destroy()

        service = new ProfilingService({
            isDebug: true,
            getMainWindow: () => mockWin as any,
        })

        const startResult = await service.start({ target: 'all' })
        expect(startResult.ok).toBe(true)

        const stopResult = await service.stop()
        expect(stopResult.ok).toBe(true)
    })

    it('should clamp durationMs in status when duration exceeds maxDurationMs or is unbounded', async () => {
        service = new ProfilingService({ isDebug: true, maxDurationMs: 10_000 })

        // Unbounded start (no durationMs provided) -> durationMs set to maxDurationMs
        const unboundedStart = await service.start({ target: 'main' })
        expect(unboundedStart.ok).toBe(true)
        expect(service.getStatus().durationMs).toBe(10_000)
        await service.stop()

        // Exceeds maxDurationMs -> clamped to maxDurationMs
        const clampedStart = await service.start({ target: 'main', durationMs: 50_000 })
        expect(clampedStart.ok).toBe(true)
        expect(service.getStatus().durationMs).toBe(10_000)
        await service.stop()

        // Within maxDurationMs -> uses specified durationMs
        const normalStart = await service.start({ target: 'main', durationMs: 3_000 })
        expect(normalStart.ok).toBe(true)
        expect(service.getStatus().durationMs).toBe(3_000)
        await service.stop()
    })

    it('should prevent multiple concurrent profiling sessions', async () => {
        service = new ProfilingService({ isDebug: true })

        const firstStart = await service.start({ target: 'main' })
        expect(firstStart.ok).toBe(true)

        const secondStart = await service.start({ target: 'renderer' })
        expect(secondStart.ok).toBe(false)
        expect(secondStart.message).toContain('already active')

        await service.stop()

        // Can start again after stopping
        const thirdStart = await service.start({ target: 'all' })
        expect(thirdStart.ok).toBe(true)
        await service.stop()
    })

    it('should reject start while stop is still flushing the inspector session', async () => {
        service = new ProfilingService({ isDebug: true })
        const startResult = await service.start({ target: 'main' })
        expect(startResult.ok).toBe(true)

        // Trigger stop without awaiting it immediately
        const stopPromise = service.stop()

        // Attempting to start while stop is in-flight should be rejected
        const secondStartResult = await service.start({ target: 'main' })
        expect(secondStartResult.ok).toBe(false)
        expect(secondStartResult.message).toContain('already active')

        const stopResult = await stopPromise
        expect(stopResult.ok).toBe(true)
        expect(stopResult.rawProfile).toBeDefined()
    })

    it('should let concurrent stop() join the in-flight session and return the profile', async () => {
        service = new ProfilingService({ isDebug: true })
        const startResult = await service.start({ target: 'main' })
        expect(startResult.ok).toBe(true)

        // Trigger concurrent stop() calls
        const [stop1, stop2, stop3] = await Promise.all([
            service.stop(),
            service.stop(),
            service.stop(),
        ])

        expect(stop1.ok).toBe(true)
        expect(stop2.ok).toBe(true)
        expect(stop3.ok).toBe(true)
        expect(stop1.rawProfile).toBeDefined()
        expect(stop2.rawProfile).toBe(stop1.rawProfile)
        expect(stop3.rawProfile).toBe(stop1.rawProfile)
    })

    it('should return error when stopping if not running', async () => {
        service = new ProfilingService({ isDebug: true })

        const stopResult = await service.stop()
        expect(stopResult.ok).toBe(false)
        expect(stopResult.error).toContain('No active profiling session')
    })

    it('should automatically stop when duration timer expires', async () => {
        service = new ProfilingService({ isDebug: true })

        const startResult = await service.start({ target: 'main', durationMs: 50 })
        expect(startResult.ok).toBe(true)
        expect(service.getStatus().running).toBe(true)

        // Poll until the service has automatically stopped and captured the profile
        const maxWaitMs = 3000
        const intervalMs = 20
        const startTime = Date.now()
        while ((service.getStatus().running || !service.getLastProfile()) && Date.now() - startTime < maxWaitMs) {
            await new Promise((resolve) => setTimeout(resolve, intervalMs))
        }

        expect(service.getStatus().running).toBe(false)
        expect(service.getLastProfile()).toBeDefined()
    })

    it('should cleanly dispose running session, debugger and timers', async () => {
        const { mockWin, mockDebugger } = createMockRendererWindow()

        service = new ProfilingService({
            isDebug: true,
            getMainWindow: () => mockWin as any,
        })

        await service.start({ target: 'all', durationMs: 10000 })
        expect(service.getStatus().running).toBe(true)

        service.dispose()
        expect(service.getStatus().running).toBe(false)

        await new Promise((r) => setTimeout(r, 20))
        expect(mockDebugger.detach).toHaveBeenCalled()

        // Disposing again should be safe
        expect(() => service.dispose()).not.toThrow()
    })

    it('should handle immediate stop() during renderer CDP handshake with delayed Profiler.enable', async () => {
        const { mockWin, mockDebugger, commandsSent, resolveEnable } = createMockRendererWindow({ delayEnable: true })

        service = new ProfilingService({
            isDebug: true,
            getMainWindow: () => mockWin as any,
        })

        const startPromise = service.start({ target: 'renderer' })
        const stopPromise = service.stop()

        resolveEnable()

        const [startResult, stopResult] = await Promise.all([startPromise, stopPromise])

        expect(startResult.ok).toBe(false)
        expect(startResult.message).toContain('aborted or superseded')
        expect(service.getStatus().running).toBe(false)
        expect(commandsSent).toContain('Profiler.stop')
        expect(commandsSent).toContain('Profiler.disable')
        expect(mockDebugger.detach).toHaveBeenCalled()

        // Verify service state is clean and can start and stop a new session cleanly
        const restartResult = await service.start({ target: 'main' })
        expect(restartResult.ok).toBe(true)
        const finalStop = await service.stop()
        expect(finalStop.ok).toBe(true)
    })

    it('should handle immediate dispose() during renderer CDP handshake with delayed Profiler.enable', async () => {
        const { mockWin, mockDebugger, resolveEnable } = createMockRendererWindow({ delayEnable: true })

        service = new ProfilingService({
            isDebug: true,
            getMainWindow: () => mockWin as any,
        })

        const startPromise = service.start({ target: 'renderer' })
        service.dispose()

        resolveEnable()

        const startResult = await startPromise
        expect(startResult.ok).toBe(false)
        expect(startResult.message).toContain('aborted or superseded')
        expect(service.getStatus().running).toBe(false)

        await new Promise((r) => setTimeout(r, 20))
        expect(mockDebugger.detach).toHaveBeenCalled()

        // Any subsequent start attempts on a disposed service should fail with disposed message
        const afterDisposeStart = await service.start({ target: 'main' })
        expect(afterDisposeStart.ok).toBe(false)
        expect(afterDisposeStart.message).toBe('ProfilingService has been disposed')
    })

    it('should send Profiler.stop and disable but not detach debugger on dispose when pre-attached', async () => {
        const { mockWin, mockDebugger, commandsSent } = createMockRendererWindow({ initiallyAttached: true })

        service = new ProfilingService({
            isDebug: true,
            getMainWindow: () => mockWin as any,
        })

        const startResult = await service.start({ target: 'renderer' })
        expect(startResult.ok).toBe(true)
        expect(service.getStatus().running).toBe(true)
        expect(mockDebugger.attach).not.toHaveBeenCalled()

        service.dispose()
        expect(service.getStatus().running).toBe(false)

        await new Promise((r) => setTimeout(r, 20))
        expect(commandsSent).toContain('Profiler.stop')
        expect(commandsSent).toContain('Profiler.disable')
        expect(mockDebugger.detach).not.toHaveBeenCalled()
    })

    it('should handle webContents destroyed midway during active sampling safely', async () => {
        const { mockWin, mockWebContents } = createMockRendererWindow()

        service = new ProfilingService({
            isDebug: true,
            getMainWindow: () => mockWin as any,
        })

        const startResult = await service.start({ target: 'renderer' })
        expect(startResult.ok).toBe(true)
        expect(service.getStatus().running).toBe(true)

        // Destroy webContents midway during active profiling
        mockWin.destroy()

        const stopResult = await service.stop()
        expect(service.getStatus().running).toBe(false)

        // Service can cleanly start a new session afterwards
        const nextStart = await service.start({ target: 'main' })
        expect(nextStart.ok).toBe(true)
        const nextStop = await service.stop()
        expect(nextStop.ok).toBe(true)
    })

    it('should handle immediate stop() during start() CDP handshake without corrupting state', async () => {
        service = new ProfilingService({ isDebug: true })

        // Trigger start and immediately call stop without awaiting start first
        const startPromise = service.start({ target: 'main' })
        const stopPromise = service.stop()

        const [startResult, stopResult] = await Promise.all([startPromise, stopPromise])

        expect(service.getStatus().running).toBe(false)

        // Verify service state is clean and can start and stop a new session cleanly
        const restartResult = await service.start({ target: 'main' })
        expect(restartResult.ok).toBe(true)
        expect(service.getStatus().running).toBe(true)

        const finalStop = await service.stop()
        expect(finalStop.ok).toBe(true)
        expect(service.getStatus().running).toBe(false)
    })

    it('should handle immediate dispose() during start() CDP handshake without corrupting state', async () => {
        service = new ProfilingService({ isDebug: true })

        // Trigger start and immediately dispose without awaiting start first
        const startPromise = service.start({ target: 'main' })
        service.dispose()

        const startResult = await startPromise
        expect(startResult.ok).toBe(false)
        expect(service.getStatus().running).toBe(false)

        // Any subsequent start attempts on a disposed service should fail with disposed message
        const afterDisposeStart = await service.start({ target: 'main' })
        expect(afterDisposeStart.ok).toBe(false)
        expect(afterDisposeStart.message).toBe('ProfilingService has been disposed')
    })

    it('should keep start2 attached when start1 CDP enable is delayed and stop() + start2 occur immediately', async () => {
        const { mockWin, mockDebugger, resolveEnable } = createMockRendererWindow({ delayEnableOnce: true })

        service = new ProfilingService({
            isDebug: true,
            getMainWindow: () => mockWin as any,
        })

        const p1 = service.start({ target: 'renderer' })
        await service.stop()
        const p2 = service.start({ target: 'renderer' })

        resolveEnable()

        const [r1, r2] = await Promise.all([p1, p2])

        expect(r1.ok).toBe(false)
        expect(r1.message).toContain('aborted or superseded')
        expect(r2.ok).toBe(true)
        expect(mockDebugger.isAttached()).toBe(true)

        const finalStop = await service.stop()
        expect(finalStop.ok).toBe(true)
        expect(finalStop.rawProfile).toBeDefined()
    })

    it('should handle debugger detach event during active sampling cleanly', async () => {
        const { mockWin, mockDebugger } = createMockRendererWindow()

        service = new ProfilingService({
            isDebug: true,
            getMainWindow: () => mockWin as any,
        })

        const startResult = await service.start({ target: 'renderer' })
        expect(startResult.ok).toBe(true)
        expect(service.getStatus().running).toBe(true)

        // Emit 'detach' event during active sampling
        mockDebugger.emit('detach', {}, 'target_closed')

        const stopResult = await service.stop()
        expect(service.getStatus().running).toBe(false)
        expect(stopResult.ok).toBe(false)

        // Service can cleanly start and stop a new session afterwards
        const nextStart = await service.start({ target: 'main' })
        expect(nextStart.ok).toBe(true)
        const nextStop = await service.stop()
        expect(nextStop.ok).toBe(true)
    })

    it('should fallback to maxDurationMs when durationMs <= 0', async () => {
        service = new ProfilingService({ isDebug: true, maxDurationMs: 15_000 })

        // durationMs <= 0 falls back to maxDurationMs
        const zeroStart = await service.start({ target: 'main', durationMs: 0 })
        expect(zeroStart.ok).toBe(true)
        expect(service.getStatus().durationMs).toBe(15_000)
        await service.stop()

        const negativeStart = await service.start({ target: 'main', durationMs: -5_000 })
        expect(negativeStart.ok).toBe(true)
        expect(service.getStatus().durationMs).toBe(15_000)
        await service.stop()
    })

    it('should clear lastProfile and lastReport when starting a new session', async () => {
        service = new ProfilingService({ isDebug: true })

        // First session captures a profile
        const firstStart = await service.start({ target: 'main' })
        expect(firstStart.ok).toBe(true)
        const firstStop = await service.stop()
        expect(firstStop.ok).toBe(true)
        expect(service.getLastProfile()).toBeDefined()
        expect(service.getLastReport()).toBeDefined()

        // Starting a new session resets lastProfile and lastReport to undefined
        const secondStart = await service.start({ target: 'main' })
        expect(secondStart.ok).toBe(true)
        expect(service.getLastProfile()).toBeUndefined()
        expect(service.getLastReport()).toBeUndefined()

        await service.stop()
    })
})
