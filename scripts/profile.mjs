import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const defaultProjectRoot = path.resolve(__dirname, '..')

export const HELP_TEXT = `Usage: pnpm profile [options]

AI-friendly CPU Profiler & Performance Tracing Tool for Coding Professional Agent

Options:
  -d, --duration <duration>   Profiling duration, e.g. 5s, 10s, 5000ms, 5000 (default: 5s)
  -t, --target <target>       Target to profile: main, renderer, all (default: all)
  -p, --port <port>           WebServer port (default: 18080)
      --host <host>           WebServer host (default: 127.0.0.1)
  -f, --format <format>       Output format: markdown, json (default: markdown)
      --spawn                 Auto-spawn a temporary dev instance if server is not running
      --save-raw              Save raw V8 .cpuprofile into .profiles/ directory
  -o, --output <file>         Write formatted report to specified file path
  -h, --help                  Show this help message
`

/**
 * Helper to compute process spawn configuration for temporary dev instance.
 */
export function getDevSpawnConfig(platform = (typeof process !== 'undefined' ? process.platform : 'darwin'), options = {}, projectRoot = defaultProjectRoot) {
    const isWindows = platform === 'win32'
    const command = isWindows ? 'pnpm.cmd' : 'pnpm'
    return {
        command,
        args: ['dev'],
        cwd: projectRoot,
        env: {
            ...(typeof process !== 'undefined' ? process.env : {}),
            CPA_PROFILE: '1',
            PORT: String(options?.port ?? 18080),
        },
        stdio: 'ignore',
        shell: isWindows,
        windowsHide: true,
    }
}

/**
 * Launch a temporary development instance for profiling.
 */
export async function spawnDevInstance(options = {}, helpers = {}) {
    const projectRoot = options.projectRoot || defaultProjectRoot
    const stderr = helpers.stderr || ((msg) => console.error(msg))
    const { spawn } = await import('node:child_process')
    const spawnFn = helpers.spawn || spawn
    const isWindows = process.platform === 'win32'
    const pnpmCmd = isWindows ? 'pnpm.cmd' : 'pnpm'
    const child = spawnFn(pnpmCmd, ['dev'], {
        cwd: projectRoot,
        env: {
            ...process.env,
            CPA_PROFILE: '1',
            PORT: String(options.port ?? 18080),
        },
        stdio: 'ignore',
        shell: isWindows,
        windowsHide: true,
    })
    if (child && typeof child.on === 'function') {
        child.on('error', (err) => {
            stderr(`[pnpm profile] Failed to spawn dev instance: ${err.message}\n`)
        })
    }
    return child
}

/**
 * Parse duration string or number into milliseconds.
 * Supports: '5s', '10s', '5000ms', '5000', 5000, '2.5s', etc.
 * If no unit is specified: values < 1000 are treated as seconds, values >= 1000 as milliseconds.
 */
export function parseDuration(val) {
    if (typeof val === 'number') {
        if (!Number.isFinite(val) || val <= 0) {
            throw new Error(`Duration must be a positive number: ${val}`)
        }
        if (val < 1000) {
            return Math.round(val * 1000)
        }
        return Math.round(val)
    }

    if (typeof val !== 'string' || !val.trim()) {
        throw new Error(`Invalid duration format: ${val}`)
    }

    const trimmed = val.trim()
    const match = trimmed.match(/^([0-9]+(?:\.[0-9]+)?)\s*(s|sec|seconds|ms|millis|milliseconds)?$/i)
    if (!match) {
        throw new Error(`Invalid duration format: ${val}`)
    }

    const num = parseFloat(match[1])
    if (!Number.isFinite(num) || num <= 0) {
        throw new Error(`Duration must be positive: ${val}`)
    }

    const unit = match[2] ? match[2].toLowerCase() : null

    if (unit === 's' || unit === 'sec' || unit === 'seconds') {
        return Math.round(num * 1000)
    }

    if (unit === 'ms' || unit === 'millis' || unit === 'milliseconds') {
        return Math.round(num)
    }

    // Pure number string without unit: < 1000 treated as seconds, >= 1000 treated as ms
    if (num < 1000) {
        return Math.round(num * 1000)
    }
    return Math.round(num)
}

function setTarget(val, options) {
    const t = String(val).trim().toLowerCase()
    if (t !== 'main' && t !== 'renderer' && t !== 'all') {
        throw new Error(`Invalid target: ${val}. Must be "main", "renderer", or "all"`)
    }
    options.target = t
}

function setPort(val, options) {
    const p = parseInt(val, 10)
    if (!Number.isFinite(p) || p < 1 || p > 65535) {
        throw new Error(`Invalid port: ${val}. Must be between 1 and 65535`)
    }
    options.port = p
}

