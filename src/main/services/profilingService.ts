import * as inspector from 'node:inspector'
import type { BrowserWindow, WebContents } from 'electron'
import {
    ProfilingAnalyzer,
    type PerformanceReport,
    type PluginMetric,
} from './profilingAnalyzer.js'

export interface ProfilerStatus {
    running: boolean
    enabled: boolean
    target: 'main' | 'renderer' | 'all'
    startedAt?: number
    durationMs?: number
}

export interface V8ProfileCallFrame {
    functionName: string
    scriptId: string
    url: string
    lineNumber: number
    columnNumber: number
}

export interface V8ProfileNode {
    id: number
    callFrame: V8ProfileCallFrame
    hitCount?: number
    children?: number[]
}

export interface V8CpuProfile {
    nodes: V8ProfileNode[]
    startTime: number
    endTime: number
    samples?: number[]
    timeDeltas?: number[]
}

export interface ProfilingServiceOptions {
    isDebug?: boolean
    maxDurationMs?: number
    samplingIntervalMicros?: number
    projectRoot?: string
    getMainWindow?: () => BrowserWindow | null
    getPluginMetrics?: () => Promise<PluginMetric[]> | PluginMetric[]
    pluginMetricsProvider?: () => Promise<PluginMetric[]> | PluginMetric[]
    pluginRuntimeHost?: { getPluginMetrics: () => Promise<PluginMetric[]> | PluginMetric[] }
}

export interface StartProfilingOptions {
    durationMs?: number
    target?: 'main' | 'renderer' | 'all'
}

export interface StartProfilingResult {
    ok: boolean
    message?: string
}

export interface StopProfilingResult {
    ok: boolean
    rawProfile?: V8CpuProfile
    report?: PerformanceReport
    error?: string
}

const DEFAULT_DURATION_MS = 60_000
const DEFAULT_SAMPLING_INTERVAL_MICROS = 1_000

/**
 * Check if profiling is enabled based on environment variables and debug flag.
 * CPA_PROFILE=1 or true -> enabled
 * CPA_PROFILE=0 or false -> disabled
 * Otherwise fallback to isDebug.
 */
export function isProfilingEnabled(isDebug?: boolean): boolean {
    const envVal = process.env.CPA_PROFILE?.trim().toLowerCase()
    if (envVal === '1' || envVal === 'true') {
        return true
    }
    if (envVal === '0' || envVal === 'false') {
        return false
    }
    return Boolean(isDebug)
}

/**
 * Merge two V8 CPU Profiles (e.g. main process and renderer process) into a unified profile.
 */
