import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { V8CpuProfile, V8ProfileNode } from './profilingService.js'

export interface HotspotEntry {
    rank: number
    functionName: string
    url: string
    lineNumber: number
    columnNumber: number
    selfTimeMs: number
    totalTimeMs: number
    selfTimePercent: number
    module: string
}

export type BottleneckType =
    | 'SYNC_BLOCKING_IO'
    | 'FREQUENT_IPC'
    | 'SQLITE_SLOW_OPERATION'
    | 'REACT_EXCESSIVE_RENDER'
    | 'EVENT_LOOP_DELAY'
    | 'PLUGIN_PERF_REGRESSION'
    | 'CPU_INTENSIVE'

export type BottleneckSeverity = 'HIGH' | 'MEDIUM' | 'LOW'

export interface Bottleneck {
    type: BottleneckType
    severity: BottleneckSeverity
    message: string
    location?: string
    selfTimeMs?: number
    selfTimePercent?: number
}

export interface PluginMetric {
    pluginId: string
    callCount?: number
    totalDurationMs?: number
    maxDurationMs?: number
    activationCount?: number
    errorCount?: number
    timeoutCount?: number
    activeLeases?: number
}

export interface AISuggestion {
    targetFile?: string
    targetLine?: number
    category: string
    action: string
}

export interface PerformanceReportSummary {
    durationMs: number
    timestamp: string
    target: string
    totalSamples: number
    cpuLoadPercent?: number
    eventLoopDelayMs?: number
}

export interface PerformanceReport {
    summary: PerformanceReportSummary
    hotspots: HotspotEntry[]
    bottlenecks: Bottleneck[]
    pluginMetrics: PluginMetric[]
    aiSuggestions: AISuggestion[]
}

export interface AnalyzeOptions {
    durationMs?: number
    target?: string
    projectRoot?: string
    pluginMetrics?: PluginMetric[]
    eventLoopDelayMs?: number
}

const IDLE_AND_SYSTEM_WAIT_NAMES = new Set([
    '(root)',
    '(idle)',
    '(program)',
    '(garbage collector)',
    'uv__io_poll',
    'epoll_wait',
    'epoll_pwait',
    'kevent',
    'kevent64',
    'select',
    'port_getn',
    'Poll',
    'WaitForSingleObject',
    'WaitForMultipleObjects',
    'GetQueuedCompletionStatus',
])

interface CallFrameMeta {
    functionName: string
    url: string
    lineNumber: number
    columnNumber: number
}

/**
 * Performance Profiling and Attribution Engine.
 * Parses V8 CPU Profile call trees, calculates Self/Total execution times,
 * filters idle states, detects performance bottlenecks, and generates AI optimization suggestions.
 */
export class ProfilingAnalyzer {
    /**
     * Safely extract and normalize metadata from a node's callFrame.
     * Converts 0-based V8 line/column numbers to 1-based.
     */
    static getCallFrameMeta(node: V8ProfileNode | undefined, projectRoot: string): CallFrameMeta {
        const frame = node?.callFrame
        const rawFn = frame?.functionName
        const functionName = typeof rawFn === 'string' && rawFn.trim().length > 0 ? rawFn.trim() : '(anonymous)'
        const rawUrl = typeof frame?.url === 'string' ? frame.url : ''
        const url = ProfilingAnalyzer.normalizeUrl(rawUrl, projectRoot)
        const rawLine = typeof frame?.lineNumber === 'number' ? frame.lineNumber : -1
        const rawCol = typeof frame?.columnNumber === 'number' ? frame.columnNumber : -1
        const lineNumber = rawLine >= 0 ? rawLine + 1 : 0
        const columnNumber = rawCol >= 0 ? rawCol + 1 : 0

        return {
            functionName,
            url,
            lineNumber,
            columnNumber,
        }
    }

    /**
     * Format location string as 'file:line:col', 'file:line', or 'file'.
     */
    static formatLocation(url: string, lineNumber?: number, columnNumber?: number): string {
        if (!url || url === '[native code]') {
            return url || '[native code]'
        }
        if (typeof lineNumber === 'number' && lineNumber > 0) {
            if (typeof columnNumber === 'number' && columnNumber > 0) {
                return `${url}:${lineNumber}:${columnNumber}`
            }
            return `${url}:${lineNumber}`
        }
        return url
    }