function setFormat(val, options) {
    const f = String(val).trim().toLowerCase()
    if (f !== 'markdown' && f !== 'json') {
        throw new Error(`Invalid format: ${val}. Must be "markdown" or "json"`)
    }
    options.format = f
}

function applyOption(key, value, options) {
    if (key === 'd' || key === 'duration') {
        options.durationMs = parseDuration(value)
    } else if (key === 't' || key === 'target') {
        setTarget(value, options)
    } else if (key === 'p' || key === 'port') {
        setPort(value, options)
    } else if (key === 'host') {
        if (!value.trim()) throw new Error('Host cannot be empty')
        options.host = value.trim()
    } else if (key === 'f' || key === 'format') {
        setFormat(value, options)
    } else if (key === 'o' || key === 'output') {
        if (!value) throw new Error('Output path cannot be empty')
        options.output = value
    } else {
        throw new Error(`Unknown option: --${key}`)
    }
}

/**
 * Parse CLI arguments into strongly-typed options object.
 */
export function parseArgs(argv = []) {
    const options = {
        durationMs: 5000,
        target: 'all',
        port: 18080,
        host: '127.0.0.1',
        format: 'markdown',
        spawn: false,
        saveRaw: false,
        output: undefined,
        help: false,
    }

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]

        if (arg === '-h' || arg === '--help') {
            options.help = true
            continue
        }

        if (arg === '--spawn') {
            options.spawn = true
            continue
        }

        if (arg === '--save-raw') {
            options.saveRaw = true
            continue
        }

        // Handle --key=val or -k=val
        if (arg.startsWith('--') && arg.includes('=')) {
            const [key, ...rest] = arg.slice(2).split('=')
            const value = rest.join('=')
            applyOption(key, value, options)
            continue
        }
        if (arg.startsWith('-') && !arg.startsWith('--') && arg.includes('=')) {
            const [key, ...rest] = arg.slice(1).split('=')
            const value = rest.join('=')
            applyOption(key, value, options)
            continue
        }

        // Handle --key val or -k val
        if (arg === '-d' || arg === '--duration') {
            const next = argv[++i]
            if (next === undefined || next.startsWith('-')) {
                throw new Error(`Missing value for ${arg}`)
            }
            options.durationMs = parseDuration(next)
            continue
        }

        if (arg === '-t' || arg === '--target') {
            const next = argv[++i]
            if (next === undefined || next.startsWith('-')) {
                throw new Error(`Missing value for ${arg}`)
            }
            setTarget(next, options)
            continue
        }

        if (arg === '-p' || arg === '--port') {
            const next = argv[++i]
            if (next === undefined || next.startsWith('-')) {
                throw new Error(`Missing value for ${arg}`)
            }
            setPort(next, options)
            continue
        }

        if (arg === '--host') {
            const next = argv[++i]
            if (next === undefined || next.startsWith('-')) {
                throw new Error(`Missing value for ${arg}`)
            }
            options.host = next.trim()
            continue
        }

        if (arg === '-f' || arg === '--format') {
            const next = argv[++i]
            if (next === undefined || next.startsWith('-')) {
                throw new Error(`Missing value for ${arg}`)
            }
            setFormat(next, options)
            continue
        }

        if (arg === '-o' || arg === '--output') {
            const next = argv[++i]
            if (next === undefined || next.startsWith('-')) {
                throw new Error(`Missing value for ${arg}`)
            }
            options.output = next
            continue
        }

        throw new Error(`Unknown option: ${arg}`)
    }

    return options
}

function formatLocation(url, line, col) {
    if (!url) return '(unknown)'
    if (line !== undefined && line > 0) {
        if (col !== undefined && col > 0) {
            return `${url}:${line}:${col}`
        }
        return `${url}:${line}`
    }
    return url
}

/**
 * Format a PerformanceReport object into human/AI-readable Markdown.
 */
