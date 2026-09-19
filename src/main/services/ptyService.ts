import * as pty from 'node-pty'
import * as os from 'node:os'
import * as path from 'node:path'
import * as fsSync from 'node:fs'
import { createRequire } from 'node:module'
import type { NativeEvent, PtyStartRequest } from '../../shared/types.js'
import type { EventEmitter } from './processService.js'
import { enrichPath } from './shellEnvironment.js'

const require = createRequire(import.meta.url)

function ensureSpawnHelperExecutable(): void {
  if (process.platform === 'win32') return
  try {
    const ptyPath = require.resolve('node-pty')
    const ptyDir = path.dirname(ptyPath)
    const candidates = [
      path.resolve(ptyDir, '..', 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
      path.resolve(ptyDir, '..', 'build', 'Release', 'spawn-helper'),
      path.resolve(ptyDir, '..', 'build', 'Debug', 'spawn-helper'),
    ]
    for (const candidate of candidates) {
      const unpacked = candidate
        .replace('app.asar', 'app.asar.unpacked')
        .replace('node_modules.asar', 'node_modules.asar.unpacked')
      if (fsSync.existsSync(unpacked)) {
        try {
          const stat = fsSync.statSync(unpacked)
          if ((stat.mode & 0o111) === 0) {
            fsSync.chmodSync(unpacked, stat.mode | 0o755)
          }
        } catch {
          // Ignore chmod error
        }
      }
    }
  } catch {
    // Ignore resolution errors
  }
}

interface PtyOperation {
  operationId: string
  sequence: number
  ptyProcess: pty.IPty
  terminated: boolean
}

export class PtyService {
  private readonly operations = new Map<string, PtyOperation>()

  constructor(private readonly emitEvent: EventEmitter) {}

  async startPty(req: PtyStartRequest): Promise<void> {
    const { operationId, cwd } = req
    if (this.operations.has(operationId)) {
      this.closePty(operationId)
    }

    const shell = this.resolveShell(req.shell)
    const normalizedCwd = this.resolveCwd(cwd)
    const cols = Math.max(1, Math.min(1000, req.cols || 80))
    const rows = Math.max(1, Math.min(500, req.rows || 24))

    ensureSpawnHelperExecutable()

    let ptyProcess: pty.IPty
    try {
      ptyProcess = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: normalizedCwd,
        env: {
          ...(process.env as Record<string, string>),
          PATH: enrichPath(process.env.PATH || ''),
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
        },
      })
    } catch (err: unknown) {
      this.emitEvent({
        operationId,
        sequence: 1,
        kind: 'error',
        error: String((err as Error)?.message || err),
      })
      throw err
    }

    const op: PtyOperation = {
      operationId,
      sequence: 1,
      ptyProcess,
      terminated: false,
    }
    this.operations.set(operationId, op)

    ptyProcess.onData((data: string) => {
      if (op.terminated) return
      const seq = op.sequence++
      this.emitEvent({
        operationId,
        sequence: seq,
        kind: 'pty-stdout',
        data: Buffer.from(data).toString('base64'),
        encoding: 'base64',
      })
    })

    ptyProcess.onExit(({ exitCode }) => {
      if (op.terminated) return
      op.terminated = true
      const seq = op.sequence++
      this.emitEvent({
        operationId,
        sequence: seq,
        kind: 'done',
        exitCode: exitCode ?? 0,
      })
      this.operations.delete(operationId)
    })
  }

  writePty(operationId: string, dataBase64: string): void {
    const op = this.operations.get(operationId)
    if (!op || op.terminated) {
      throw new Error(`pty operation ${operationId} not found`)
    }
    const data = Buffer.from(dataBase64, 'base64').toString('utf8')
    try {
      op.ptyProcess.write(data)
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EPIPE') {
        // Ignore EPIPE
      }
    }
  }

  resizePty(operationId: string, cols: number, rows: number): void {
    const op = this.operations.get(operationId)
    if (!op || op.terminated) {
      throw new Error(`pty operation ${operationId} not found`)
    }
    const normalizedCols = Math.max(1, Math.min(1000, cols || 80))
    const normalizedRows = Math.max(1, Math.min(500, rows || 24))
    op.ptyProcess.resize(normalizedCols, normalizedRows)
  }

  closePty(operationId: string): void {
    const op = this.operations.get(operationId)
    if (!op || op.terminated) return
    op.terminated = true
    try {
      op.ptyProcess.kill()
    } catch {
      // Ignore kill error
    }
    this.operations.delete(operationId)
  }

  private resolveShell(requested?: string): string {
    if (requested && requested.trim()) {
      return requested.trim()
    }
    if (process.platform === 'win32') {
      return process.env.COMSPEC || 'powershell.exe'
    }
    if (process.env.SHELL && fsSync.existsSync(process.env.SHELL)) {
      return process.env.SHELL
    }
    if (process.platform === 'darwin' && fsSync.existsSync('/bin/zsh')) {
      return '/bin/zsh'
    }
    if (fsSync.existsSync('/bin/bash')) {
      return '/bin/bash'
    }
    return '/bin/sh'
  }

  private resolveCwd(requested?: string): string {
    if (requested && requested.trim()) {
      const resolved = path.resolve(requested.trim())
      if (fsSync.existsSync(resolved)) {
        return resolved
      }
    }
    return os.homedir()
  }

  disposeAll(): void {
    for (const [id, op] of this.operations) {
      if (!op.terminated) {
        op.terminated = true
        try {
          op.ptyProcess.kill()
        } catch {
          // Ignore
        }
      }
    }
    this.operations.clear()
  }
}