    /**
     * Analyze a captured V8 CPU Profile and produce a structured PerformanceReport.
     */
    static analyze(profile: V8CpuProfile, options?: AnalyzeOptions): PerformanceReport {
        const projectRoot = options?.projectRoot ? path.resolve(options.projectRoot) : process.cwd()
        const nodes = Array.isArray(profile?.nodes) ? profile.nodes : []
        const nodeMap = new Map<number, V8ProfileNode>()
        const parentMap = new Map<number, number>()

        for (const node of nodes) {
            if (!node || typeof node.id !== 'number') {
                continue
            }
            nodeMap.set(node.id, node)
            if (Array.isArray(node.children)) {
                for (const childId of node.children) {
                    if (typeof childId === 'number') {
                        parentMap.set(childId, node.id)
                    }
                }
            }
        }

        const functionSelfMicros = new Map<string, number>()
        const functionTotalMicros = new Map<string, number>()
        const functionMeta = new Map<string, CallFrameMeta>()

        const processSampleUnit = (nodeId: number, delta: number) => {
            if (delta <= 0) {
                return
            }

            const leafNode = nodeMap.get(nodeId)
            if (!leafNode) {
                return
            }

            const leafMeta = ProfilingAnalyzer.getCallFrameMeta(leafNode, projectRoot)
            const leafKey = `${leafMeta.url}:${leafMeta.lineNumber}:${leafMeta.columnNumber}:${leafMeta.functionName}`

            functionSelfMicros.set(leafKey, (functionSelfMicros.get(leafKey) || 0) + delta)
            if (!functionMeta.has(leafKey)) {
                functionMeta.set(leafKey, leafMeta)
            }

            // Trace ancestors to accumulate total time with cycle prevention and recursion deduplication
            const seenNodeIds = new Set<number>()
            const seenFunctionKeys = new Set<string>()
            let currId: number | undefined = nodeId

            while (currId !== undefined) {
                if (seenNodeIds.has(currId)) {
                    break
                }
                seenNodeIds.add(currId)

                const currNode = nodeMap.get(currId)
                if (currNode) {
                    const meta = ProfilingAnalyzer.getCallFrameMeta(currNode, projectRoot)
                    const key = `${meta.url}:${meta.lineNumber}:${meta.columnNumber}:${meta.functionName}`

                    if (!seenFunctionKeys.has(key)) {
                        seenFunctionKeys.add(key)
                        functionTotalMicros.set(key, (functionTotalMicros.get(key) || 0) + delta)
                        if (!functionMeta.has(key)) {
                            functionMeta.set(key, meta)
                        }
                    }
                }

                currId = parentMap.get(currId)
            }
        }

        const samples = Array.isArray(profile?.samples) ? profile.samples : []
        const timeDeltas = Array.isArray(profile?.timeDeltas) ? profile.timeDeltas : []
        let totalSamples = samples.length

        if (samples.length > 0) {
            let defaultDeltaMicros = 1000
            if (typeof profile?.startTime === 'number' && typeof profile?.endTime === 'number' && profile.endTime > profile.startTime) {
                defaultDeltaMicros = (profile.endTime - profile.startTime) / samples.length
            } else if (options?.durationMs && options.durationMs > 0) {
                defaultDeltaMicros = (options.durationMs * 1000) / samples.length
            }

            for (let i = 0; i < samples.length; i++) {
                const nodeId = samples[i]
                const rawDelta = timeDeltas[i]
                const delta = (typeof rawDelta === 'number' && rawDelta >= 0) ? rawDelta : defaultDeltaMicros
                processSampleUnit(nodeId, delta)
            }
        } else {
            // Fallback when samples array is not provided: synthesize sample units from hitCount on nodes
            let totalHits = 0
            for (const node of nodes) {
                if (node && typeof node.hitCount === 'number' && node.hitCount > 0) {
                    totalHits += node.hitCount
                }
            }
            totalSamples = totalHits

            const totalDurationMicros = (typeof profile?.startTime === 'number' && typeof profile?.endTime === 'number' && profile.endTime > profile.startTime)
                ? (profile.endTime - profile.startTime)
                : (options?.durationMs && options.durationMs > 0 ? options.durationMs * 1000 : totalHits * 1000)

            for (const node of nodes) {
                if (!node) {
                    continue
                }
                const hits = typeof node.hitCount === 'number' ? node.hitCount : 0
                if (hits > 0) {
                    const nodeDelta = totalHits > 0 ? (hits / totalHits) * totalDurationMicros : 0
                    processSampleUnit(node.id, nodeDelta)
                }
            }
        }

        // Calculate active CPU time (excluding idle and root frames)
        let totalActiveMicros = 0
        for (const [key, selfMicros] of functionSelfMicros.entries()) {
            const meta = functionMeta.get(key)
            if (meta && !ProfilingAnalyzer.isIdleOrSystemWait(meta.functionName)) {
                totalActiveMicros += selfMicros
            }
        }
        const totalActiveTimeMs = totalActiveMicros / 1000

        // Extract non-idle hotspots
        const candidateHotspots: Array<{
            functionName: string
            url: string
            lineNumber: number
            columnNumber: number
            selfTimeMs: number
            totalTimeMs: number
            selfTimePercent: number
            module: string
        }> = []

        for (const [key, selfMicros] of functionSelfMicros.entries()) {
            const meta = functionMeta.get(key)
            if (!meta || ProfilingAnalyzer.isIdleOrSystemWait(meta.functionName)) {
                continue
            }

            const selfTimeMs = selfMicros / 1000
            const totalMicros = functionTotalMicros.get(key) || selfMicros
            const totalTimeMs = totalMicros / 1000
            const selfTimePercent = totalActiveTimeMs > 0
                ? Number(((selfTimeMs / totalActiveTimeMs) * 100).toFixed(1))
                : 0
            const module = ProfilingAnalyzer.inferModule(meta.url, meta.functionName)

            candidateHotspots.push({
                functionName: meta.functionName,
                url: meta.url,
                lineNumber: meta.lineNumber,
                columnNumber: meta.columnNumber,
                selfTimeMs: Number(selfTimeMs.toFixed(1)),
                totalTimeMs: Number(totalTimeMs.toFixed(1)),
                selfTimePercent,
                module,
            })
        }

        // Sort by selfTimeMs descending, then totalTimeMs descending
        candidateHotspots.sort((a, b) => b.selfTimeMs - a.selfTimeMs || b.totalTimeMs - a.totalTimeMs)

        const hotspots: HotspotEntry[] = candidateHotspots.slice(0, 10).map((item, index) => ({
            rank: index + 1,
            ...item,
        }))

        // Duration calculation
        let durationMs = options?.durationMs
        if (!durationMs || durationMs <= 0) {
            if (typeof profile?.startTime === 'number' && typeof profile?.endTime === 'number' && profile.endTime > profile.startTime) {
                durationMs = Math.round((profile.endTime - profile.startTime) / 1000)
            } else {
                durationMs = Math.max(1, Math.round(totalActiveTimeMs))
            }
        }

        const cpuLoadPercent = durationMs > 0
            ? Math.min(100, Number(((totalActiveTimeMs / durationMs) * 100).toFixed(1)))
            : 0

        const pluginMetrics = Array.isArray(options?.pluginMetrics) ? options.pluginMetrics : []

        // Detect bottlenecks and generate AI suggestions
        const { bottlenecks, aiSuggestions } = ProfilingAnalyzer.detectBottlenecks(
            candidateHotspots,
            pluginMetrics,
            options?.eventLoopDelayMs,
        )

        return {
            summary: {
                durationMs,
                timestamp: new Date().toISOString(),
                target: options?.target || 'all',
                totalSamples,
                cpuLoadPercent,
                eventLoopDelayMs: options?.eventLoopDelayMs,
            },
            hotspots,
            bottlenecks,
            pluginMetrics,
            aiSuggestions,
        }
    }

