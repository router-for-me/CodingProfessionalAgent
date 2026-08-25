import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { WebSocketServer } from 'ws'
import type { NativeEvent } from '../src/shared/types.js'
import { WebSocketService } from '../src/main/services/websocketService.js'
import { getUserAgent } from '../src/main/utils/version.js'

describe('WebSocketService', () => {
  let service: WebSocketService
  let emittedEvents: NativeEvent[]
  let wss: WebSocketServer
  let port: number

  beforeEach(async () => {
    emittedEvents = []
    service = new WebSocketService((event) => {
      emittedEvents.push(event)
    })

    wss = new WebSocketServer({ port: 0 })
    await new Promise<void>((resolve) => {
      wss.on('listening', () => {
        const addr = wss.address()
        port = typeof addr === 'object' && addr ? addr.port : 0
        resolve()
      })
    })
  })

  afterEach(async () => {
    service.disposeAll()
    await new Promise<void>((resolve) => {
      wss.close(() => resolve())
    })
  })

  it('connects, sends message, receives message, and closes', async () => {
    let receivedUserAgent = ''
    wss.on('connection', (ws, req) => {
      receivedUserAgent = req.headers['user-agent'] || ''
      ws.on('message', (msg) => {
        ws.send(`echo:${msg.toString()}`)
      })
    })

    await service.openWebSocket({
      operationId: 'ws-op-1',
      url: `ws://127.0.0.1:${port}`,
      headers: null,
      connectTimeoutMs: 2000,
    })

    // Wait for open
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (emittedEvents.some((e) => e.kind === 'websocket-open')) {
          clearInterval(interval)
          resolve()
        }
      }, 20)
    })

    await service.sendWebSocket('ws-op-1', 'hello server')

    // Wait for echo message
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (emittedEvents.some((e) => e.kind === 'websocket-text')) {
          clearInterval(interval)
          resolve()
        }
      }, 20)
    })

    const textEvent = emittedEvents.find((e) => e.kind === 'websocket-text')
    expect(textEvent?.data).toBe('echo:hello server')
    expect(receivedUserAgent).toBe(getUserAgent())
    expect(receivedUserAgent).not.toContain('(Electron)')

    service.cancelOperation('ws-op-1')
    expect(emittedEvents.some((e) => e.kind === 'cancelled')).toBe(true)
  })
})
