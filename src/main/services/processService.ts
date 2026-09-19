import * as child_process from 'node:child_process'
import * as fsSync from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type {
  NativeEvent,
  ProcessRunResult,
  ProcessStartRequest,
  ProcessStartResult,
} from '../../shared/types.js'
import { enrichPath } from './shellEnvironment.js'

export type EventEmitter = (event: NativeEvent) => void

interface ProcessOperation {
  operationId: string
  sequence: number
  proc: child_process.ChildProcess
  logFd: number
  logPath: string
  terminated: boolean
  captureOutput: boolean
  stdoutChunks: Buffer[]
  stderrChunks: Buffer[]
  waiters: Array<(result: ProcessRunResult) => void>
  finalResult?: ProcessRunResult
}

function buildRunResult(op: ProcessOperation, partial: Partial<ProcessRunResult>): ProcessRunResult {
  return {
    fullOutputPath: op.logPath,
    stdoutBase64: Buffer.concat(op.stdoutChunks).toString('base64'),
    stderrBase64: Buffer.concat(op.stderrChunks).toString('base64'),
    exitCode: 0,
    ...partial,
  }
}

export class ProcessService {
  private readonly operations = new Map<string, ProcessOperation>()

  constructor(private readonly emitEvent: EventEmitter) {}

  async startProcess(req: ProcessStartRequest): Promise<ProcessStartResult> {
    const op = this.spawnProcess(req, false)
    return { fullOutputPath: op.logPath }
  }

  /**
   * Start a process and wait until it exits, is cancelled, or errors.
   * Used by capability adapters (e.g. hooks) that cannot reliably stream process events.
   */
  async runProcess(req: ProcessStartRequest): Promise<ProcessRunResult> {
    const op = this.spawnProcess(req, true)
    if (op.terminated && op.finalResult) {
      return op.finalResult
    }
    return new Promise<ProcessRunResult>((resolve) => {
      if (op.terminated && op.finalResult) {
        resolve(op.finalResult)
        return
      }
      op.waiters.push(resolve)
    })
  }

  private spawnProcess(req: ProcessStartRequest, captureOutput: boolean): ProcessOperation {
    const { operationId, executable, args = [], cwd, env, stdin } = req
    if (!executable) {
      throw new Error('executable is required')
    }

    if (this.operations.has(operationId)) {
      throw new Error(`operation ${operationId} already exists`)
    }

    const tempPrefix = path.join(
      os.tmpdir(),
      `cpa-process-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`,
    )
    const logFd = fsSync.openSync(tempPrefix, 'w+')
    const logPath = tempPrefix

    const mergedEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...(env || {}),
    }

    if (mergedEnv.PATH) {
      mergedEnv.PATH = enrichPath(mergedEnv.PATH)
    }

    let proc: child_process.ChildProcess
    try {
      proc = child_process.spawn(executable, args || [], {
        cwd: cwd || undefined,
        env: mergedEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      })
    } catch (err: unknown) {
      fsSync.closeSync(logFd)
      try {
        fsSync.unlinkSync(logPath)
      } catch {
        // Ignore cleanup failure
      }
      this.emitTerminal(operationId, 1, {
        kind: 'error',
        error: String((err as Error)?.message || err),
      })
      throw err
    }

    const op: ProcessOperation = {
      operationId,
      sequence: 1,
      proc,
      logFd,
      logPath,
      terminated: false,
      captureOutput,
      stdoutChunks: [],
      stderrChunks: [],
      waiters: [],
    }
    this.operations.set(operationId, op)

    if (proc.stdin) {
      proc.stdin.on('error', (err: NodeJS.ErrnoException) => {
        if (err?.code === 'EPIPE' || err?.code === 'ERR_STREAM_DESTROYED') {
          return
        }
      })
    }