export function mergeProfiles(
    mainProfile?: V8CpuProfile,
    rendererProfile?: V8CpuProfile,
): V8CpuProfile | undefined {
    if (!mainProfile && !rendererProfile) {
        return undefined
    }
    if (!mainProfile) {
        return rendererProfile
    }
    if (!rendererProfile) {
        return mainProfile
    }

    const mainNodes = Array.isArray(mainProfile.nodes) ? mainProfile.nodes : []
    const rendererNodes = Array.isArray(rendererProfile.nodes) ? rendererProfile.nodes : []

    if (rendererNodes.length === 0) {
        return mainProfile
    }
    if (mainNodes.length === 0) {
        return rendererProfile
    }

    // Find root nodes
    const mainRoot = mainNodes.find((n) => n.callFrame?.functionName === '(root)') || mainNodes[0]
    const rendererRoot = rendererNodes.find((n) => n.callFrame?.functionName === '(root)') || rendererNodes[0]

    const maxMainId = Math.max(...mainNodes.map((n) => (typeof n.id === 'number' ? n.id : 0)), 0)
    const idOffset = maxMainId + 1000

    // Deep clone main nodes
    const clonedMainNodes: V8ProfileNode[] = mainNodes.map((n) => ({
        id: n.id,
        callFrame: { ...n.callFrame },
        hitCount: n.hitCount,
        children: n.children ? [...n.children] : undefined,
    }))

    // Find cloned main root
    const clonedMainRoot = clonedMainNodes.find((n) => n.id === mainRoot.id) || clonedMainNodes[0]

    // Clone and offset renderer nodes (except renderer root)
    const clonedRendererNodes: V8ProfileNode[] = []
    const rendererRootChildrenOffset: number[] = []

    for (const rNode of rendererNodes) {
        if (rNode.id === rendererRoot.id) {
            if (Array.isArray(rNode.children)) {
                for (const c of rNode.children) {
                    rendererRootChildrenOffset.push(c + idOffset)
                }
            }
            continue
        }

        clonedRendererNodes.push({
            id: rNode.id + idOffset,
            callFrame: { ...rNode.callFrame },
            hitCount: rNode.hitCount,
            children: rNode.children ? rNode.children.map((c) => c + idOffset) : undefined,
        })
    }

    // Attach renderer root's children to cloned main root
    if (rendererRootChildrenOffset.length > 0) {
        clonedMainRoot.children = [
            ...(clonedMainRoot.children || []),
            ...rendererRootChildrenOffset,
        ]
    }

    const mergedNodes = [...clonedMainNodes, ...clonedRendererNodes]

    // Merge samples with ID mapping for renderer
    const mainSamples = Array.isArray(mainProfile.samples) ? mainProfile.samples : []
    const rendererSamples = Array.isArray(rendererProfile.samples) ? rendererProfile.samples : []
    const mappedRendererSamples = rendererSamples.map((s) => {
        if (s === rendererRoot.id) {
            return clonedMainRoot.id
        }
        return s + idOffset
    })
    const mergedSamples = [...mainSamples, ...mappedRendererSamples]

    // Merge time deltas
    const mainTimeDeltas = Array.isArray(mainProfile.timeDeltas) ? mainProfile.timeDeltas : []
    const rendererTimeDeltas = Array.isArray(rendererProfile.timeDeltas) ? rendererProfile.timeDeltas : []
    const mergedTimeDeltas = [...mainTimeDeltas, ...rendererTimeDeltas]

    const startTime = Math.min(
        typeof mainProfile.startTime === 'number' ? mainProfile.startTime : Infinity,
        typeof rendererProfile.startTime === 'number' ? rendererProfile.startTime : Infinity,
    )
    const endTime = Math.max(
        typeof mainProfile.endTime === 'number' ? mainProfile.endTime : 0,
        typeof rendererProfile.endTime === 'number' ? rendererProfile.endTime : 0,
    )

    return {
        nodes: mergedNodes,
        startTime: startTime === Infinity ? 0 : startTime,
        endTime,
        samples: mergedSamples.length > 0 ? mergedSamples : undefined,
        timeDeltas: mergedTimeDeltas.length > 0 ? mergedTimeDeltas : undefined,
    }
}

/**
 * Main process & Renderer process CPU profiling service using Node.js built-in V8 inspector
 * and Electron webContents CDP debugger.
 */
export class ProfilingService {
    private isDebug: boolean
    private maxDurationMs: number
    private samplingIntervalMicros: number
    private projectRoot: string
    private getMainWindow?: () => BrowserWindow | null
    private running: boolean = false
    private target: 'main' | 'renderer' | 'all' = 'all'
    private startedAt?: number
    private durationMs?: number
    private session: inspector.Session | null = null
    private rendererWebContents: WebContents | null = null
    private rendererAttachedByUs: boolean = false
    private inFlightStopPromise: Promise<StopProfilingResult> | null = null
    private timeoutTimer: NodeJS.Timeout | null = null
    private lastProfile?: V8CpuProfile
    private lastReport?: PerformanceReport
    private disposed: boolean = false
    private sessionGeneration: number = 0
    private rendererSessionGeneration: number = 0
    private trackedWebContents: WebContents | null = null
    private rendererDestroyedListener: (() => void) | null = null
    private rendererDetachListener: ((event: unknown, reason: unknown) => void) | null = null
    private pluginMetricsProvider?: () => Promise<PluginMetric[]> | PluginMetric[]

    constructor(options?: ProfilingServiceOptions) {
        this.isDebug = Boolean(options?.isDebug)
        this.maxDurationMs = options?.maxDurationMs ?? DEFAULT_DURATION_MS
        this.samplingIntervalMicros = options?.samplingIntervalMicros ?? DEFAULT_SAMPLING_INTERVAL_MICROS
        this.projectRoot = options?.projectRoot ?? process.cwd()
        this.getMainWindow = options?.getMainWindow

        if (options?.getPluginMetrics) {
            this.pluginMetricsProvider = options.getPluginMetrics
        } else if (options?.pluginMetricsProvider) {
            this.pluginMetricsProvider = options.pluginMetricsProvider
        } else if (options?.pluginRuntimeHost) {
            this.pluginMetricsProvider = () => options.pluginRuntimeHost!.getPluginMetrics()
        }
    }