export function formatMarkdownReport(report) {
    if (!report) {
        return '# 🚀 Coding Professional Agent Performance Diagnostic Report\n\n*(No valid report data captured)*'
    }

    const summary = report.summary || {}
    const hotspots = Array.isArray(report.hotspots) ? report.hotspots : []
    const bottlenecks = Array.isArray(report.bottlenecks) ? report.bottlenecks : []
    const pluginMetrics = Array.isArray(report.pluginMetrics) ? report.pluginMetrics : []
    const aiSuggestions = Array.isArray(report.aiSuggestions) ? report.aiSuggestions : []

    const lines = []

    lines.push('# 🚀 Coding Professional Agent Performance Diagnostic Report')
    lines.push('')

    // Summary block
    const durationMs = typeof summary.durationMs === 'number' ? summary.durationMs : 5000
    const durationSec = (durationMs / 1000).toFixed(2)
    const targetLabel =
        summary.target === 'all'
            ? 'Full-Stack (Main + Renderer + Plugins)'
            : summary.target === 'main'
              ? 'Main Process'
              : summary.target === 'renderer'
                ? 'Renderer Process'
                : summary.target || 'Full-Stack (Main + Renderer + Plugins)'

    const timestamp = summary.timestamp || new Date().toISOString()
    lines.push(`- **Sampling Duration**: ${durationSec}s | **Sampling Target**: ${targetLabel}`)
    lines.push(`- **Timestamp**: ${timestamp}`)
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
            const loc = formatLocation(h.url, h.lineNumber, h.columnNumber)
            const selfTime = typeof h.selfTimeMs === 'number' ? `${h.selfTimeMs.toFixed(0)}ms` : '0ms'
            const totalTime = typeof h.totalTimeMs === 'number' ? `${h.totalTimeMs.toFixed(0)}ms` : '0ms'
            const percent = typeof h.selfTimePercent === 'number' ? `${h.selfTimePercent.toFixed(1)}%` : '0.0%'
            lines.push(
                `| ${h.rank || 1} | \`${h.functionName || '(anonymous)'}\` | \`${loc}\` | ${selfTime} | ${totalTime} | ${percent} | ${h.module || 'Unknown'} |`,
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
            const status = p.maxDurationMs >= 10 || p.totalDurationMs >= 50 ? '⚠️ High' : 'Normal'
            const totalDur = typeof p.totalDurationMs === 'number' ? `${p.totalDurationMs.toFixed(0)}ms` : '0ms'
            const maxDur = typeof p.maxDurationMs === 'number' ? `${p.maxDurationMs.toFixed(1)}ms` : '0.0ms'
            lines.push(
                `| \`${p.pluginId}\` | ${p.callCount || 0} | ${totalDur} | ${maxDur} | ${status} |`,
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
 * Format a PerformanceReport object into pretty-printed JSON.
 */
export function formatJsonReport(report) {
    return JSON.stringify(report, null, 2)
}

/**
 * Execute profiling workflow against WebServer.
 */
export async function runProfile(options, helpers = {}) {
    const stdout = helpers.stdout || ((msg) => console.log(msg))
    const stderr = helpers.stderr || ((msg) => console.error(msg))
    const fetchFn = helpers.fetch || globalThis.fetch
    const sleep = helpers.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    const projectRoot = helpers.projectRoot || defaultProjectRoot
    const fsModule = helpers.fs || fs

    if (options.help) {
        stdout(HELP_TEXT)
        return { ok: true }
    }

    const baseUrl = `http://${options.host}:${options.port}`

    async function checkStatus() {
        try {
            const res = await fetchFn(`${baseUrl}/api/profile/status`)
            if (res.status === 403) {
                return { ok: false, forbidden: true }
            }
            if (res.ok) {
                const data = await res.json().catch(() => ({}))
                return { ok: true, data }
            }
            return { ok: false, status: res.status }
        } catch (err) {
            return { ok: false, error: err }
        }
    }

    let spawnedProcess = null
    let removeSignalHandlers = null

    try {
        let initialStatus = await checkStatus()

        if (initialStatus.forbidden) {
            const errMsg = 'Profiling is disabled on the target server. Start CPA with CPA_PROFILE=1 or run in development mode.'
            stderr(errMsg)
            return { ok: false, error: errMsg }
        }

        if (!initialStatus.ok) {
            if (!options.spawn) {
                const errMsg = `Cannot connect to CPA WebServer at ${baseUrl}.\nPlease make sure CPA is running in development mode (pnpm dev) or use the --spawn flag to auto-launch an instance.`
                stderr(errMsg)
                return { ok: false, error: errMsg }
            }

            stderr(`[pnpm profile] CPA server not detected at ${baseUrl}. Spawning temporary dev instance...`)
            if (helpers.spawnDevInstance) {
                spawnedProcess = await helpers.spawnDevInstance({ host: options.host, port: options.port, projectRoot })
            } else {
                spawnedProcess = await spawnDevInstance({ host: options.host, port: options.port, projectRoot }, { stderr })
            }

            if (spawnedProcess && typeof process !== 'undefined') {
                const cleanup = () => {
                    if (spawnedProcess && typeof spawnedProcess.kill === 'function') {
                        try {
                            spawnedProcess.kill('SIGTERM')
                        } catch {
                            // Ignore kill errors
                        }
                    }
                }
                const onSigInt = () => {
                    cleanup()
                    process.exit(130)
                }
                const onSigTerm = () => {
                    cleanup()
                    process.exit(143)
                }
                const onExit = () => {
                    cleanup()
                }
                process.on('SIGINT', onSigInt)
                process.on('SIGTERM', onSigTerm)
                process.on('exit', onExit)
                removeSignalHandlers = () => {
                    process.removeListener('SIGINT', onSigInt)
                    process.removeListener('SIGTERM', onSigTerm)
                    process.removeListener('exit', onExit)
                }
            }

            let ready = false
            const maxRetries = 90
            for (let i = 0; i < maxRetries; i++) {
                await sleep(500)
                const check = await checkStatus()
                if (check.ok) {
                    ready = true
                    break
                }
            }

            if (!ready) {
                const errMsg = `Failed to connect to spawned CPA instance at ${baseUrl} after timeout.`
                stderr(errMsg)
                return { ok: false, error: errMsg }
            }
        }

        stderr(`[pnpm profile] Starting profiling session (target: ${options.target}, duration: ${options.durationMs}ms)...`)
        const serverWatchdogMs = Math.min(options.durationMs + 10_000, 60_000)
        const startRes = await fetchFn(`${baseUrl}/api/profile/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ durationMs: serverWatchdogMs, target: options.target }),
        })

        if (!startRes.ok) {
            const errBody = await startRes.json().catch(() => ({}))
            const errMsg = `Failed to start profiling: ${errBody.error || startRes.statusText || startRes.status}`
            stderr(errMsg)
            return { ok: false, error: errMsg }
        }

        await sleep(options.durationMs)

        stderr('[pnpm profile] Stopping profiling session and generating analysis report...')
        let report = null
        let rawProfile = null
        let stopErrorMessage = ''

        const stopRes = await fetchFn(`${baseUrl}/api/profile/stop`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        })

        if (stopRes.ok) {
            const stopData = await stopRes.json().catch(() => ({}))
            if (stopData.ok && stopData.report) {
                report = stopData.report
                rawProfile = stopData.raw || stopData.rawProfile
            } else if (!stopData.ok) {
                stopErrorMessage = stopData.error || 'Profiling error'
            }
        } else {
            const errBody = await stopRes.json().catch(() => ({}))
            stopErrorMessage = errBody.error || stopRes.statusText || `HTTP ${stopRes.status}`
        }

        // If stop returned 400 or failed (e.g. server watchdog timer already stopped the session),
        // fallback to GET /api/profile/report
        if (!report) {
            try {
                const reportRes = await fetchFn(`${baseUrl}/api/profile/report`)
                if (reportRes.ok) {
                    const reportData = await reportRes.json().catch(() => ({}))
                    if (reportData && reportData.report) {
                        report = reportData.report
                        rawProfile = reportData.raw || reportData.rawProfile || reportData.report.raw
                    }
                }
            } catch {
                // Fallback attempt failed
            }
        }

        if (!report) {
            const errMsg = `Failed to stop profiling: ${stopErrorMessage || 'Could not retrieve report'}`
            stderr(errMsg)
            return { ok: false, error: errMsg }
        }

        const formattedOutput = options.format === 'json' ? formatJsonReport(report) : formatMarkdownReport(report)

        let rawFilePath
        if (options.saveRaw) {
            if (rawProfile) {
                const profilesDir = path.resolve(projectRoot, '.profiles')
                await fsModule.mkdir(profilesDir, { recursive: true })
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
                rawFilePath = path.join(profilesDir, `profile-${timestamp}.cpuprofile`)
                await fsModule.writeFile(rawFilePath, JSON.stringify(rawProfile, null, 2), 'utf-8')
                stderr(`[pnpm profile] Raw CPU profile saved to: ${rawFilePath}`)
            } else {
                stderr('[pnpm profile] Warning: Raw CPU profile is not available from this session.\n')
            }
        }

        if (options.output) {
            const outPath = path.resolve(projectRoot, options.output)
            const outDir = path.dirname(outPath)
            await fsModule.mkdir(outDir, { recursive: true })
            await fsModule.writeFile(outPath, formattedOutput, 'utf-8')
            stderr(`[pnpm profile] Report saved to: ${outPath}`)
        }

        stdout(formattedOutput)

        return {
            ok: true,
            report,
            rawProfile,
            output: formattedOutput,
            rawFilePath,
        }
    } finally {
        if (removeSignalHandlers) {
            removeSignalHandlers()
        }
        if (spawnedProcess && typeof spawnedProcess.kill === 'function') {
            try {
                spawnedProcess.kill('SIGTERM')
                stderr('[pnpm profile] Temporary dev instance terminated.')
            } catch {
                // Ignore kill errors
            }
        }
    }
}

export async function main() {
    try {
        const options = parseArgs(process.argv.slice(2))
        const result = await runProfile(options)
        if (!result.ok) {
            process.exit(1)
        }
    } catch (err) {
        console.error(`[Error] ${err.message || err}`)
        process.exit(1)
    }
}

// Run directly if invoked from CLI
const isDirectRun =
    typeof process !== 'undefined' &&
    process.argv[1] &&
    fileURLToPath(import.meta.url) === path.resolve(process.argv[1])

if (isDirectRun) {
    main()
}
