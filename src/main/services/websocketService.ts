import { WebSocket } from 'ws'
import type { NativeEvent, WebSocketOpenRequest } from '../../shared/types.js'
import type { EventEmitter } from './processService.js'
import { getUserAgent } from '../utils/version.js'

interface WebSocketOperation {
  operationId: string
  sequence: number
  ws: WebSocket
  terminated: boolean
  connectTimer?: NodeJS.Timeout
}

export class WebSocketService {
  private readonly operations = new Map<string, WebSocketOperation>()

  constructor(private readonly emitEvent: EventEmitter) {}

  async openWebSocket(req: WebSocketOpenRequest): Promise<void> {
    const { operationId, url, headers, connectTimeoutMs } = req
    if (!url) {
      throw new Error('websocket url is required')
    }

    if (this.operations.has(operationId)) {
      throw new Error(`operation ${operationId} already exists`)
    }

    const ws = new WebSocket(url, {
      headers: {
        'User-Agent': getUserAgent(),
        ...(headers || {}),
      },
    })

    const op: WebSocketOperation = {
      operationId,
      sequence: 1,
      ws,
      terminated: false,
    }
    this.operations.set(operationId, op)

    if (connectTimeoutMs > 0) {
      op.connectTimer = setTimeout(() => {
        if (!op.terminated && ws.readyState === WebSocket.CONNECTING) {
          op.terminated = true
          try {
            ws.terminate()
          } catch {
            // Ignore
          }
          const seq = op.sequence++
          this.emitEvent({
            operationId,
            sequence: seq,
            kind: 'error',
            error: `websocket dial: connect timeout after ${connectTimeoutMs}ms`,
          })
          this.operations.delete(operationId)
        }
      }, connectTimeoutMs)
    }

    ws.on('open', () => {
      if (op.connectTimer) {
        clearTimeout(op.connectTimer)
        op.connectTimer = undefined
      }
      if (op.terminated) return
      const seq = op.sequence++
      this.emitEvent({
        operationId,
        sequence: seq,
        kind: 'websocket-open',
      })
    })

    ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      if (op.terminated) return
      const seq = op.sequence++
      if (isBinary) {
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
        this.emitEvent({
          operationId,
          sequence: seq,
          kind: 'websocket-binary',
          data: buffer.toString('base64'),
          encoding: 'base64',
        })
      } else {
        const text = data.toString('utf8')
        this.emitEvent({
          operationId,
          sequence: seq,
          kind: 'websocket-text',
          data: text,
          encoding: 'utf8',
        })
      }
    })

    ws.on('error', (err: Error) => {
      if (op.connectTimer) {
        clearTimeout(op.connectTimer)
        op.connectTimer = undefined
      }
      if (op.terminated) return
      op.terminated = true
      const seq = op.sequence++
      this.emitEvent({
        operationId,
        sequence: seq,
        kind: 'error',
        error: `websocket error: ${err.message}`,
      })
      this.operations.delete(operationId)
    })

    ws.on('close', (code: number, reason: Buffer) => {
      if (op.connectTimer) {
        clearTimeout(op.connectTimer)
        op.connectTimer = undefined
      }
      if (op.terminated) return
      op.terminated = true
      const seq = op.sequence++
      this.emitEvent({
        operationId,
        sequence: seq,
        kind: 'done',
        closeCode: code,
        reason: reason.toString('utf8'),
      })
      this.operations.delete(operationId)
    })
  }

  async sendWebSocket(operationId: string, payload: string): Promise<void> {
    const op = this.operations.get(operationId)
    if (!op || op.terminated || op.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`websocket operation ${operationId} is not connected`)
    }

    return new Promise<void>((resolve, reject) => {
      op.ws.send(payload, (err) => {
        if (err) {
          reject(err)
        } else {
          resolve()
        }
      })
    })
  }

  cancelOperation(operationId: string): void {
    const op = this.operations.get(operationId)
    if (!op || op.terminated) return
    op.terminated = true
    if (op.connectTimer) {
      clearTimeout(op.connectTimer)
      op.connectTimer = undefined
    }

    try {
      op.ws.terminate()
    } catch {
      // Ignore
    }

    const seq = op.sequence++
    this.emitEvent({
      operationId,
      sequence: seq,
      kind: 'cancelled',
    })
    this.operations.delete(operationId)
  }

  disposeAll(): void {
    for (const [id, op] of this.operations) {
      if (!op.terminated) {
        op.terminated = true
        if (op.connectTimer) {
          clearTimeout(op.connectTimer)
        }
        try {
          op.ws.terminate()
        } catch {
          // Ignore
        }
      }
    }
    this.operations.clear()
  }
}