    /**
     * Set a custom provider function for runtime plugin metrics.
     */
    setPluginMetricsProvider(provider: () => Promise<PluginMetric[]> | PluginMetric[]): void {
        this.pluginMetricsProvider = provider
    }

    /**
     * Connect a plugin runtime host instance to supply plugin metrics during profiling.
     */
    setPluginRuntimeHost(host: { getPluginMetrics: () => Promise<PluginMetric[]> | PluginMetric[] }): void {
        this.pluginMetricsProvider = () => host.getPluginMetrics()
    }

    /**
     * Attach or update the main window supplier function for renderer CDP profiling.
     */
    attachRenderer(getMainWindow: () => BrowserWindow | null): void {
        this.getMainWindow = getMainWindow
    }

    /**
     * Check if profiling is currently enabled.
     */
    isEnabled(): boolean {
        return isProfilingEnabled(this.isDebug)
    }

    /**
     * Get current status of the profiler.
     */
    getStatus(): ProfilerStatus {
        return {
            running: this.running,
            enabled: this.isEnabled(),
            target: this.target,
            startedAt: this.startedAt,
            durationMs: this.durationMs,
        }
    }

    /**
     * Retrieve the most recent captured V8 CPU profile if any.
     */
    getLastProfile(): V8CpuProfile | undefined {
        return this.lastProfile
    }

    /**
     * Retrieve the most recent analyzed performance report if any.
     */
    getLastReport(): PerformanceReport | undefined {
        return this.lastReport
    }

