import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { NativeEvent } from '../src/shared/types.js'
import { PtyService } from '../src/main/services/ptyService.js'

describe('PtyService', () => {
  let service: PtyService
  let emittedEvents: NativeEvent[]

  beforeEach(() => {
    emittedEvents = []
    service = new PtyService((event) => {
      emittedEvents.push(event)
    })
  })

  afterEach(() => {
    service.disposeAll()
  })

  it('starts pty, writes input, and captures output stream', async () => {
    await service.startPty({
      operationId: 'op-pty-1',
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    })

    // Write a simple echo command followed by newline
    service.writePty(
      'op-pty-1',
      Buffer.from('echo HELLO_PTY_SERVICE\nexit\n', 'utf8').toString('base64'),
    )

    // Wait for done event or stdout
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (emittedEvents.some((e) => e.kind === 'done')) {
          clearInterval(interval)
          resolve()
        }
      }, 50)
    })

    const stdoutEvents = emittedEvents.filter((e) => e.kind === 'pty-stdout')
    expect(stdoutEvents.length).toBeGreaterThan(0)

    const allOutput = stdoutEvents
      .map((e) => Buffer.from(e.data!, 'base64').toString('utf8'))
      .join('')
    expect(allOutput).toContain('HELLO_PTY_SERVICE')

    const doneEvent = emittedEvents.find((e) => e.kind === 'done')
    expect(doneEvent).toBeDefined()
  })

  it('handles resize and close', async () => {
    await service.startPty({
      operationId: 'op-pty-2',
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    })

    expect(() => {
      service.resizePty('op-pty-2', 100, 30)
    }).not.toThrow()

    service.closePty('op-pty-2')
  })

  it('gracefully replaces an existing pty session when started with the same operationId', async () => {
    await service.startPty({
      operationId: 'op-pty-reuse',
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    })

    // Starting again with the same operationId should not throw, but replace the existing session
    await expect(
      service.startPty({
        operationId: 'op-pty-reuse',
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
      }),
    ).resolves.toBeUndefined()

    service.closePty('op-pty-reuse')
  })
})
