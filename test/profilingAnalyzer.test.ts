import { describe, it, expect } from 'vitest'
import {
    ProfilingAnalyzer,
    type PerformanceReport,
    type PluginMetric,
} from '../src/main/services/profilingAnalyzer.js'
import type { V8CpuProfile } from '../src/main/services/profilingService.js'

describe('ProfilingAnalyzer', () => {
    const fakeProjectRoot = '/workspace/CodingProfessionalAgent'

    it('should parse V8 profile with samples and timeDeltas to calculate self and total time', () => {
        const profile: V8CpuProfile = {
            startTime: 0,
            endTime: 100_000, // 100ms
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
                    children: [2],
                },
                {
                    id: 2,
                    callFrame: {
                        functionName: 'mainFunction',
                        scriptId: '1',
                        url: `${fakeProjectRoot}/src/main/services/mainService.ts`,
                        lineNumber: 10,
                        columnNumber: 5,
                    },
                    children: [3, 4],
                },
                {
                    id: 3,
                    callFrame: {
                        functionName: 'computeHash',
                        scriptId: '2',
                        url: `${fakeProjectRoot}/src/main/services/cryptoService.ts`,
                        lineNumber: 42,
                        columnNumber: 8,
                    },
                    children: [],
                },
                {
                    id: 4,
                    callFrame: {
                        functionName: 'fetchData',
                        scriptId: '3',
                        url: `${fakeProjectRoot}/src/main/services/fetchService.ts`,
                        lineNumber: 88,
                        columnNumber: 12,
                    },
                    children: [],
                },
            ],
            // 4 samples: 1 in computeHash, 2 in fetchData, 1 in mainFunction
            samples: [3, 4, 4, 2],
            timeDeltas: [20_000, 30_000, 30_000, 20_000], // 20ms, 30ms, 30ms, 20ms = 100ms total
        }

        const report = ProfilingAnalyzer.analyze(profile, {
            projectRoot: fakeProjectRoot,
            durationMs: 100,
            target: 'main',
        })

        expect(report.summary.durationMs).toBe(100)
        expect(report.summary.target).toBe('main')
        expect(report.summary.totalSamples).toBe(4)

        // Hotspots should be sorted by selfTimeMs desc, then totalTimeMs desc:
        // 1. fetchData: self 60ms, total 60ms (60% active)
        // 2. mainFunction: self 20ms, total 100ms (20% active) - higher totalTimeMs breaks tie
        // 3. computeHash: self 20ms, total 20ms (20% active)
        expect(report.hotspots.length).toBe(3)

        const [h1, h2, h3] = report.hotspots
        expect(h1.functionName).toBe('fetchData')
        expect(h1.selfTimeMs).toBe(60)
        expect(h1.totalTimeMs).toBe(60)
        expect(h1.selfTimePercent).toBe(60)
        expect(h1.url).toBe('src/main/services/fetchService.ts')
        expect(h1.lineNumber).toBe(89) // 0-based 88 converted to 1-based 89
        expect(h1.columnNumber).toBe(13) // 0-based 12 converted to 1-based 13
        expect(h1.module).toBe('Main Service')

        expect(h2.functionName).toBe('mainFunction')
        expect(h2.selfTimeMs).toBe(20)
        expect(h2.totalTimeMs).toBe(100)
        expect(h2.selfTimePercent).toBe(20)
        expect(h2.url).toBe('src/main/services/mainService.ts')
        expect(h2.lineNumber).toBe(11) // 10 -> 11
        expect(h2.columnNumber).toBe(6) // 5 -> 6

        expect(h3.functionName).toBe('computeHash')
        expect(h3.selfTimeMs).toBe(20)
        expect(h3.totalTimeMs).toBe(20)
        expect(h3.selfTimePercent).toBe(20)
        expect(h3.url).toBe('src/main/services/cryptoService.ts')
        expect(h3.lineNumber).toBe(43) // 42 -> 43
        expect(h3.columnNumber).toBe(9) // 8 -> 9
    })

    it('should filter out idle and system wait calls from hotspots', () => {
        const profile: V8CpuProfile = {
            startTime: 0,
            endTime: 500_000,
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
                    children: [2, 3, 4],
                },
                {
                    id: 2,
                    callFrame: {
                        functionName: '(idle)',
                        scriptId: '0',
                        url: '',
                        lineNumber: 0,
                        columnNumber: 0,
                    },
                },
                {
                    id: 3,
                    callFrame: {
                        functionName: 'epoll_wait',
                        scriptId: '0',
                        url: '',
                        lineNumber: 0,
                        columnNumber: 0,
                    },
                },
                {
                    id: 4,
                    callFrame: {
                        functionName: 'workerTask',
                        scriptId: '1',
                        url: `${fakeProjectRoot}/src/main/worker.ts`,
                        lineNumber: 15,
                        columnNumber: 4,
                    },
                },
            ],
            samples: [2, 3, 4],
            timeDeltas: [400_000, 50_000, 50_000], // 400ms idle, 50ms wait, 50ms active work
        }

        const report = ProfilingAnalyzer.analyze(profile, {
            projectRoot: fakeProjectRoot,
            durationMs: 500,
        })

        // Only workerTask should appear in hotspots
        expect(report.hotspots.length).toBe(1)
        expect(report.hotspots[0].functionName).toBe('workerTask')
        expect(report.hotspots[0].selfTimeMs).toBe(50)
        expect(report.hotspots[0].selfTimePercent).toBe(100) // 100% of active CPU time

        // CPU load is 50ms / 500ms = 10%
        expect(report.summary.cpuLoadPercent).toBe(10)
    })

    it('should normalize various URL formats into clean relative project paths', () => {
        expect(ProfilingAnalyzer.normalizeUrl('', fakeProjectRoot)).toBe('[native code]')
        expect(
            ProfilingAnalyzer.normalizeUrl(
                `file://${fakeProjectRoot}/src/main/services/testService.ts`,
                fakeProjectRoot,
            ),
        ).toBe('src/main/services/testService.ts')

        expect(
            ProfilingAnalyzer.normalizeUrl(
                'http://localhost:5173/src/components/chat/MessageList.tsx',
                fakeProjectRoot,
            ),
        ).toBe('src/components/chat/MessageList.tsx')

        expect(
            ProfilingAnalyzer.normalizeUrl(
                `/@fs/${fakeProjectRoot}/frontend/src/app/App.tsx`,
                fakeProjectRoot,
            ),
        ).toBe('frontend/src/app/App.tsx')

        expect(
            ProfilingAnalyzer.normalizeUrl('node:internal/modules/cjs/loader', fakeProjectRoot),
        ).toBe('node:internal/modules/cjs/loader')

        // Test with queries, hashes, and localhost file URLs
        expect(
            ProfilingAnalyzer.normalizeUrl(
                `http://localhost:5173/@fs${fakeProjectRoot}/frontend/src/app/App.tsx?t=123#header`,
                fakeProjectRoot,
            ),
        ).toBe('frontend/src/app/App.tsx')

        expect(
            ProfilingAnalyzer.normalizeUrl(
                `file://localhost${fakeProjectRoot}/src/main/services/testService.ts?query=1`,
                fakeProjectRoot,
            ),
        ).toBe('src/main/services/testService.ts')
    })

    it('should correctly infer architectural module types', () => {
        expect(
            ProfilingAnalyzer.inferModule('src/main/services/sessionDatabaseService.ts', 'exec'),
        ).toBe('SQLite DB')
        expect(
            ProfilingAnalyzer.inferModule('src/features/agent-runtime/protocol/streamingJson.ts', 'parse'),
        ).toBe('Agent Runtime')
        expect(
            ProfilingAnalyzer.inferModule('src/main/services/environmentWatcherService.ts', 'onFileChange'),
        ).toBe('Main Service')
        expect(
            ProfilingAnalyzer.inferModule('src/preload/index.cts', 'saveFile'),
        ).toBe('Preload Bridge')
        expect(
            ProfilingAnalyzer.inferModule('frontend/src/components/TitleBar.tsx', 'render'),
        ).toBe('React / UI')
        expect(
            ProfilingAnalyzer.inferModule('plugins/custom-plugin/index.ts', 'onHook'),
        ).toBe('Plugin')
        expect(
            ProfilingAnalyzer.inferModule('node:fs', 'readFileSync'),
        ).toBe('Node.js Core')
    })

    it('should detect SYNC_BLOCKING_IO bottlenecks and generate actionable suggestions', () => {
        const profile: V8CpuProfile = {
            startTime: 0,
            endTime: 200_000,
            nodes: [
                {
                    id: 1,
                    callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: 0, columnNumber: 0 },
                    children: [2],
                },
                {
                    id: 2,
                    callFrame: {
                        functionName: 'fs.readFileSync',
                        scriptId: '1',
                        url: `${fakeProjectRoot}/src/main/services/environmentWatcherService.ts`,
                        lineNumber: 74,
                        columnNumber: 12,
                    },
                },
            ],
            samples: [2],
            timeDeltas: [140_000], // 140ms sync IO
        }

        const report = ProfilingAnalyzer.analyze(profile, {
            projectRoot: fakeProjectRoot,
            durationMs: 200,
        })

        expect(report.bottlenecks.length).toBeGreaterThan(0)
        const ioBottleneck = report.bottlenecks.find((b) => b.type === 'SYNC_BLOCKING_IO')
        expect(ioBottleneck).toBeDefined()
        expect(ioBottleneck?.severity).toBe('HIGH')
        expect(ioBottleneck?.location).toBe('src/main/services/environmentWatcherService.ts:75:13')
        expect(ioBottleneck?.selfTimePercent).toBe(100)

        const suggestion = report.aiSuggestions.find((s) => s.category === 'ASYNC_IO_REFACTOR')
        expect(suggestion).toBeDefined()
        expect(suggestion?.targetFile).toBe('src/main/services/environmentWatcherService.ts')
        expect(suggestion?.targetLine).toBe(75)
        expect(suggestion?.action).toContain('fs.promises')
    })

    it('should detect SQLITE_SLOW_OPERATION bottlenecks', () => {
        const profile: V8CpuProfile = {
            startTime: 0,
            endTime: 100_000,
            nodes: [
                {
                    id: 1,
                    callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: 0, columnNumber: 0 },
                    children: [2],
                },
                {
                    id: 2,
                    callFrame: {
                        functionName: 'Database.exec',
                        scriptId: '1',
                        url: `${fakeProjectRoot}/src/main/services/sessionDatabaseService.ts`,
                        lineNumber: 210,
                        columnNumber: 15,
                    },
                },
            ],
            samples: [2],
            timeDeltas: [85_000],
        }

        const report = ProfilingAnalyzer.analyze(profile, {
            projectRoot: fakeProjectRoot,
            durationMs: 100,
        })

        const dbBottleneck = report.bottlenecks.find((b) => b.type === 'SQLITE_SLOW_OPERATION')
        expect(dbBottleneck).toBeDefined()
        expect(dbBottleneck?.severity).toBe('MEDIUM')
        expect(dbBottleneck?.location).toBe('src/main/services/sessionDatabaseService.ts:211:16')

        const suggestion = report.aiSuggestions.find((s) => s.category === 'DATABASE_BATCHING')
        expect(suggestion).toBeDefined()
        expect(suggestion?.action).toContain('db.transaction')
    })

    it('should detect FREQUENT_IPC bottlenecks', () => {
        const profile: V8CpuProfile = {
            startTime: 0,
            endTime: 100_000,
            nodes: [
                {
                    id: 1,
                    callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: 0, columnNumber: 0 },
                    children: [2],
                },
                {
                    id: 2,
                    callFrame: {
                        functionName: 'handleIpcBroadcast',
                        scriptId: '1',
                        url: `${fakeProjectRoot}/src/main/ipc/registerIpcHandlers.ts`,
                        lineNumber: 45,
                        columnNumber: 10,
                    },
                },
            ],
            samples: [2],
            timeDeltas: [50_000],
        }

        const report = ProfilingAnalyzer.analyze(profile, {
            projectRoot: fakeProjectRoot,
            durationMs: 100,
        })

        const ipcBottleneck = report.bottlenecks.find((b) => b.type === 'FREQUENT_IPC')
        expect(ipcBottleneck).toBeDefined()
        expect(ipcBottleneck?.location).toBe('src/main/ipc/registerIpcHandlers.ts:46:11')
    })

    it('should detect REACT_EXCESSIVE_RENDER bottlenecks', () => {
        const profile: V8CpuProfile = {
            startTime: 0,
            endTime: 100_000,
            nodes: [
                {
                    id: 1,
                    callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: 0, columnNumber: 0 },
                    children: [2],
                },
                {
                    id: 2,
                    callFrame: {
                        functionName: 'renderWithHooks',
                        scriptId: '1',
                        url: 'frontend/src/components/chat/MessageItem.tsx',
                        lineNumber: 120,
                        columnNumber: 8,
                    },
                },
            ],
            samples: [2],
            timeDeltas: [60_000],
        }

        const report = ProfilingAnalyzer.analyze(profile, {
            projectRoot: fakeProjectRoot,
            durationMs: 100,
        })

        const reactBottleneck = report.bottlenecks.find((b) => b.type === 'REACT_EXCESSIVE_RENDER')
        expect(reactBottleneck).toBeDefined()
        expect(reactBottleneck?.severity).toBe('MEDIUM')
    })

    it('should detect EVENT_LOOP_DELAY bottlenecks strictly when lag > 50ms', () => {
        const profile: V8CpuProfile = {
            startTime: 0,
            endTime: 100_000,
            nodes: [
                {
                    id: 1,
                    callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: 0, columnNumber: 0 },
                },
            ],
            samples: [],
        }

        // Exactly 50ms does not trigger bottleneck (> 50 required)
        const report50 = ProfilingAnalyzer.analyze(profile, {
            eventLoopDelayMs: 50,
            durationMs: 100,
        })
        expect(report50.bottlenecks.find((b) => b.type === 'EVENT_LOOP_DELAY')).toBeUndefined()

        // 50.1ms triggers bottleneck
        const report501 = ProfilingAnalyzer.analyze(profile, {
            eventLoopDelayMs: 50.1,
            durationMs: 100,
        })
        const loopBottleneck = report501.bottlenecks.find((b) => b.type === 'EVENT_LOOP_DELAY')
        expect(loopBottleneck).toBeDefined()
        expect(loopBottleneck?.severity).toBe('MEDIUM')

        // 120ms triggers HIGH severity bottleneck
        const report120 = ProfilingAnalyzer.analyze(profile, {
            eventLoopDelayMs: 120,
            durationMs: 100,
        })
        const highLoopBottleneck = report120.bottlenecks.find((b) => b.type === 'EVENT_LOOP_DELAY')
        expect(highLoopBottleneck).toBeDefined()
        expect(highLoopBottleneck?.severity).toBe('HIGH')
        expect(highLoopBottleneck?.message).toContain('120.0ms')
    })

    it('should detect PLUGIN_PERF_REGRESSION bottlenecks from pluginMetrics', () => {
        const profile: V8CpuProfile = {
            startTime: 0,
            endTime: 100_000,
            nodes: [
                {
                    id: 1,
                    callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: 0, columnNumber: 0 },
                },
            ],
            samples: [],
        }

        const pluginMetrics: PluginMetric[] = [
            {
                pluginId: 'core:file-manager',
                callCount: 120,
                totalDurationMs: 88,
                maxDurationMs: 14.5,
            },
        ]

        const report = ProfilingAnalyzer.analyze(profile, {
            pluginMetrics,
            durationMs: 100,
        })

        expect(report.pluginMetrics.length).toBe(1)
        const pluginBottleneck = report.bottlenecks.find((b) => b.type === 'PLUGIN_PERF_REGRESSION')
        expect(pluginBottleneck).toBeDefined()
        expect(pluginBottleneck?.location).toBe('core:file-manager')
    })

    it('should detect bottlenecks when plugin has timeouts or high error counts', () => {
        const profile: V8CpuProfile = {
            startTime: 0,
            endTime: 100_000,
            nodes: [
                {
                    id: 1,
                    callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: 0, columnNumber: 0 },
                },
            ],
            samples: [],
        }

        const pluginMetrics: PluginMetric[] = [
            {
                pluginId: 'faulty:plugin',
                activationCount: 1,
                callCount: 5,
                totalDurationMs: 12,
                maxDurationMs: 4,
                errorCount: 3,
                timeoutCount: 1,
                activeLeases: 0,
            },
        ]

        const report = ProfilingAnalyzer.analyze(profile, {
            pluginMetrics,
            durationMs: 100,
        })

        expect(report.pluginMetrics.length).toBe(1)
        const bottleneck = report.bottlenecks.find((b) => b.type === 'PLUGIN_PERF_REGRESSION')
        expect(bottleneck).toBeDefined()
        expect(bottleneck?.location).toBe('faulty:plugin')
        expect(bottleneck?.severity).toBe('HIGH')
        expect(bottleneck?.message).toContain('timeouts: 1')
    })

    it('should fallback to hitCount tree traversal when samples array is empty', () => {
        const profile: V8CpuProfile = {
            startTime: 0,
            endTime: 100_000,
            nodes: [
                {
                    id: 1,
                    callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: 0, columnNumber: 0 },
                    children: [2],
                    hitCount: 0,
                },
                {
                    id: 2,
                    callFrame: {
                        functionName: 'heavyTask',
                        scriptId: '1',
                        url: `${fakeProjectRoot}/src/main/heavy.ts`,
                        lineNumber: 10,
                        columnNumber: 2,
                    },
                    hitCount: 50,
                },
            ],
        }

        const report = ProfilingAnalyzer.analyze(profile, {
            projectRoot: fakeProjectRoot,
            durationMs: 100,
        })

        expect(report.hotspots.length).toBe(1)
        expect(report.hotspots[0].functionName).toBe('heavyTask')
        expect(report.hotspots[0].selfTimeMs).toBe(100)
    })

    it('should generate properly formatted Markdown reports matching spec', () => {
        const mockReport: PerformanceReport = {
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
                    selfTimeMs: 142,
                    totalTimeMs: 380,
                    selfTimePercent: 15.2,
                    module: 'Main Service',
                },
            ],
            bottlenecks: [
                {
                    type: 'SYNC_BLOCKING_IO',
                    severity: 'HIGH',
                    message: 'Synchronous blocking I/O operation detected in EnvironmentWatcherService.onFileChange (142.0ms self time)',
                    location: 'src/main/services/environmentWatcherService.ts:74:12',
                    selfTimeMs: 142,
                    selfTimePercent: 15.2,
                },
            ],
            pluginMetrics: [
                {
                    pluginId: 'core:file-manager',
                    callCount: 120,
                    totalDurationMs: 88,
                    maxDurationMs: 14.5,
                },
            ],
            aiSuggestions: [
                {
                    targetFile: 'src/main/services/environmentWatcherService.ts',
                    targetLine: 74,
                    category: 'ASYNC_IO_REFACTOR',
                    action: 'Replace synchronous fs calls with asynchronous fs.promises and debounce file watcher triggers',
                },
            ],
        }

        const markdown = ProfilingAnalyzer.formatMarkdown(mockReport)

        expect(markdown).toContain('# 🚀 Coding Professional Agent Performance Diagnostic Report')
        expect(markdown).toContain('- **Sampling Duration**: 5.00s | **Sampling Target**: Full-Stack (Main + Renderer + Plugins)')
        expect(markdown).toContain('- **Active CPU Load**: 18.4% | **Average Event Loop Delay**: 4.2ms')
        expect(markdown).toContain('## 🔥 Top 10 CPU Hotspots')
        expect(markdown).toContain('| 1 | `EnvironmentWatcherService.onFileChange` | `src/main/services/environmentWatcherService.ts:74:12` | 142ms | 380ms | 15.2% | Main Service |')
        expect(markdown).toContain('## ⚠️ Detected Performance Bottlenecks (1)')
        expect(markdown).toContain('1. **[SYNC_BLOCKING_IO] (High)**: Synchronous blocking I/O operation detected in EnvironmentWatcherService.onFileChange (142.0ms self time)')
        expect(markdown).toContain('- **Location**: `src/main/services/environmentWatcherService.ts:74:12`')
        expect(markdown).toContain('- **Self Time**: 142ms (15.2%)')
        expect(markdown).toContain('## 🧩 Plugin Execution Time Statistics')
        expect(markdown).toContain('| `core:file-manager` | 120 | 88ms | 14.5ms | ⚠️ High |')
        expect(markdown).toContain('## 💡 AI Automated Optimization Suggestions')
        expect(markdown).toContain('1. **ASYNC_IO_REFACTOR** (src/main/services/environmentWatcherService.ts:74):')
    })

    it('should detect CPU_INTENSIVE bottlenecks for generic compute-heavy functions', () => {
        const profile: V8CpuProfile = {
            startTime: 0,
            endTime: 200_000,
            nodes: [
                {
                    id: 1,
                    callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: 0, columnNumber: 0 },
                    children: [2],
                },
                {
                    id: 2,
                    callFrame: {
                        functionName: 'matrixMultiplication',
                        scriptId: '1',
                        url: `${fakeProjectRoot}/src/main/math.ts`,
                        lineNumber: 50,
                        columnNumber: 4,
                    },
                },
            ],
            samples: [2],
            timeDeltas: [180_000], // 180ms CPU heavy
        }

        const report = ProfilingAnalyzer.analyze(profile, {
            projectRoot: fakeProjectRoot,
            durationMs: 200,
        })

        const cpuBottleneck = report.bottlenecks.find((b) => b.type === 'CPU_INTENSIVE')
        expect(cpuBottleneck).toBeDefined()
        expect(cpuBottleneck?.severity).toBe('HIGH')
        expect(cpuBottleneck?.location).toBe('src/main/math.ts:51:5')
        expect(cpuBottleneck?.selfTimePercent).toBe(100)

        const suggestion = report.aiSuggestions.find((s) => s.category === 'ALGORITHM_OPTIMIZATION')
        expect(suggestion).toBeDefined()
        expect(suggestion?.targetFile).toBe('src/main/math.ts')
    })

    it('should handle recursive call frames without double counting total time', () => {
        const profile: V8CpuProfile = {
            startTime: 0,
            endTime: 50_000,
            nodes: [
                {
                    id: 1,
                    callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: 0, columnNumber: 0 },
                    children: [2],
                },
                {
                    id: 2,
                    callFrame: {
                        functionName: 'recursiveFactorial',
                        scriptId: '1',
                        url: `${fakeProjectRoot}/src/factorial.ts`,
                        lineNumber: 5,
                        columnNumber: 2,
                    },
                    children: [3],
                },
                {
                    id: 3,
                    callFrame: {
                        functionName: 'recursiveFactorial',
                        scriptId: '1',
                        url: `${fakeProjectRoot}/src/factorial.ts`,
                        lineNumber: 5,
                        columnNumber: 2,
                    },
                },
            ],
            // 1 sample in the inner recursive call (node 3)
            samples: [3],
            timeDeltas: [50_000],
        }

        const report = ProfilingAnalyzer.analyze(profile, {
            projectRoot: fakeProjectRoot,
            durationMs: 50,
        })

        expect(report.hotspots.length).toBe(1)
        const fn = report.hotspots[0]
        expect(fn.functionName).toBe('recursiveFactorial')
        expect(fn.selfTimeMs).toBe(50)
        // totalTimeMs must not double-count to 100ms for a 50ms sample
        expect(fn.totalTimeMs).toBe(50)
    })

    it('should prevent infinite loops on cyclic node graphs and self-referencing children', () => {
        const cyclicProfile: V8CpuProfile = {
            startTime: 0,
            endTime: 100_000,
            nodes: [
                {
                    id: 1,
                    callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: 0, columnNumber: 0 },
                    children: [2],
                },
                {
                    id: 2,
                    callFrame: { functionName: 'cyclicA', scriptId: '1', url: 'src/a.ts', lineNumber: 10, columnNumber: 1 },
                    children: [3],
                },
                {
                    id: 3,
                    callFrame: { functionName: 'cyclicB', scriptId: '2', url: 'src/b.ts', lineNumber: 20, columnNumber: 2 },
                    children: [2], // Cycle: 3 -> 2 -> 3
                },
                {
                    id: 4,
                    callFrame: { functionName: 'selfReferencing', scriptId: '3', url: 'src/c.ts', lineNumber: 30, columnNumber: 3 },
                    children: [4], // Self-referencing cycle
                },
            ],
            samples: [3, 4],
            timeDeltas: [50_000, 50_000],
        }

        const startTime = Date.now()
        const report = ProfilingAnalyzer.analyze(cyclicProfile, { projectRoot: fakeProjectRoot })
        const elapsed = Date.now() - startTime

        expect(elapsed).toBeLessThan(1000)
        expect(report.hotspots.length).toBeGreaterThan(0)
    })

    it('should handle missing callFrame and malformed nodes gracefully', () => {
        const malformedProfile = {
            startTime: 0,
            endTime: 50_000,
            nodes: [
                null,
                { id: 'not-a-number' },
                {
                    id: 1,
                    // callFrame is undefined
                    children: [2],
                },
                {
                    id: 2,
                    callFrame: {
                        functionName: '',
                        scriptId: '1',
                        url: '',
                        lineNumber: -1,
                        columnNumber: -1,
                    },
                },
                {
                    id: 3,
                    callFrame: null as any,
                },
            ],
            samples: [1, 2, 3, 999], // 999 doesn't exist in nodeMap
            timeDeltas: [10_000, 10_000, 10_000, 10_000],
        } as unknown as V8CpuProfile

        expect(() => ProfilingAnalyzer.analyze(malformedProfile)).not.toThrow()
        const report = ProfilingAnalyzer.analyze(malformedProfile)
        expect(report.summary.totalSamples).toBe(4)
    })

    it('should handle missing or mismatched length timeDeltas with fallback', () => {
        const profile: V8CpuProfile = {
            startTime: 0,
            endTime: 100_000, // 100ms duration for 4 samples -> defaultDeltaMicros = 25ms
            nodes: [
                {
                    id: 1,
                    callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: 0, columnNumber: 0 },
                    children: [2],
                },
                {
                    id: 2,
                    callFrame: {
                        functionName: 'computeTask',
                        scriptId: '1',
                        url: `${fakeProjectRoot}/src/compute.ts`,
                        lineNumber: 5,
                        columnNumber: 0,
                    },
                },
            ],
            samples: [2, 2, 2, 2],
            // timeDeltas has only 2 items, second one is negative
            timeDeltas: [40_000, -100],
        }

        const report = ProfilingAnalyzer.analyze(profile, {
            projectRoot: fakeProjectRoot,
        })

        expect(report.hotspots.length).toBe(1)
        // Sample 0: 40ms. Samples 1, 2, 3: fallback 25ms each = 75ms. Total = 115ms
        expect(report.hotspots[0].selfTimeMs).toBe(115)
    })

    it('should convert 0-based V8 line and column numbers to 1-based correctly', () => {
        const profile: V8CpuProfile = {
            startTime: 0,
            endTime: 50_000,
            nodes: [
                {
                    id: 1,
                    callFrame: {
                        functionName: 'zeroBasedFunction',
                        scriptId: '1',
                        url: `${fakeProjectRoot}/src/zero.ts`,
                        lineNumber: 0, // 0-based -> line 1
                        columnNumber: 0, // 0-based -> col 1
                    },
                },
                {
                    id: 2,
                    callFrame: {
                        functionName: 'negativeLineFunction',
                        scriptId: '2',
                        url: `${fakeProjectRoot}/src/neg.ts`,
                        lineNumber: -1, // Unknown -> 0
                        columnNumber: -1, // Unknown -> 0
                    },
                },
            ],
            samples: [1, 2],
            timeDeltas: [25_000, 25_000],
        }

        const report = ProfilingAnalyzer.analyze(profile, { projectRoot: fakeProjectRoot })
        expect(report.hotspots.length).toBe(2)

        const zeroFn = report.hotspots.find((h) => h.functionName === 'zeroBasedFunction')
        expect(zeroFn?.lineNumber).toBe(1)
        expect(zeroFn?.columnNumber).toBe(1)

        const negFn = report.hotspots.find((h) => h.functionName === 'negativeLineFunction')
        expect(negFn?.lineNumber).toBe(0)
        expect(negFn?.columnNumber).toBe(0)

        // Test location formatting
        expect(ProfilingAnalyzer.formatLocation('src/zero.ts', 1, 1)).toBe('src/zero.ts:1:1')
        expect(ProfilingAnalyzer.formatLocation('src/zero.ts', 1, 0)).toBe('src/zero.ts:1')
        expect(ProfilingAnalyzer.formatLocation('src/zero.ts', 0, 0)).toBe('src/zero.ts')
    })

    it('should handle recursive functions in hitCount fallback mode without double counting total time', () => {
        const hitCountProfile: V8CpuProfile = {
            startTime: 0,
            endTime: 50_000,
            nodes: [
                {
                    id: 1,
                    callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: 0, columnNumber: 0 },
                    children: [2],
                    hitCount: 0,
                },
                {
                    id: 2,
                    callFrame: {
                        functionName: 'recursiveFibonacci',
                        scriptId: '1',
                        url: `${fakeProjectRoot}/src/fib.ts`,
                        lineNumber: 10,
                        columnNumber: 5,
                    },
                    children: [3],
                    hitCount: 0,
                },
                {
                    id: 3,
                    callFrame: {
                        functionName: 'recursiveFibonacci',
                        scriptId: '1',
                        url: `${fakeProjectRoot}/src/fib.ts`,
                        lineNumber: 10,
                        columnNumber: 5,
                    },
                    hitCount: 50,
                },
            ],
            samples: [],
        }

        const report = ProfilingAnalyzer.analyze(hitCountProfile, {
            projectRoot: fakeProjectRoot,
            durationMs: 50,
        })

        expect(report.hotspots.length).toBe(1)
        const fn = report.hotspots[0]
        expect(fn.functionName).toBe('recursiveFibonacci')
        expect(fn.selfTimeMs).toBe(50)
        // totalTimeMs must not double-count to 100ms
        expect(fn.totalTimeMs).toBe(50)
    })

    it('should truncate hotspots to Top 10 when profile has more than 10 functions', () => {
        const nodes = [
            {
                id: 1,
                callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: 0, columnNumber: 0 },
                children: Array.from({ length: 15 }, (_, i) => i + 2),
            },
        ]

        // Create 15 distinct functions with increasing self times
        for (let i = 1; i <= 15; i++) {
            nodes.push({
                id: i + 1,
                callFrame: {
                    functionName: `func_${i}`,
                    scriptId: `${i}`,
                    url: `${fakeProjectRoot}/src/func_${i}.ts`,
                    lineNumber: i,
                    columnNumber: 0,
                },
                children: [] as number[],
            })
        }

        const samples: number[] = []
        const timeDeltas: number[] = []
        for (let i = 1; i <= 15; i++) {
            samples.push(i + 1)
            timeDeltas.push(i * 10_000) // 10ms, 20ms, ..., 150ms
        }

        const profile: V8CpuProfile = {
            startTime: 0,
            endTime: 1_200_000,
            nodes,
            samples,
            timeDeltas,
        }

        const report = ProfilingAnalyzer.analyze(profile, { projectRoot: fakeProjectRoot })

        expect(report.hotspots.length).toBe(10)
        expect(report.hotspots[0].functionName).toBe('func_15')
        expect(report.hotspots[0].rank).toBe(1)
        expect(report.hotspots[0].selfTimeMs).toBe(150)
        expect(report.hotspots[9].functionName).toBe('func_6')
        expect(report.hotspots[9].rank).toBe(10)
        expect(report.hotspots[9].selfTimeMs).toBe(60)
    })

    it('should handle empty or invalid profile input gracefully', () => {
        const emptyProfile = {} as V8CpuProfile
        const report = ProfilingAnalyzer.analyze(emptyProfile)

        expect(report.hotspots).toEqual([])
        expect(report.bottlenecks).toEqual([])
        expect(report.pluginMetrics).toEqual([])
        expect(report.aiSuggestions).toEqual([])
        expect(report.summary.totalSamples).toBe(0)

        const markdown = ProfilingAnalyzer.formatMarkdown(report)
        expect(markdown).toContain('*(No significant hotspot functions captured)*')
        expect(markdown).toContain('*(No obvious performance bottlenecks detected)*')
        expect(markdown).toContain('*(No plugin execution metrics)*')
        expect(markdown).toContain('*(Current health is good, no optimization needed)*')
    })

    it('should generate valid JSON matching spec', () => {
        const mockReport: PerformanceReport = {
            summary: {
                durationMs: 5000,
                timestamp: '2026-08-28T10:00:00.000Z',
                target: 'all',
                totalSamples: 1000,
                cpuLoadPercent: 18.4,
                eventLoopDelayMs: 4.2,
            },
            hotspots: [],
            bottlenecks: [],
            pluginMetrics: [],
            aiSuggestions: [],
        }

        const jsonStr = ProfilingAnalyzer.formatJson(mockReport)
        const parsed = JSON.parse(jsonStr)

        expect(parsed.summary.durationMs).toBe(5000)
        expect(parsed.hotspots).toEqual([])
        expect(parsed.bottlenecks).toEqual([])
    })
})