    if (stdin && proc.stdin) {
      try {
        proc.stdin.write(stdin, (err) => {
          if (err && (err as NodeJS.ErrnoException).code !== 'EPIPE') {
            // Ignore EPIPE
          }
        })
        proc.stdin.end()
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException)?.code !== 'EPIPE') {
          // Ignore EPIPE on closed stdin
        }
      }
    }

    if (proc.stdout) {
      proc.stdout.on('data', (chunk: Buffer) => {
        if (op.terminated) return
        if (op.captureOutput) op.stdoutChunks.push(chunk)
        try {
          fsSync.writeSync(op.logFd, chunk)
        } catch {
          // Ignore write error
        }
        const seq = op.sequence++
        this.emitEvent({
          operationId,
          sequence: seq,
          kind: 'process-stdout',
          data: chunk.toString('base64'),
          encoding: 'base64',
        })
      })
    }

    if (proc.stderr) {
      proc.stderr.on('data', (chunk: Buffer) => {
        if (op.terminated) return
        if (op.captureOutput) op.stderrChunks.push(chunk)
        try {
          fsSync.writeSync(op.logFd, chunk)
        } catch {
          // Ignore write error
        }
        const seq = op.sequence++
        this.emitEvent({
          operationId,
          sequence: seq,
          kind: 'process-stderr',
          data: chunk.toString('base64'),
          encoding: 'base64',
        })
      })
    }

    proc.on('error', (err: Error) => {
      if (op.terminated) return
      op.terminated = true
      this.cleanup(op)
      const seq = op.sequence++
      this.emitEvent({
        operationId,
        sequence: seq,
        kind: 'error',
        error: err.message,
      })
      this.resolveWaiters(op, {
        exitCode: 1,
        error: err.message,
      })
      this.operations.delete(operationId)
    })

    proc.on('close', (code: number | null) => {
      if (op.terminated) return
      op.terminated = true
      this.cleanup(op)
      const seq = op.sequence++
      const exitCode = code ?? 0
      this.emitEvent({
        operationId,
        sequence: seq,
        kind: 'done',
        exitCode,
      })
      this.resolveWaiters(op, { exitCode })
      this.operations.delete(operationId)
    })

    return op
  }

  cancelOperation(operationId: string): void {
    const op = this.operations.get(operationId)
    if (!op || op.terminated) return
    op.terminated = true

    this.killProcessTree(op.proc)
    this.cleanup(op)

    const seq = op.sequence++
    this.emitEvent({
      operationId,
      sequence: seq,
      kind: 'cancelled',
    })
    this.resolveWaiters(op, {
      exitCode: 130,
      cancelled: true,
    })
    this.operations.delete(operationId)
  }

  private resolveWaiters(op: ProcessOperation, partial: Partial<ProcessRunResult>): void {
    // Streaming callers consume events and the log, not an aggregate output copy.
    if (!op.captureOutput) return
    const result = buildRunResult(op, partial)
    op.stdoutChunks.length = 0
    op.stderrChunks.length = 0
    op.finalResult = result
    if (op.waiters.length === 0) return
    const waiters = op.waiters.splice(0, op.waiters.length)
    for (const waiter of waiters) {
      try {
        waiter(result)
      } catch {
        // Ignore waiter failures
      }
    }
  }

  private killProcessTree(proc: child_process.ChildProcess): void {
    try {
      if (proc.pid) {
        if (process.platform !== 'win32') {
          process.kill(-proc.pid, 'SIGKILL')
        } else {
          child_process.execSync(`taskkill /pid ${proc.pid} /T /F`)
        }
      }
    } catch {
      try {
        proc.kill('SIGKILL')
      } catch {
        // Process might have already exited
      }
    }
  }

  private cleanup(op: ProcessOperation): void {
    try {
      fsSync.closeSync(op.logFd)
    } catch {
      // Ignore already closed fd
    }
  }

  private emitTerminal(operationId: string, sequence: number, partial: Partial<NativeEvent>): void {
    this.emitEvent({
      operationId,
      sequence,
      kind: partial.kind || 'done',
      ...partial,
    })
  }

  disposeAll(): void {
    for (const [id, op] of this.operations) {
      if (!op.terminated) {
        op.terminated = true
        this.killProcessTree(op.proc)
        this.cleanup(op)
        this.resolveWaiters(op, {
          exitCode: 130,
          cancelled: true,
        })
      }
      this.operations.delete(id)
    }
  }
}