    /**
     * Start profiling main process and/or renderer process.
     */
    async start(options?: StartProfilingOptions): Promise<StartProfilingResult> {
        if (this.disposed) {
            return {
                ok: false,
                message: 'ProfilingService has been disposed',
            }
        }

        if (!this.isEnabled()) {
            return {
                ok: false,
                message: 'Profiling is disabled in this environment',
            }
        }

        if (this.session !== null || this.rendererWebContents !== null || this.inFlightStopPromise !== null || this.running) {
            return {
                ok: false,
                message: 'Profiling session already active',
            }
        }

        const target = options?.target ?? 'all'
        const duration = options?.durationMs
        const effectiveDuration = (duration !== undefined && duration > 0)
            ? Math.min(duration, this.maxDurationMs)
            : this.maxDurationMs

        const currentGeneration = ++this.sessionGeneration
        this.running = true
        this.target = target
        this.startedAt = Date.now()
        this.durationMs = effectiveDuration
        this.lastProfile = undefined
        this.lastReport = undefined

        let rendererStarted = false
        let mainStarted = false
        let session: inspector.Session | null = null

        try {
            // 1. Start renderer profiling if target is 'renderer' or 'all'
            if (target === 'renderer' || target === 'all') {
                const win = this.getMainWindow?.()
                if (win && !win.isDestroyed?.() && win.webContents && !win.webContents.isDestroyed?.()) {
                    const wc = win.webContents
                    this.rendererSessionGeneration = currentGeneration
                    try {
                        if (!wc.debugger.isAttached()) {
                            wc.debugger.attach('1.3')
                            this.rendererAttachedByUs = true
                        } else {
                            this.rendererAttachedByUs = false
                        }
                        this.rendererWebContents = wc
                        this.setupRendererLifecycleListeners(wc)

                        await wc.debugger.sendCommand('Profiler.enable')
                        if (this.disposed || this.sessionGeneration !== currentGeneration) {
                            if (this.rendererSessionGeneration === currentGeneration) {
                                await this.stopRendererProfiler(wc, { detach: true })
                            }
                            return {
                                ok: false,
                                message: 'Profiling session was aborted or superseded',
                            }
                        }

                        await wc.debugger.sendCommand('Profiler.setSamplingInterval', {
                            interval: this.samplingIntervalMicros,
                        })
                        if (this.disposed || this.sessionGeneration !== currentGeneration) {
                            if (this.rendererSessionGeneration === currentGeneration) {
                                await this.stopRendererProfiler(wc, { detach: true })
                            }
                            return {
                                ok: false,
                                message: 'Profiling session was aborted or superseded',
                            }
                        }

                        await wc.debugger.sendCommand('Profiler.start')
                        if (this.disposed || this.sessionGeneration !== currentGeneration) {
                            if (this.rendererSessionGeneration === currentGeneration) {
                                await this.stopRendererProfiler(wc, { detach: true })
                            }
                            return {
                                ok: false,
                                message: 'Profiling session was aborted or superseded',
                            }
                        }
                        rendererStarted = true
                    } catch (err: unknown) {
                        if (this.disposed || this.sessionGeneration !== currentGeneration) {
                            if (this.rendererSessionGeneration === currentGeneration) {
                                await this.stopRendererProfiler(wc, { detach: true })
                            }
                            return {
                                ok: false,
                                message: 'Profiling session was aborted or superseded',
                            }
                        }
                        console.warn('[ProfilingService] Renderer debugger attach/start failed:', err)
                        if (this.rendererSessionGeneration === currentGeneration) {
                            await this.stopRendererProfiler(wc, { detach: true })
                        }
                    }
                }
            }

            // Check if aborted during renderer start
            if (this.disposed || this.sessionGeneration !== currentGeneration) {
                if (this.rendererSessionGeneration === currentGeneration) {
                    await this.stopRendererProfiler(this.rendererWebContents, { detach: true })
                }
                return {
                    ok: false,
                    message: 'Profiling session was aborted or superseded',
                }
            }

            // 2. Start main process profiling if target is 'main', 'all', or fallback from failed renderer
            if (target === 'main' || target === 'all' || (target === 'renderer' && !rendererStarted)) {
                session = new inspector.Session()
                this.session = session
                session.connect()

                await this.postCDP(session, 'Profiler.enable')
                if (this.session !== session || this.disposed || this.sessionGeneration !== currentGeneration) {
                    this.cleanupSessionInstance(session)
                    if (this.rendererSessionGeneration === currentGeneration) {
                        await this.stopRendererProfiler(this.rendererWebContents, { detach: true })
                    }
                    return {
                        ok: false,
                        message: 'Profiling session was aborted or superseded',
                    }
                }

                await this.postCDP(session, 'Profiler.setSamplingInterval', {
                    interval: this.samplingIntervalMicros,
                })
                if (this.session !== session || this.disposed || this.sessionGeneration !== currentGeneration) {
                    this.cleanupSessionInstance(session)
                    if (this.rendererSessionGeneration === currentGeneration) {
                        await this.stopRendererProfiler(this.rendererWebContents, { detach: true })
                    }
                    return {
                        ok: false,
                        message: 'Profiling session was aborted or superseded',
                    }
                }

                await this.postCDP(session, 'Profiler.start')
                if (this.session !== session || this.disposed || this.sessionGeneration !== currentGeneration) {
                    this.cleanupSessionInstance(session)
                    if (this.rendererSessionGeneration === currentGeneration) {
                        await this.stopRendererProfiler(this.rendererWebContents, { detach: true })
                    }
                    return {
                        ok: false,
                        message: 'Profiling session was aborted or superseded',
                    }
                }
                mainStarted = true
            }

            if (!rendererStarted && !mainStarted) {
                throw new Error('Failed to start both renderer and main process profiling')
            }

            // Setup guard auto-stop timer
            this.timeoutTimer = setTimeout(() => {
                if (this.running && this.sessionGeneration === currentGeneration) {
                    this.stop().catch(() => {
                        // Ignore background auto-stop errors
                    })
                }
            }, effectiveDuration)

            return { ok: true }
        } catch (err: unknown) {
            if (this.sessionGeneration === currentGeneration) {
                this.clearTimer()
                this.running = false
                this.startedAt = undefined
                this.durationMs = undefined
                this.cleanupSessionInstance(session)
                if (this.rendererSessionGeneration === currentGeneration) {
                    await this.stopRendererProfiler(this.rendererWebContents, { detach: true })
                }
                this.session = null
            } else {
                this.cleanupSessionInstance(session)
                if (this.rendererSessionGeneration === currentGeneration) {
                    await this.stopRendererProfiler(this.rendererWebContents, { detach: true })
                }
            }
            const msg = err instanceof Error ? err.message : String(err)
            return {
                ok: false,
                message: `Failed to start profiling: ${msg}`,
            }
        }
    }

