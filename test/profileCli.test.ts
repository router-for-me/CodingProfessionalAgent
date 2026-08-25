import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as http from 'node:http'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import {
    parseArgs,
    parseDuration,
    formatMarkdownReport,
    formatJsonReport,
    runProfile,
    getDevSpawnConfig,
    spawnDevInstance,
    HELP_TEXT,
} from '../scripts/profile.mjs'

describe('profile CLI', () => {
    describe('parseDuration', () => {
        it('parses seconds with s/sec/seconds units', () => {
            expect(parseDuration('5s')).toBe(5000)
            expect(parseDuration('10s')).toBe(10000)
            expect(parseDuration('1.5s')).toBe(1500)
            expect(parseDuration('0.5s')).toBe(500)
            expect(parseDuration('2 sec')).toBe(2000)
            expect(parseDuration('3 seconds')).toBe(3000)
        })

        it('parses milliseconds with ms/millis/milliseconds units', () => {
            expect(parseDuration('500ms')).toBe(500)
            expect(parseDuration('5000ms')).toBe(5000)
            expect(parseDuration('1200 millis')).toBe(1200)
            expect(parseDuration('3500 milliseconds')).toBe(3500)
        })

        it('parses plain numeric strings and numbers (< 1000 as seconds, >= 1000 as ms)', () => {
            expect(parseDuration(5)).toBe(5000)
            expect(parseDuration('5')).toBe(5000)
            expect(parseDuration(10)).toBe(10000)
            expect(parseDuration('10')).toBe(10000)
            expect(parseDuration(60)).toBe(60000)
            expect(parseDuration('60')).toBe(60000)
            expect(parseDuration('5000')).toBe(5000)
            expect(parseDuration('2500')).toBe(2500)
            expect(parseDuration(5000)).toBe(5000)
            expect(parseDuration(10000)).toBe(10000)
        })

        it('throws for invalid formats or non-positive durations', () => {
            expect(() => parseDuration('invalid')).toThrow('Invalid duration format')
            expect(() => parseDuration('0s')).toThrow('Duration must be positive')
            expect(() => parseDuration('-5s')).toThrow('Invalid duration format')
            expect(() => parseDuration(0)).toThrow('Duration must be a positive number')
            expect(() => parseDuration(-100)).toThrow('Duration must be a positive number')
            expect(() => parseDuration('')).toThrow('Invalid duration format')
            expect(() => parseDuration(null as any)).toThrow('Invalid duration format')
            expect(() => parseDuration(undefined as any)).toThrow('Invalid duration format')
        })
    })

    describe('parseArgs', () => {
        it('returns default options when no arguments provided', () => {
            const options = parseArgs([])
            expect(options).toEqual({
                durationMs: 5000,
                target: 'all',
                port: 18080,
                host: '127.0.0.1',
                format: 'markdown',
                spawn: false,
                saveRaw: false,
                output: undefined,
                help: false,
            })
        })

        it('parses duration shorthand and long flags', () => {
            expect(parseArgs(['-d', '10s']).durationMs).toBe(10000)
            expect(parseArgs(['--duration', '2.5s']).durationMs).toBe(2500)
            expect(parseArgs(['-d=500ms']).durationMs).toBe(500)
            expect(parseArgs(['--duration=15s']).durationMs).toBe(15000)
        })

        it('parses target flags', () => {
            expect(parseArgs(['-t', 'main']).target).toBe('main')
            expect(parseArgs(['--target', 'renderer']).target).toBe('renderer')
            expect(parseArgs(['-t=all']).target).toBe('all')
            expect(parseArgs(['--target=main']).target).toBe('main')
        })

        it('parses port and host flags', () => {
            expect(parseArgs(['-p', '19000']).port).toBe(19000)
            expect(parseArgs(['--port', '8080']).port).toBe(8080)
            expect(parseArgs(['-p=3000']).port).toBe(3000)
            expect(parseArgs(['--host', '0.0.0.0']).host).toBe('0.0.0.0')
            expect(parseArgs(['--host=192.168.1.5']).host).toBe('192.168.1.5')
        })

        it('parses format flags', () => {
            expect(parseArgs(['-f', 'json']).format).toBe('json')
            expect(parseArgs(['--format', 'markdown']).format).toBe('markdown')
            expect(parseArgs(['-f=json']).format).toBe('json')
        })

        it('parses boolean and output flags', () => {
            const options = parseArgs(['--spawn', '--save-raw', '-o', './reports/perf.md'])
            expect(options.spawn).toBe(true)
            expect(options.saveRaw).toBe(true)
            expect(options.output).toBe('./reports/perf.md')

            const options2 = parseArgs(['--output=report.json'])
            expect(options2.output).toBe('report.json')
        })

        it('parses help flags', () => {
            expect(parseArgs(['-h']).help).toBe(true)
            expect(parseArgs(['--help']).help).toBe(true)
        })

        it('throws for invalid options and values', () => {
            expect(() => parseArgs(['-t', 'invalid'])).toThrow('Invalid target')
            expect(() => parseArgs(['-f', 'yaml'])).toThrow('Invalid format')
            expect(() => parseArgs(['-p', '99999'])).toThrow('Invalid port')
            expect(() => parseArgs(['-p', '0'])).toThrow('Invalid port')
            expect(() => parseArgs(['--unknown'])).toThrow('Unknown option')
            expect(() => parseArgs(['-d'])).toThrow('Missing value for -d')
            expect(() => parseArgs(['--host='])).toThrow('Host cannot be empty')
        })
    })

    describe('getDevSpawnConfig', () => {
        it('returns win32 spawn config with pnpm.cmd, shell true, windowsHide true', () => {
            const config = getDevSpawnConfig('win32', { port: 18080 }, '/mock/project/root')
            expect(config).toMatchObject({
                command: 'pnpm.cmd',
                shell: true,
                windowsHide: true,
            })
            expect(config.cwd).toBe('/mock/project/root')
            expect(config.args).toEqual(['dev'])
            expect(config.env.CPA_PROFILE).toBe('1')
            expect(config.env.PORT).toBe('18080')
            expect(config.stdio).toBe('ignore')
        })

        it('returns posix spawn config with pnpm, shell false, windowsHide true on darwin/linux', () => {
            const configDarwin = getDevSpawnConfig('darwin', { port: 19000 }, '/mock/project/root')
            expect(configDarwin).toMatchObject({
                command: 'pnpm',
                shell: false,
                windowsHide: true,
            })
            expect(configDarwin.env.PORT).toBe('19000')

            const configLinux = getDevSpawnConfig('linux', {}, '/mock/project/root')
            expect(configLinux).toMatchObject({
                command: 'pnpm',
                shell: false,
                windowsHide: true,
            })
            expect(configLinux.env.PORT).toBe('18080')
        })
    })

    describe('spawnDevInstance', () => {
        it('spawns child process using spawn and registers error event listener', async () => {
            let capturedCmd = ''
            let capturedArgs: string[] = []
            let capturedOptions: any = null
            const listeners: Record<string, Function[]> = {}

            const mockChild = {
                on: (event: string, cb: Function) => {
                    listeners[event] = listeners[event] || []
                    listeners[event].push(cb)
                    return mockChild
                },
            }

            const mockSpawn = (cmd: string, args: string[], opts: any) => {
                capturedCmd = cmd
                capturedArgs = args
                capturedOptions = opts
                return mockChild
            }

            const stderrLogs: string[] = []
            const child = await spawnDevInstance(
                { port: 19000, projectRoot: '/mock/app' },
                {
                    spawn: mockSpawn as any,
                    stderr: (msg: string) => stderrLogs.push(msg),
                },
            )

            expect(child).toBe(mockChild)
            expect(capturedArgs).toEqual(['dev'])
            expect(capturedOptions.cwd).toBe('/mock/app')
            expect(capturedOptions.env.PORT).toBe('19000')
            expect(capturedOptions.env.CPA_PROFILE).toBe('1')
            expect(capturedOptions.stdio).toBe('ignore')
            expect(capturedOptions.windowsHide).toBe(true)
            expect(listeners['error']).toBeDefined()
            expect(listeners['error'].length).toBe(1)

            // Trigger error event
            listeners['error'][0](new Error('spawn EINVAL'))
            expect(stderrLogs.some((msg) => msg.includes('[pnpm profile] Failed to spawn dev instance: spawn EINVAL'))).toBe(true)
        })
    })

    describe('formatMarkdownReport and formatJsonReport', () => {
        const mockReport = {
            summary: {
                durationMs: 5000,
                timestamp: '2026-08-28T10:00:00.000Z',
                target: 'all',
                totalSamples: 1000,
                cpuLoadPercent: 18.4,
                eventLoopDelayMs: 4.2,
            },
            hotspots: [
                {
                    rank: 1,
                    functionName: 'EnvironmentWatcherService.onFileChange',
                    url: 'src/main/services/environmentWatcherService.ts',
                    lineNumber: 74,
                    columnNumber: 12,
                    selfTimeMs: 142.0,
                    totalTimeMs: 380.0,
                    selfTimePercent: 15.2,
                    module: 'Main Service',
                },
            ],
            bottlenecks: [
                {
                    type: 'SYNC_BLOCKING_IO',
                    severity: 'HIGH',
                    message: 'Synchronous file scan detected',
                    location: 'src/main/services/environmentWatcherService.ts:74',
                    selfTimeMs: 142.0,
                    selfTimePercent: 15.2,
                },
            ],
            pluginMetrics: [
                {
                    pluginId: 'core:file-manager',
                    callCount: 120,
                    totalDurationMs: 88.0,
                    maxDurationMs: 14.5,
                },
            ],
            aiSuggestions: [
                {
                    targetFile: 'src/main/services/environmentWatcherService.ts',
                    targetLine: 74,
                    category: 'DEBOUNCE_AND_ASYNC',
                    action: 'Add 150ms debounce and convert synchronous FS operations to async',
                },
            ],
        }

        it('formats valid markdown report matching spec 6.1 table structure', () => {
            const md = formatMarkdownReport(mockReport as any)
            expect(md).toContain('# 🚀 Coding Professional Agent Performance Diagnostic Report')
            expect(md).toContain('5.00s')
            // Spec 6.1 table headers and rows
            expect(md).toContain('| Rank | Function | Location | Self Time | Total Time | Ratio | Module |')
            expect(md).toContain('|:---|:---|:---|:---|:---|:---|:---|')
            expect(md).toContain('| 1 | `EnvironmentWatcherService.onFileChange` | `src/main/services/environmentWatcherService.ts:74:12` | 142ms | 380ms | 15.2% | Main Service |')
            expect(md).toContain('SYNC_BLOCKING_IO')
            expect(md).toContain('core:file-manager')
            expect(md).toContain('DEBOUNCE_AND_ASYNC')
        })

        it('formats valid JSON report', () => {
            const jsonStr = formatJsonReport(mockReport as any)
            const parsed = JSON.parse(jsonStr)
            expect(parsed.summary.durationMs).toBe(5000)
            expect(parsed.hotspots[0].functionName).toBe('EnvironmentWatcherService.onFileChange')
        })

        it('handles empty report gracefully', () => {
            const emptyMd = formatMarkdownReport(null as any)
            expect(emptyMd).toContain('No valid report data captured')

            const zeroReportMd = formatMarkdownReport({
                summary: { durationMs: 2000, timestamp: '2026-08-28T00:00:00.000Z', target: 'main', totalSamples: 0 },
                hotspots: [],
                bottlenecks: [],
                pluginMetrics: [],
                aiSuggestions: [],
            })
            expect(zeroReportMd).toContain('*(No significant hotspot functions captured)*')
            expect(zeroReportMd).toContain('*(No obvious performance bottlenecks detected)*')
            expect(zeroReportMd).toContain('*(Current health is good, no optimization needed)*')
        })
    })

    describe('runProfile', () => {
        let tmpDir: string
        let server: http.Server
        let serverPort: number
        let isProfilingActive = false
        let isProfilingForbidden = false
        let simulateStop400Fallback = false
        let simulateMissingRawProfile = false
        let lastStartRequestBody: any = null

        const mockReportData = {
            summary: {
                durationMs: 100,
                timestamp: '2026-08-28T10:00:00.000Z',
                target: 'all',
                totalSamples: 50,
                cpuLoadPercent: 12.0,
                eventLoopDelayMs: 2.5,
            },
            hotspots: [
                {
                    rank: 1,
                    functionName: 'testFunction',
                    url: 'src/main/index.ts',
                    lineNumber: 10,
                    columnNumber: 5,
                    selfTimeMs: 50.0,
                    totalTimeMs: 80.0,
                    selfTimePercent: 50.0,
                    module: 'Main',
                },
            ],
            bottlenecks: [],
            pluginMetrics: [],
            aiSuggestions: [],
        }

        const mockRawProfile = {
            nodes: [
                {
                    id: 1,
                    callFrame: {
                        functionName: '(root)',
                        scriptId: '0',
                        url: '',
                        lineNumber: 0,
                        columnNumber: 0,
                    },
                },
            ],
            startTime: 1000,
            endTime: 2000,
            samples: [1],
            timeDeltas: [1000],
        }

        beforeEach(async () => {
            tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cpa-cli-test-'))
            isProfilingActive = false
            isProfilingForbidden = false
            simulateStop400Fallback = false
            simulateMissingRawProfile = false
            lastStartRequestBody = null

            server = http.createServer((req, res) => {
                if (isProfilingForbidden) {
                    res.writeHead(403, { 'Content-Type': 'application/json' })
                    res.end(JSON.stringify({ ok: false, error: 'Forbidden' }))
                    return
                }

                if (req.url === '/api/profile/status' && req.method === 'GET') {
                    res.writeHead(200, { 'Content-Type': 'application/json' })
                    res.end(JSON.stringify({ ok: true, running: isProfilingActive, enabled: true }))
                    return
                }

                if (req.url === '/api/profile/start' && req.method === 'POST') {
                    let body = ''
                    req.on('data', (chunk) => {
                        body += chunk
                    })
                    req.on('end', () => {
                        isProfilingActive = true
                        lastStartRequestBody = body ? JSON.parse(body) : {}
                        res.writeHead(200, { 'Content-Type': 'application/json' })
                        res.end(JSON.stringify({ ok: true, session: { running: true } }))
                    })
                    return
                }

                if (req.url === '/api/profile/stop' && req.method === 'POST') {
                    isProfilingActive = false
                    if (simulateStop400Fallback) {
                        res.writeHead(400, { 'Content-Type': 'application/json' })
                        res.end(JSON.stringify({ ok: false, error: 'No active profiling session' }))
                        return
                    }
                    if (simulateMissingRawProfile) {
                        res.writeHead(200, { 'Content-Type': 'application/json' })
                        res.end(
                            JSON.stringify({
                                ok: true,
                                report: mockReportData,
                            }),
                        )
                        return
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' })
                    res.end(
                        JSON.stringify({
                            ok: true,
                            report: mockReportData,
                            raw: mockRawProfile,
                            rawProfile: mockRawProfile,
                        }),
                    )
                    return
                }

                if (req.url === '/api/profile/report' && req.method === 'GET') {
                    if (simulateMissingRawProfile) {
                        res.writeHead(200, { 'Content-Type': 'application/json' })
                        res.end(
                            JSON.stringify({
                                ok: true,
                                report: mockReportData,
                            }),
                        )
                        return
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' })
                    res.end(
                        JSON.stringify({
                            ok: true,
                            report: mockReportData,
                            raw: mockRawProfile,
                        }),
                    )
                    return
                }

                res.writeHead(404, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ error: 'Not found' }))
            })

            await new Promise<void>((resolve) => {
                server.listen(0, '127.0.0.1', () => {
                    const address = server.address() as any
                    serverPort = address.port
                    resolve()
                })
            })
        })

        afterEach(async () => {
            await new Promise<void>((resolve) => server.close(() => resolve()))
            await fs.rm(tmpDir, { recursive: true, force: true })
        })

        it('prints help text when help is requested', async () => {
            const stdoutLogs: string[] = []
            const result = await runProfile(
                { help: true } as any,
                {
                    stdout: (msg) => stdoutLogs.push(msg),
                },
            )

            expect(result.ok).toBe(true)
            expect(stdoutLogs.join('\n')).toContain(HELP_TEXT)
        })

        it('returns friendly error when server is unreachable and spawn is false', async () => {
            const stderrLogs: string[] = []
            const result = await runProfile(
                {
                    durationMs: 100,
                    target: 'all',
                    port: 59999, // Unused port
                    host: '127.0.0.1',
                    format: 'markdown',
                    spawn: false,
                    saveRaw: false,
                },
                {
                    stderr: (msg) => stderrLogs.push(msg),
                },
            )

            expect(result.ok).toBe(false)
            expect(result.error).toContain('Cannot connect to CPA WebServer')
            expect(stderrLogs.join('\n')).toContain('--spawn')
        })

        it('returns error when profiling is forbidden (403)', async () => {
            isProfilingForbidden = true
            const stderrLogs: string[] = []
            const result = await runProfile(
                {
                    durationMs: 100,
                    target: 'all',
                    port: serverPort,
                    host: '127.0.0.1',
                    format: 'markdown',
                    spawn: false,
                    saveRaw: false,
                },
                {
                    stderr: (msg) => stderrLogs.push(msg),
                },
            )

            expect(result.ok).toBe(false)
            expect(result.error).toContain('Profiling is disabled on the target server')
            expect(stderrLogs.join('\n')).toContain('CPA_PROFILE=1')
        })

        it('sends serverWatchdogMs durationMs and target in POST /api/profile/start body payload', async () => {
            const stdoutLogs: string[] = []
            const stderrLogs: string[] = []

            const result = await runProfile(
                {
                    durationMs: 5000,
                    target: 'renderer',
                    port: serverPort,
                    host: '127.0.0.1',
                    format: 'markdown',
                    spawn: false,
                    saveRaw: false,
                },
                {
                    stdout: (msg) => stdoutLogs.push(msg),
                    stderr: (msg) => stderrLogs.push(msg),
                    sleep: async () => {},
                },
            )

            expect(result.ok).toBe(true)
            expect(lastStartRequestBody).toEqual({
                durationMs: 15000, // Math.min(5000 + 10000, 60000)
                target: 'renderer',
            })

            // Test clamping to 60000
            await runProfile(
                {
                    durationMs: 55000,
                    target: 'main',
                    port: serverPort,
                    host: '127.0.0.1',
                    format: 'markdown',
                    spawn: false,
                    saveRaw: false,
                },
                {
                    stdout: (msg) => stdoutLogs.push(msg),
                    stderr: (msg) => stderrLogs.push(msg),
                    sleep: async () => {},
                },
            )

            expect(lastStartRequestBody).toEqual({
                durationMs: 60000, // Math.min(55000 + 10000, 60000)
                target: 'main',
            })
        })

        it('falls back to GET /api/profile/report when POST /api/profile/stop returns 400 (watchdog race)', async () => {
            simulateStop400Fallback = true
            const stdoutLogs: string[] = []
            const stderrLogs: string[] = []

            const result = await runProfile(
                {
                    durationMs: 50,
                    target: 'all',
                    port: serverPort,
                    host: '127.0.0.1',
                    format: 'markdown',
                    spawn: false,
                    saveRaw: false,
                },
                {
                    stdout: (msg) => stdoutLogs.push(msg),
                    stderr: (msg) => stderrLogs.push(msg),
                    sleep: async () => {},
                },
            )

            expect(result.ok).toBe(true)
            expect(result.report).toBeDefined()
            expect(result.report!.hotspots[0].functionName).toBe('testFunction')
            expect(result.output).toContain('# 🚀 Coding Professional Agent Performance Diagnostic Report')
        })

        it('executes profiling and outputs markdown to stdout while progress goes to stderr', async () => {
            const stdoutLogs: string[] = []
            const stderrLogs: string[] = []
            const result = await runProfile(
                {
                    durationMs: 50,
                    target: 'all',
                    port: serverPort,
                    host: '127.0.0.1',
                    format: 'markdown',
                    spawn: false,
                    saveRaw: false,
                },
                {
                    stdout: (msg) => stdoutLogs.push(msg),
                    stderr: (msg) => stderrLogs.push(msg),
                    sleep: async () => {},
                },
            )

            expect(result.ok).toBe(true)
            expect(result.report).toBeDefined()
            // Stdout only contains the markdown report
            expect(stdoutLogs.length).toBe(1)
            expect(stdoutLogs[0]).toContain('# 🚀 Coding Professional Agent Performance Diagnostic Report')
            expect(stdoutLogs[0]).toContain('testFunction')
            expect(stdoutLogs.some((msg) => msg.includes('[pnpm profile]'))).toBe(false)
            // Stderr contains progress messages
            expect(stderrLogs.some((msg) => msg.includes('[pnpm profile] Starting profiling session'))).toBe(true)
            expect(stderrLogs.some((msg) => msg.includes('[pnpm profile] Stopping profiling session'))).toBe(true)
        })

        it('executes profiling and outputs 100% parseable JSON to stdout with progress in stderr', async () => {
            const stdoutLogs: string[] = []
            const stderrLogs: string[] = []
            const result = await runProfile(
                {
                    durationMs: 50,
                    target: 'main',
                    port: serverPort,
                    host: '127.0.0.1',
                    format: 'json',
                    spawn: false,
                    saveRaw: false,
                },
                {
                    stdout: (msg) => stdoutLogs.push(msg),
                    stderr: (msg) => stderrLogs.push(msg),
                    sleep: async () => {},
                },
            )

            expect(result.ok).toBe(true)
            expect(result.output).toBeDefined()
            // Stdout contains only the clean JSON report
            expect(stdoutLogs.length).toBe(1)
            expect(stdoutLogs.some((msg) => msg.includes('[pnpm profile]'))).toBe(false)
            const parsed = JSON.parse(stdoutLogs[0])
            expect(parsed.summary.cpuLoadPercent).toBe(12.0)
            expect(parsed.hotspots[0].functionName).toBe('testFunction')
            // Stderr contains progress messages
            expect(stderrLogs.some((msg) => msg.includes('[pnpm profile] Starting profiling session'))).toBe(true)
        })

        it('writes output to file when --output is provided', async () => {
            const outputPath = path.join(tmpDir, 'subfolder', 'test-report.md')
            const stdoutLogs: string[] = []
            const stderrLogs: string[] = []

            const result = await runProfile(
                {
                    durationMs: 50,
                    target: 'all',
                    port: serverPort,
                    host: '127.0.0.1',
                    format: 'markdown',
                    spawn: false,
                    saveRaw: false,
                    output: outputPath,
                },
                {
                    projectRoot: tmpDir,
                    stdout: (msg) => stdoutLogs.push(msg),
                    stderr: (msg) => stderrLogs.push(msg),
                    sleep: async () => {},
                },
            )

            expect(result.ok).toBe(true)
            const writtenContent = await fs.readFile(outputPath, 'utf-8')
            expect(writtenContent).toContain('# 🚀 Coding Professional Agent Performance Diagnostic Report')
            expect(writtenContent).toContain('testFunction')
            expect(stderrLogs.some((msg) => msg.includes(`Report saved to: ${outputPath}`))).toBe(true)
        })

        it('saves raw .cpuprofile when --save-raw is provided', async () => {
            const stdoutLogs: string[] = []
            const stderrLogs: string[] = []

            const result = await runProfile(
                {
                    durationMs: 50,
                    target: 'all',
                    port: serverPort,
                    host: '127.0.0.1',
                    format: 'markdown',
                    spawn: false,
                    saveRaw: true,
                },
                {
                    projectRoot: tmpDir,
                    stdout: (msg) => stdoutLogs.push(msg),
                    stderr: (msg) => stderrLogs.push(msg),
                    sleep: async () => {},
                },
            )

            expect(result.ok).toBe(true)
            expect(result.rawFilePath).toBeDefined()
            const fileContent = await fs.readFile(result.rawFilePath!, 'utf-8')
            const rawJson = JSON.parse(fileContent)
            expect(rawJson.nodes[0].callFrame.functionName).toBe('(root)')
            expect(stderrLogs.some((msg) => msg.includes('Raw CPU profile saved to:'))).toBe(true)
        })

        it('logs warning when --save-raw is provided but rawProfile is not available', async () => {
            simulateMissingRawProfile = true
            const stdoutLogs: string[] = []
            const stderrLogs: string[] = []

            const result = await runProfile(
                {
                    durationMs: 50,
                    target: 'all',
                    port: serverPort,
                    host: '127.0.0.1',
                    format: 'markdown',
                    spawn: false,
                    saveRaw: true,
                },
                {
                    projectRoot: tmpDir,
                    stdout: (msg) => stdoutLogs.push(msg),
                    stderr: (msg) => stderrLogs.push(msg),
                    sleep: async () => {},
                },
            )

            expect(result.ok).toBe(true)
            expect(result.rawProfile).toBeFalsy()
            expect(result.rawFilePath).toBeUndefined()
            expect(stderrLogs.some((msg) => msg.includes('[pnpm profile] Warning: Raw CPU profile is not available from this session.'))).toBe(true)
        })

        it('handles --spawn workflow when server is initially offline', async () => {
            let killed = false
            let mockServerReady = false
            let spawnCalled = false

            // Custom fetch that simulates server becoming online after spawn
            const customFetch = async (url: string, options?: any) => {
                if (!mockServerReady) {
                    throw new Error('ECONNREFUSED')
                }
                return fetch(url.replace(/http:\/\/127\.0\.0\.1:\d+/, `http://127.0.0.1:${serverPort}`), options)
            }

            const mockSpawnDevInstance = async () => {
                spawnCalled = true
                setTimeout(() => {
                    mockServerReady = true
                }, 50)
                return {
                    kill: (signal: string) => {
                        killed = true
                    },
                }
            }

            const stdoutLogs: string[] = []
            const stderrLogs: string[] = []
            const result = await runProfile(
                {
                    durationMs: 50,
                    target: 'all',
                    port: 12345,
                    host: '127.0.0.1',
                    format: 'markdown',
                    spawn: true,
                    saveRaw: false,
                },
                {
                    fetch: customFetch as any,
                    spawnDevInstance: mockSpawnDevInstance,
                    stdout: (msg) => stdoutLogs.push(msg),
                    stderr: (msg) => stderrLogs.push(msg),
                    sleep: (ms) => new Promise((res) => setTimeout(res, 20)),
                },
            )

            expect(spawnCalled).toBe(true)
            expect(result.ok).toBe(true)
            expect(killed).toBe(true)
            expect(stderrLogs.join('\n')).toContain('Spawning temporary dev instance')
            expect(stderrLogs.join('\n')).toContain('Temporary dev instance terminated')
        })
    })
})