    /**
     * Check if a function is an engine idle state or kernel event-wait primitive.
     */
    static isIdleOrSystemWait(functionName: string): boolean {
        if (!functionName) return false
        return IDLE_AND_SYSTEM_WAIT_NAMES.has(functionName)
    }

    /**
     * Normalize URL or file path to relative project path.
     */
    static normalizeUrl(rawUrl: string, projectRoot: string): string {
        if (!rawUrl || rawUrl.trim() === '') {
            return '[native code]'
        }

        let clean = rawUrl.trim()

        if (clean.startsWith('node:')) {
            return clean.replace(/[?#].*$/, '')
        }

        // Strip query string and hash fragment
        clean = clean.replace(/[?#].*$/, '')

        // Safely convert file:// URLs
        if (clean.startsWith('file://')) {
            if (clean.startsWith('file://localhost/')) {
                clean = 'file:///' + clean.slice('file://localhost/'.length)
            }
            try {
                clean = fileURLToPath(clean)
            } catch {
                clean = clean.replace(/^file:\/\//, '')
                try {
                    clean = decodeURIComponent(clean)
                } catch {
                    // Ignore decoding error
                }
            }
        }

        // Strip HTTP / HTTPS origin
        clean = clean.replace(/^https?:\/\/[^/]+/, '')

        // Strip Vite /@fs/ or @fs/ prefix
        clean = clean.replace(/^\/?@fs\/?/, '/')

        // Normalize Windows drive letters if leading slash exists, e.g. /C:/foo -> C:/foo
        clean = clean.replace(/^\/([a-zA-Z]:[/\\].*)/, '$1')

        // Standardize slashes to '/'
        clean = clean.replace(/\\/g, '/')
        const normalizedRoot = path.resolve(projectRoot).replace(/\\/g, '/')

        // Make relative to projectRoot
        if (clean.startsWith(normalizedRoot)) {
            clean = clean.slice(normalizedRoot.length).replace(/^\/+/, '')
        } else if (path.isAbsolute(clean)) {
            const rel = path.relative(normalizedRoot, clean).replace(/\\/g, '/')
            if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
                clean = rel
            } else {
                // If it was a Vite root-relative path like /src/components/..., strip leading slash
                clean = clean.replace(/^\/+/, '')
            }
        } else {
            clean = clean.replace(/^(\.\/|\/)+/, '')
        }

        return clean || '[native code]'
    }

    /**
     * Infer the architectural module name from file path and function name.
     */
    static inferModule(url: string, functionName: string): string {
        const lowerUrl = url.toLowerCase()
        const lowerFn = functionName.toLowerCase()

        if (lowerUrl.includes('sessiondatabase') || lowerUrl.includes('sqlite') || lowerFn.includes('database.exec') || lowerFn.includes('database.prepare')) {
            return 'SQLite DB'
        }
        if (lowerUrl.includes('agent-runtime') || lowerUrl.includes('streamingjson') || lowerUrl.includes('codex')) {
            return 'Agent Runtime'
        }
        if (lowerUrl.includes('src/main/services')) {
            return 'Main Service'
        }
        if (lowerUrl.includes('src/main')) {
            return 'Electron Main'
        }
        if (lowerUrl.includes('src/preload')) {
            return 'Preload Bridge'
        }
        if (lowerUrl.includes('frontend/src') || lowerUrl.includes('react') || lowerUrl.includes('components/')) {
            return 'React / UI'
        }
        if (lowerUrl.includes('plugins/') || lowerUrl.includes('pluginmanager')) {
            return 'Plugin'
        }
        if (lowerUrl.startsWith('node:') || lowerUrl.includes('node:internal')) {
            return 'Node.js Core'
        }
        if (lowerUrl.includes('node_modules')) {
            return 'External Dependency'
        }
        return 'App'
    }

    /**
     * Detect performance bottlenecks and create actionable AI suggestions.
     */
    static detectBottlenecks(
        hotspots: Array<{
            functionName: string
            url: string
            lineNumber: number
            columnNumber: number
            selfTimeMs: number
            totalTimeMs: number
            selfTimePercent: number
            module: string
        }>,
        pluginMetrics: PluginMetric[],
        eventLoopDelayMs?: number,
    ): { bottlenecks: Bottleneck[]; aiSuggestions: AISuggestion[] } {
        const bottlenecks: Bottleneck[] = []
        const aiSuggestions: AISuggestion[] = []
        const seenLocations = new Set<string>()

        // 1. Check synchronous blocking I/O
        for (const entry of hotspots) {
            const fn = entry.functionName
            const isSyncFs = /Sync$/.test(fn) ||
                fn.includes('readFileSync') ||
                fn.includes('writeFileSync') ||
                fn.includes('statSync') ||
                fn.includes('readdirSync') ||
                fn.includes('existsSync') ||
                fn.includes('openSync') ||
                fn.includes('mkdirSync') ||
                fn.includes('unlinkSync')

            if (isSyncFs && (entry.selfTimeMs >= 10 || entry.totalTimeMs >= 20 || entry.selfTimePercent >= 5)) {
                const loc = ProfilingAnalyzer.formatLocation(entry.url, entry.lineNumber, entry.columnNumber)
                if (!seenLocations.has(`SYNC_IO:${loc}`)) {
                    seenLocations.add(`SYNC_IO:${loc}`)
                    const severity: BottleneckSeverity = entry.selfTimeMs >= 100 ? 'HIGH' : entry.selfTimeMs >= 30 ? 'MEDIUM' : 'LOW'
                    bottlenecks.push({
                        type: 'SYNC_BLOCKING_IO',
                        severity,
                        message: `Synchronous blocking I/O operation detected in ${entry.functionName} (${entry.selfTimeMs.toFixed(1)}ms self time)`,
                        location: loc,
                        selfTimeMs: entry.selfTimeMs,
                        selfTimePercent: entry.selfTimePercent,
                    })

                    aiSuggestions.push({
                        targetFile: entry.url,
                        targetLine: entry.lineNumber > 0 ? entry.lineNumber : undefined,
                        category: 'ASYNC_IO_REFACTOR',
                        action: `Replace synchronous '${entry.functionName}' with asynchronous fs.promises equivalent or debounce watcher triggers to prevent blocking the event loop.`,
                    })
                }
            }
        }

        // 2. Check SQLite slow operations
        for (const entry of hotspots) {
            const isSqlite = entry.module === 'SQLite DB' ||
                entry.functionName.includes('Database.exec') ||
                entry.functionName.includes('Database.prepare') ||
                entry.functionName.includes('Statement.') ||
                entry.url.includes('better-sqlite3')

            if (isSqlite && (entry.selfTimeMs >= 15 || entry.totalTimeMs >= 30 || entry.selfTimePercent >= 5)) {
                const loc = ProfilingAnalyzer.formatLocation(entry.url, entry.lineNumber, entry.columnNumber)
                if (!seenLocations.has(`SQLITE:${loc}`)) {
                    seenLocations.add(`SQLITE:${loc}`)
                    const severity: BottleneckSeverity = entry.selfTimeMs >= 100 ? 'HIGH' : entry.selfTimeMs >= 30 ? 'MEDIUM' : 'LOW'
                    bottlenecks.push({
                        type: 'SQLITE_SLOW_OPERATION',
                        severity,
                        message: `Slow SQLite database operation in ${entry.functionName} (${entry.selfTimeMs.toFixed(1)}ms self time)`,
                        location: loc,
                        selfTimeMs: entry.selfTimeMs,
                        selfTimePercent: entry.selfTimePercent,
                    })

                    aiSuggestions.push({
                        targetFile: entry.url,
                        targetLine: entry.lineNumber > 0 ? entry.lineNumber : undefined,
                        category: 'DATABASE_BATCHING',
                        action: `Wrap SQLite operations in db.transaction(...) for bulk writes or ensure appropriate indexes exist on queried columns.`,
                    })
                }
            }
        }

        // 3. Check frequent IPC serialization / message overhead
        for (const entry of hotspots) {
            const isIpc = entry.functionName.includes('hostTransport') ||
                entry.functionName.includes('ipcMain') ||
                entry.functionName.includes('handleIpc') ||
                entry.functionName.includes('sendIpc') ||
                entry.functionName.includes('postMessage') ||
                entry.url.includes('registerIpcHandlers')

            if (isIpc && (entry.selfTimeMs >= 15 || entry.totalTimeMs >= 30 || entry.selfTimePercent >= 5)) {
                const loc = ProfilingAnalyzer.formatLocation(entry.url, entry.lineNumber, entry.columnNumber)
                if (!seenLocations.has(`IPC:${loc}`)) {
                    seenLocations.add(`IPC:${loc}`)
                    const severity: BottleneckSeverity = entry.selfTimeMs >= 100 ? 'HIGH' : entry.selfTimeMs >= 30 ? 'MEDIUM' : 'LOW'
                    bottlenecks.push({
                        type: 'FREQUENT_IPC',
                        severity,
                        message: `High IPC message dispatching or serialization overhead in ${entry.functionName} (${entry.selfTimeMs.toFixed(1)}ms self time)`,
                        location: loc,
                        selfTimeMs: entry.selfTimeMs,
                        selfTimePercent: entry.selfTimePercent,
                    })

                    aiSuggestions.push({
                        targetFile: entry.url,
                        targetLine: entry.lineNumber > 0 ? entry.lineNumber : undefined,
                        category: 'IPC_BATCHING_AND_DEBOUNCE',
                        action: `Debounce frequent IPC broadcasts and batch message payloads to minimize inter-process serialization overhead.`,
                    })
                }
            }
        }

        // 4. Check React excessive re-rendering
        for (const entry of hotspots) {
            const isReact = entry.functionName.includes('renderWithHooks') ||
                entry.functionName.includes('commitRoot') ||
                entry.functionName.includes('performSyncWorkOnRoot') ||
                entry.functionName.includes('performConcurrentWorkOnRoot') ||
                entry.functionName.includes('reconcileChildren') ||
                (entry.module === 'React / UI' && (entry.selfTimeMs >= 20 || entry.selfTimePercent >= 8))

            if (isReact && (entry.selfTimeMs >= 15 || entry.totalTimeMs >= 30 || entry.selfTimePercent >= 5)) {
                const loc = ProfilingAnalyzer.formatLocation(entry.url, entry.lineNumber, entry.columnNumber)
                if (!seenLocations.has(`REACT:${loc}`)) {
                    seenLocations.add(`REACT:${loc}`)
                    const severity: BottleneckSeverity = entry.selfTimeMs >= 100 ? 'HIGH' : entry.selfTimeMs >= 30 ? 'MEDIUM' : 'LOW'
                    bottlenecks.push({
                        type: 'REACT_EXCESSIVE_RENDER',
                        severity,
                        message: `Excessive React component rendering or reconciliation in ${entry.functionName} (${entry.selfTimeMs.toFixed(1)}ms self time)`,
                        location: loc,
                        selfTimeMs: entry.selfTimeMs,
                        selfTimePercent: entry.selfTimePercent,
                    })

                    aiSuggestions.push({
                        targetFile: entry.url,
                        targetLine: entry.lineNumber > 0 ? entry.lineNumber : undefined,
                        category: 'REACT_MEMOIZATION',
                        action: `Apply React.memo, useMemo, or useCallback in ${entry.functionName} to avoid redundant component re-renders.`,
                    })
                }
            }
        }

        // 5. Check high event loop delay (strictly > 50ms)
        if (typeof eventLoopDelayMs === 'number' && eventLoopDelayMs > 50) {
            const severity: BottleneckSeverity = eventLoopDelayMs >= 100 ? 'HIGH' : 'MEDIUM'
            bottlenecks.push({
                type: 'EVENT_LOOP_DELAY',
                severity,
                message: `High event loop delay measured (${eventLoopDelayMs.toFixed(1)}ms lag)`,
            })

            aiSuggestions.push({
                category: 'EVENT_LOOP_OPTIMIZATION',
                action: `Break long synchronous execution tasks into asynchronous chunks using setImmediate or worker threads.`,
            })
        }

        // 6. Check plugin performance regressions
        for (const metric of pluginMetrics) {
            const maxDuration = metric.maxDurationMs ?? 0
            const totalDuration = metric.totalDurationMs ?? 0
            const errorCount = metric.errorCount ?? 0
            const timeoutCount = metric.timeoutCount ?? 0

            if (maxDuration >= 10 || totalDuration >= 50 || timeoutCount > 0 || errorCount >= 3) {
                const severity: BottleneckSeverity =
                    maxDuration >= 30 || totalDuration >= 150 || timeoutCount > 0 ? 'HIGH' : 'MEDIUM'
                bottlenecks.push({
                    type: 'PLUGIN_PERF_REGRESSION',
                    severity,
                    message: `Plugin '${metric.pluginId}' hook latency or errors exceed threshold (max: ${maxDuration.toFixed(1)}ms, total: ${totalDuration.toFixed(1)}ms, errors: ${errorCount}, timeouts: ${timeoutCount})`,
                    location: metric.pluginId,
                })

                aiSuggestions.push({
                    targetFile: metric.pluginId,
                    category: 'PLUGIN_OPTIMIZATION',
                    action: `Optimize hook execution handlers in plugin '${metric.pluginId}' to reduce synchronous duration.`,
                })
            }
        }

        // 7. Check generic CPU-intensive hotspots not covered by specific rules
        for (const entry of hotspots.slice(0, 5)) {
            if (entry.selfTimePercent >= 10 || entry.selfTimeMs >= 50) {
                const loc = ProfilingAnalyzer.formatLocation(entry.url, entry.lineNumber, entry.columnNumber)
                const alreadyTagged = bottlenecks.some((b) => b.location === loc)
                if (!alreadyTagged && !seenLocations.has(`CPU:${loc}`)) {
                    seenLocations.add(`CPU:${loc}`)
                    const severity: BottleneckSeverity = entry.selfTimePercent >= 20 || entry.selfTimeMs >= 150 ? 'HIGH' : 'MEDIUM'
                    bottlenecks.push({
                        type: 'CPU_INTENSIVE',
                        severity,
                        message: `CPU-intensive computation detected in ${entry.functionName} (${entry.selfTimeMs.toFixed(1)}ms self time, ${entry.selfTimePercent.toFixed(1)}% CPU)`,
                        location: loc,
                        selfTimeMs: entry.selfTimeMs,
                        selfTimePercent: entry.selfTimePercent,
                    })

                    aiSuggestions.push({
                        targetFile: entry.url,
                        targetLine: entry.lineNumber > 0 ? entry.lineNumber : undefined,
                        category: 'ALGORITHM_OPTIMIZATION',
                        action: `Review computation algorithm in ${entry.functionName} to optimize execution complexity or cache results.`,
                    })
                }
            }
        }

        return { bottlenecks, aiSuggestions }
    }

    /**
     * Format a PerformanceReport into human and AI readable Markdown.
     */
    static formatMarkdown(report: PerformanceReport): string {
        const { summary, hotspots, bottlenecks, pluginMetrics, aiSuggestions } = report
        const lines: string[] = []

        lines.push('# 🚀 Coding Professional Agent Performance Diagnostic Report')
        lines.push('')

        // Summary block
        const durationSec = (summary.durationMs / 1000).toFixed(2)
        const targetLabel = summary.target === 'all'
            ? 'Full-Stack (Main + Renderer + Plugins)'
            : summary.target === 'main'
                ? 'Main Process'
                : summary.target === 'renderer'
                    ? 'Renderer Process'
                    : summary.target

        lines.push(`- **Sampling Duration**: ${durationSec}s | **Sampling Target**: ${targetLabel}`)
        lines.push(`- **Timestamp**: ${summary.timestamp}`)
        const cpuLoad = (summary.cpuLoadPercent ?? 0).toFixed(1)
        const loopDelay = summary.eventLoopDelayMs !== undefined ? `${summary.eventLoopDelayMs.toFixed(1)}ms` : 'N/A'
        lines.push(`- **Active CPU Load**: ${cpuLoad}% | **Average Event Loop Delay**: ${loopDelay}`)
        lines.push('')
        lines.push('---')
        lines.push('')

        // Hotspots table
        lines.push('## 🔥 Top 10 CPU Hotspots')
        lines.push('')
        if (hotspots.length === 0) {
            lines.push('*(No significant hotspot functions captured)*')
            lines.push('')
        } else {
            lines.push('| Rank | Function | Location | Self Time | Total Time | Ratio | Module |')
            lines.push('|:---|:---|:---|:---|:---|:---|:---|')
            for (const h of hotspots) {
                const loc = ProfilingAnalyzer.formatLocation(h.url, h.lineNumber, h.columnNumber)
                lines.push(
                    `| ${h.rank} | \`${h.functionName}\` | \`${loc}\` | ${h.selfTimeMs.toFixed(0)}ms | ${h.totalTimeMs.toFixed(0)}ms | ${h.selfTimePercent.toFixed(1)}% | ${h.module} |`,
                )
            }
            lines.push('')
        }
        lines.push('---')
        lines.push('')

        // Bottlenecks list
        lines.push(`## ⚠️ Detected Performance Bottlenecks (${bottlenecks.length})`)
        lines.push('')
        if (bottlenecks.length === 0) {
            lines.push('*(No obvious performance bottlenecks detected)*')
            lines.push('')
        } else {
            bottlenecks.forEach((b, index) => {
                const severityLabel = b.severity === 'HIGH' ? 'High' : b.severity === 'MEDIUM' ? 'Medium' : 'Low'
                lines.push(`${index + 1}. **[${b.type}] (${severityLabel})**: ${b.message}`)
                if (b.location) {
                    lines.push(`   - **Location**: \`${b.location}\``)
                }
                if (b.selfTimeMs !== undefined) {
                    const percentStr = b.selfTimePercent !== undefined ? ` (${b.selfTimePercent.toFixed(1)}%)` : ''
                    lines.push(`   - **Self Time**: ${b.selfTimeMs.toFixed(0)}ms${percentStr}`)
                }
            })
            lines.push('')
        }
        lines.push('---')
        lines.push('')

        // Plugin metrics table
        lines.push('## 🧩 Plugin Execution Time Statistics')
        lines.push('')
        if (pluginMetrics.length === 0) {
            lines.push('*(No plugin execution metrics)*')
            lines.push('')
        } else {
            lines.push('| Plugin ID | Hook Invocations | Total Time | Max Single Time | Status |')
            lines.push('|:---|:---|:---|:---|:---|')
            for (const p of pluginMetrics) {
                const callCount = p.callCount ?? p.activationCount ?? 0
                const totalDuration = p.totalDurationMs ?? 0
                const maxDuration = p.maxDurationMs ?? 0
                const errorCount = p.errorCount ?? 0
                const timeoutCount = p.timeoutCount ?? 0
                const isWarning = maxDuration >= 10 || totalDuration >= 50 || errorCount > 0 || timeoutCount > 0
                const status = isWarning ? '⚠️ High' : 'Normal'
                lines.push(
                    `| \`${p.pluginId}\` | ${callCount} | ${totalDuration.toFixed(0)}ms | ${maxDuration.toFixed(1)}ms | ${status} |`,
                )
            }
            lines.push('')
        }
        lines.push('---')
        lines.push('')

        // AI Suggestions list
        lines.push('## 💡 AI Automated Optimization Suggestions')
        lines.push('')
        if (aiSuggestions.length === 0) {
            lines.push('*(Current health is good, no optimization needed)*')
            lines.push('')
        } else {
            aiSuggestions.forEach((s, index) => {
                const target = s.targetFile ? ` (${s.targetFile}${s.targetLine ? `:${s.targetLine}` : ''})` : ''
                lines.push(`${index + 1}. **${s.category}**${target}:`)
                lines.push(`   - ${s.action}`)
            })
            lines.push('')
        }

        return lines.join('\n')
    }

    /**
     * Format a PerformanceReport into pretty-printed JSON.
     */
    static formatJson(report: PerformanceReport): string {
        return JSON.stringify(report, null, 2)
    }
}