    /**
     * Stop profiling and collect the V8 CPU profile.
     */
    async stop(): Promise<StopProfilingResult> {
        if (this.inFlightStopPromise) {
            return this.inFlightStopPromise
        }

        if (!this.running && !this.session && !this.rendererWebContents) {
            return {
                ok: false,
                error: 'No active profiling session',
            }
        }

        this.sessionGeneration++
        this.clearTimer()
        this.running = false
        const session = this.session
        this.session = null
        const targetWc = this.rendererWebContents
        this.rendererWebContents = null
        this.rendererSessionGeneration = 0
        const rendererAttachedByUs = this.rendererAttachedByUs

        const stopPromise = (async (): Promise<StopProfilingResult> => {
            let mainProfile: V8CpuProfile | undefined
            let rendererProfile: V8CpuProfile | undefined

            // 1. Stop main inspector session if active
            if (session) {
                try {
                    const result = await this.postCDP<{ profile?: V8CpuProfile }>(session, 'Profiler.stop')
                    try {
                        await this.postCDP(session, 'Profiler.disable')
                    } catch {
                        // Ignore disable errors
                    }
                    this.cleanupSessionInstance(session)

                    if (result && result.profile && typeof result.profile === 'object' && Array.isArray(result.profile.nodes)) {
                        mainProfile = result.profile
                    }
                } catch (err: unknown) {
                    this.cleanupSessionInstance(session)
                    console.warn('[ProfilingService] Error stopping main profiler:', err)
                }
            }

            // 2. Stop renderer debugger session if active
            if (targetWc) {
                this.rendererAttachedByUs = rendererAttachedByUs
                rendererProfile = await this.stopRendererProfiler(targetWc, { detach: true })
            }

            // 3. Resolve profile based on target and captured results
            let finalProfile: V8CpuProfile | undefined
            if (this.target === 'all') {
                finalProfile = mergeProfiles(mainProfile, rendererProfile)
            } else if (this.target === 'renderer') {
                finalProfile = rendererProfile || mainProfile
            } else {
                finalProfile = mainProfile || rendererProfile
            }

            if (finalProfile && Array.isArray(finalProfile.nodes)) {
                this.lastProfile = finalProfile
                const durationMs = this.startedAt ? Date.now() - this.startedAt : this.durationMs

                let pluginMetrics: PluginMetric[] = []
                if (this.pluginMetricsProvider) {
                    try {
                        const fetched = await this.pluginMetricsProvider()
                        if (Array.isArray(fetched)) {
                            pluginMetrics = fetched
                        }
                    } catch (err) {
                        console.warn('[ProfilingService] Error collecting plugin metrics:', err)
                    }
                }

                const report = ProfilingAnalyzer.analyze(finalProfile, {
                    durationMs,
                    target: this.target,
                    projectRoot: this.projectRoot,
                    pluginMetrics,
                })
                this.lastReport = report
                return {
                    ok: true,
                    rawProfile: finalProfile,
                    report,
                }
            }

            return {
                ok: false,
                error: 'No profile data returned from inspector or renderer debugger',
            }
        })().finally(() => {
            this.inFlightStopPromise = null
        })

        this.inFlightStopPromise = stopPromise
        return stopPromise
    }

    /**
     * Clean up resources and stop any running inspector/CDP sessions.
     */
    dispose(): void {
        this.disposed = true
        this.sessionGeneration++
        this.clearTimer()
        this.running = false
        this.inFlightStopPromise = null
        const session = this.session
        this.session = null
        const targetWc = this.rendererWebContents
        this.rendererWebContents = null
        this.rendererSessionGeneration = 0

        if (session) {
            try {
                session.post('Profiler.stop', () => {
                    try {
                        session.post('Profiler.disable', () => {
                            try {
                                session.disconnect()
                            } catch {
                                // Ignore disconnect errors
                            }
                        })
                    } catch {
                        try {
                            session.disconnect()
                        } catch {
                            // Ignore disconnect errors
                        }
                    }
                })
            } catch {
                try {
                    session.disconnect()
                } catch {
                    // Ignore disconnect errors
                }
            }
        }

        if (targetWc) {
            this.stopRendererProfiler(targetWc, { detach: true }).catch(() => {
                // Ignore errors during dispose
            })
        }
    }

    /**
     * Stop and disable the renderer CDP profiler, detach if attached by this service,
     * and clean up lifecycle listeners and webContents reference.
     */
    private async stopRendererProfiler(
        wc: WebContents | null | undefined,
        options?: { detach?: boolean },
    ): Promise<V8CpuProfile | undefined> {
        if (!wc) {
            return undefined
        }

        const shouldDetach = Boolean(options?.detach && this.rendererAttachedByUs)
        if (this.rendererWebContents === wc) {
            this.rendererWebContents = null
            this.rendererAttachedByUs = false
            this.rendererSessionGeneration = 0
        }
        this.removeRendererLifecycleListeners(wc)

        if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) {
            return undefined
        }

