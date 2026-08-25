import { describe, expect, it } from 'vitest'
import { MockAgentService } from './MockAgentService'
import type { Message } from '@/types/models'

const baseMessage: Message = {
  id: 'm1',
  sessionId: 's',
  role: 'user',
  content: 'hello world',
  createdAt: 1,
}

describe('MockAgentService', () => {
  it('yields text-delta then message-end', async () => {
    const svc = new MockAgentService({
      initialDelayMs: 0,
      chunkDelayMs: 0,
      toolDelayMs: 0,
    })
    const events: string[] = []
    for await (const ev of svc.streamChat({
      sessionId: 's',
      messages: [baseMessage],
      modelId: 'cpa-mock-pro',
      requestApproval: false,
    })) {
      events.push(ev.type)
    }
    expect(events).toContain('text-delta')
    expect(events[0]).toBe('tool-start')
    expect(events).toContain('tool-result')
    expect(events[events.length - 1]).toBe('message-end')
  })

  it('emits approval when requested', async () => {
    const svc = new MockAgentService({
      initialDelayMs: 0,
      chunkDelayMs: 0,
      toolDelayMs: 0,
    })
    const events: string[] = []

    await (async () => {
      for await (const ev of svc.streamChat({
        sessionId: 's',
        messages: [baseMessage],
        modelId: 'cpa-mock-pro',
        requestApproval: true,
      })) {
        events.push(ev.type)
        if (ev.type === 'tool-approval-required') {
          queueMicrotask(() => {
            svc.approveTool(ev.id)
          })
        }
      }
    })()

    expect(events).toContain('tool-start')
    expect(events).toContain('tool-approval-required')
    expect(events).toContain('tool-result')
    expect(events).toContain('text-delta')
    expect(events[events.length - 1]).toBe('message-end')
  })

  it('stops on abort', async () => {
    const svc = new MockAgentService({
      initialDelayMs: 0,
      chunkDelayMs: 30,
      toolDelayMs: 0,
    })
    const ac = new AbortController()
    const events: string[] = []

    await expect(
      (async () => {
        for await (const ev of svc.streamChat({
          sessionId: 's',
          messages: [baseMessage],
          modelId: 'cpa-mock-pro',
          requestApproval: false,
          signal: ac.signal,
        })) {
          events.push(ev.type)
          if (ev.type === 'text-delta') {
            ac.abort()
          }
        }
      })(),
    ).resolves.toBeUndefined()

    expect(events.length).toBeGreaterThan(0)
    expect(events[events.length - 1]).not.toBe('message-end')
  })

  it('rejects tool and still ends gently', async () => {
    const svc = new MockAgentService({
      initialDelayMs: 0,
      chunkDelayMs: 0,
      toolDelayMs: 0,
    })
    const events: string[] = []

    await (async () => {
      for await (const ev of svc.streamChat({
        sessionId: 's',
        messages: [baseMessage],
        modelId: 'cpa-mock-pro',
        requestApproval: true,
      })) {
        events.push(ev.type)
        if (ev.type === 'tool-approval-required') {
          queueMicrotask(() => {
            svc.rejectTool(ev.id)
          })
        }
      }
    })()

    expect(events).toContain('tool-approval-required')
    expect(events).not.toContain('tool-result')
    expect(events).toContain('text-delta')
    expect(events[events.length - 1]).toBe('message-end')
  })
})
