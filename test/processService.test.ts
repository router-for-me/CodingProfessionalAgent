import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import type { NativeEvent } from '../src/shared/types.js'
import { ProcessService } from '../src/main/services/processService.js'

describe('ProcessService', () => {
  let service: ProcessService
  let emittedEvents: NativeEvent[]

  beforeEach(() => {
    emittedEvents = []
    service = new ProcessService((event) => {
      emittedEvents.push(event)
    })
  })

  afterEach(() => {
    service.disposeAll()
  })

  it('runs a process and collects stdout stream and exit code', async () => {
    const result = await service.startProcess({
      operationId: 'op-proc-1',
      executable: 'node',
      args: ['-e', 'console.log("hello stdout"); process.stderr.write("hello stderr\\n");'],
      cwd: '',
      env: null,
    })

    expect(result.fullOutputPath).toBeDefined()

    // Wait for done event
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (emittedEvents.some((e) => e.kind === 'done')) {
          clearInterval(interval)
          resolve()
        }
      }, 50)
    })

    const stdoutEvent = emittedEvents.find((e) => e.kind === 'process-stdout')
    expect(stdoutEvent).toBeDefined()
    const decodedStdout = Buffer.from(stdoutEvent!.data!, 'base64').toString('utf8')
    expect(decodedStdout).toContain('hello stdout')

    const stderrEvent = emittedEvents.find((e) => e.kind === 'process-stderr')
    expect(stderrEvent).toBeDefined()
    const decodedStderr = Buffer.from(stderrEvent!.data!, 'base64').toString('utf8')
    expect(decodedStderr).toContain('hello stderr')

    const doneEvent = emittedEvents.find((e) => e.kind === 'done')
    expect(doneEvent?.exitCode).toBe(0)

    // Verify full combined output log
    const logContent = await fs.readFile(result.fullOutputPath, 'utf8')
    expect(logContent).toContain('hello stdout')
    expect(logContent).toContain('hello stderr')

    await fs.unlink(result.fullOutputPath).catch(() => {})
  })

  it('does not retain streamed output or build an unused aggregate result', async () => {
    const bytesPerStream = 128 * 1024
    const result = await service.startProcess({
      operationId: 'op-proc-stream-only',
      executable: process.execPath,
      args: ['-e', `process.stdout.write('x'.repeat(${bytesPerStream})); process.stderr.write('y'.repeat(${bytesPerStream}));`],
      cwd: '',
      env: null,
    })
    const operation = (service as any).operations.get('op-proc-stream-only')

    try {
      await vi.waitFor(() => {
        expect(emittedEvents.some((event) => event.kind === 'done')).toBe(true)
      })
      expect(operation.stdoutChunks).toHaveLength(0)
      expect(operation.stderrChunks).toHaveLength(0)
      expect(operation.finalResult).toBeUndefined()
      expect((await fs.stat(result.fullOutputPath)).size).toBe(bytesPerStream * 2)
      for (const kind of ['process-stdout', 'process-stderr']) {
        const streamedBytes = emittedEvents
          .filter((event) => event.kind === kind)
          .reduce((total, event) => total + Buffer.from(event.data!, 'base64').length, 0)
        expect(streamedBytes).toBe(bytesPerStream)
      }
    } finally {
      service.cancelOperation('op-proc-stream-only')
      await fs.unlink(result.fullOutputPath).catch(() => {})
    }
  })

  it('handles process cancel', async () => {
    await service.startProcess({
      operationId: 'op-proc-cancel',
      executable: 'node',
      args: ['-e', 'setTimeout(() => {}, 10000)'],
      cwd: '',
      env: null,
    })

    service.cancelOperation('op-proc-cancel')

    const cancelledEvent = emittedEvents.find((e) => e.kind === 'cancelled')
    expect(cancelledEvent).toBeDefined()
  })

  it('runProcess waits for completion and returns captured output', async () => {
    const result = await service.runProcess({
      operationId: 'op-proc-run',
      executable: 'node',
      args: ['-e', 'console.log("run-ok"); process.stderr.write("run-err\\n");'],
      cwd: '',
      env: null,
    })

    expect(result.exitCode).toBe(0)
    expect(Buffer.from(result.stdoutBase64, 'base64').toString('utf8')).toContain('run-ok')
    expect(Buffer.from(result.stderrBase64, 'base64').toString('utf8')).toContain('run-err')
    expect(result.cancelled).toBeUndefined()

    await fs.unlink(result.fullOutputPath).catch(() => {})
  })

  it('runProcess resolves as cancelled when cancelOperation is called', async () => {
    const pending = service.runProcess({
      operationId: 'op-proc-run-cancel',
      executable: 'node',
      args: ['-e', 'setTimeout(() => {}, 10000)'],
      cwd: '',
      env: null,
    })

    // Allow spawn to register the operation before cancelling.
    await new Promise((resolve) => setTimeout(resolve, 50))
    service.cancelOperation('op-proc-run-cancel')

    const result = await pending
    expect(result.cancelled).toBe(true)
    expect(result.exitCode).toBe(130)
  })

  it('enriches process PATH so child processes inherit developer toolchain paths', async () => {
    const originalPath = process.env.PATH
    try {
      process.env.PATH = '/usr/bin:/bin'
      const result = await service.runProcess({
        operationId: 'op-proc-path-enrich',
        executable: process.execPath,
        args: ['-e', 'console.log(process.env.PATH);'],
        cwd: '',
        env: null,
      })

      expect(result.exitCode).toBe(0)
      const childPath = Buffer.from(result.stdoutBase64, 'base64').toString('utf8')
      expect(childPath).toContain('/usr/bin')
      if (process.platform === 'darwin') {
        expect(
          childPath.includes('/usr/local/go/bin') ||
          childPath.includes('/opt/homebrew/bin') ||
          childPath.includes('/usr/local/bin'),
        ).toBe(true)
      }
      await fs.unlink(result.fullOutputPath).catch(() => {})
    } finally {
      process.env.PATH = originalPath
    }
  })
})