        let profile: V8CpuProfile | undefined

        try {
            if (wc.debugger?.isAttached?.()) {
                try {
                    const result = await wc.debugger.sendCommand('Profiler.stop') as { profile?: V8CpuProfile } | undefined
                    if (result && result.profile && typeof result.profile === 'object' && Array.isArray(result.profile.nodes)) {
                        profile = result.profile
                    }
                } catch {
                    // Ignore stop errors
                }

                try {
                    await wc.debugger.sendCommand('Profiler.disable')
                } catch {
                    // Ignore disable errors
                }

                if (shouldDetach) {
                    try {
                        if (wc.debugger?.isAttached?.()) {
                            wc.debugger.detach()
                        }
                    } catch {
                        // Ignore detach errors
                    }
                }
            }
        } catch (err: unknown) {
            console.warn('[ProfilingService] Error stopping renderer profiler:', err)
            if (shouldDetach) {
                try {
                    if (wc.debugger?.isAttached?.()) {
                        wc.debugger.detach()
                    }
                } catch {
                    // Ignore detach errors
                }
            }
        }

        return profile
    }

    private setupRendererLifecycleListeners(wc: WebContents): void {
        if (this.trackedWebContents && this.trackedWebContents !== wc) {
            this.removeRendererLifecycleListeners(this.trackedWebContents)
        }
        this.removeRendererLifecycleListeners(wc)
        this.trackedWebContents = wc

        const onRendererLost = () => {
            if (this.rendererWebContents === wc) {
                this.rendererWebContents = null
                this.rendererAttachedByUs = false
                this.rendererSessionGeneration = 0
            }
            this.removeRendererLifecycleListeners(wc)
        }

        this.rendererDestroyedListener = onRendererLost
        this.rendererDetachListener = onRendererLost

        try {
            if (typeof wc.once === 'function') {
                wc.once('destroyed', onRendererLost)
            } else if (typeof wc.on === 'function') {
                wc.on('destroyed', onRendererLost)
            }
        } catch {
            // Ignore event listener registration error
        }

        try {
            if (wc.debugger && typeof wc.debugger.once === 'function') {
                wc.debugger.once('detach', onRendererLost)
            } else if (wc.debugger && typeof wc.debugger.on === 'function') {
                wc.debugger.on('detach', onRendererLost)
            }
        } catch {
            // Ignore event listener registration error
        }
    }

    private removeRendererLifecycleListeners(wc?: WebContents | null): void {
        const target = wc || this.trackedWebContents
        if (target) {
            if (this.rendererDestroyedListener) {
                try {
                    if (typeof target.removeListener === 'function') {
                        target.removeListener('destroyed', this.rendererDestroyedListener)
                    } else if (typeof (target as any).off === 'function') {
                        (target as any).off('destroyed', this.rendererDestroyedListener)
                    }
                } catch {
                    // Ignore removal error
                }
            }
            if (this.rendererDetachListener && target.debugger) {
                try {
                    if (typeof target.debugger.removeListener === 'function') {
                        target.debugger.removeListener('detach', this.rendererDetachListener)
                    } else if (typeof (target.debugger as any).off === 'function') {
                        (target.debugger as any).off('detach', this.rendererDetachListener)
                    }
                } catch {
                    // Ignore removal error
                }
            }
        }
        this.rendererDestroyedListener = null
        this.rendererDetachListener = null
        this.trackedWebContents = null
    }

    private clearTimer(): void {
        if (this.timeoutTimer) {
            clearTimeout(this.timeoutTimer)
            this.timeoutTimer = null
        }
    }

    private cleanupSessionInstance(session: inspector.Session | null): void {
        if (session) {
            try {
                session.disconnect()
            } catch {
                // Ignore disconnect errors
            }
        }
    }

    private postCDP<T = unknown>(session: inspector.Session, method: string, params?: Record<string, unknown>): Promise<T> {
        return new Promise((resolve, reject) => {
            session.post(method, params, (err, res) => {
                if (err) {
                    reject(err)
                } else {
                    resolve(res as T)
                }
            })
        })
    }
}
