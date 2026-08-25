import { createId } from '@/lib/id'
import type { Locale, Message } from '@/types/models'
import {
  getMockReplyTemplate,
  getQuickActionPrompt,
  type QuickActionKind,
} from './templates'
import type { AgentEvent, StreamChatInput, ToolDecision } from './types'

export interface MockAgentServiceOptions {
  initialDelayMs?: number
  chunkDelayMs?: number
  toolDelayMs?: number
  chunkSize?: number
}

type ApprovalWaiter = {
  resolve: (decision: ToolDecision) => void
  reject: (error: Error) => void
}

const DEFAULT_OPTIONS: Required<MockAgentServiceOptions> = {
  initialDelayMs: 250,
  chunkDelayMs: 16,
  toolDelayMs: 180,
  chunkSize: 3,
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  )
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error('Aborted')
    error.name = 'AbortError'
    throw error
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    throwIfAborted(signal)
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const error = new Error('Aborted')
      error.name = 'AbortError'
      reject(error)
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      const error = new Error('Aborted')
      error.name = 'AbortError'
      reject(error)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function chunkText(text: string, size: number): string[] {
  if (!text) return ['']
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size))
  }
  return chunks
}

function lastUserText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') return messages[i].content
  }
  return ''
}

function detectKind(
  messages: Message[],
  locale: Locale,
  override?: QuickActionKind | 'general',
): QuickActionKind | 'general' {
  if (override) return override
  const text = lastUserText(messages)
  if (!text) return 'general'
  const kinds: QuickActionKind[] = ['explore', 'build', 'review', 'fix']
  for (const kind of kinds) {
    if (text === getQuickActionPrompt(kind, locale)) return kind
    // Fallback: match either locale prompt.
    if (
      text === getQuickActionPrompt(kind, 'zh-CN') ||
      text === getQuickActionPrompt(kind, 'en')
    ) {
      return kind
    }
  }
  return 'general'
}

/**
 * In-memory mock agent that emits streaming AgentEvents.
 * Tests / stories only — never import from production providers or hooks.
 * No real LLM / network — tools are display-only animations.
 */
export class MockAgentService {
  private readonly options: Required<MockAgentServiceOptions>
  private readonly pending = new Map<string, ApprovalWaiter>()

  constructor(options?: MockAgentServiceOptions) {
    this.options = { ...DEFAULT_OPTIONS, ...options }
  }

  approveTool(toolId: string): void {
    const waiter = this.pending.get(toolId)
    if (!waiter) return
    this.pending.delete(toolId)
    waiter.resolve('approved')
  }

  rejectTool(toolId: string): void {
    const waiter = this.pending.get(toolId)
    if (!waiter) return
    this.pending.delete(toolId)
    waiter.resolve('rejected')
  }

  async *streamChat(input: StreamChatInput): AsyncGenerator<AgentEvent> {
    try {
      await delay(this.options.initialDelayMs, input.signal)

      const locale = input.locale ?? 'zh-CN'
      const kind = detectKind(input.messages, locale, input.kind)
      const full = getMockReplyTemplate(kind, locale)

      const toolId = createId()
      const toolName = 'read_file'
      const toolArgs = { path: 'src/main.ts' }

      yield {
        type: 'tool-start',
        id: toolId,
        name: toolName,
        args: toolArgs,
      }

      if (input.requestApproval) {
        yield { type: 'tool-approval-required', id: toolId }
        const decision = await this.waitForDecision(toolId, input.signal)
        if (decision === 'rejected') {
          const mild = 'Skipped that tool call. Continuing from the current context.\n\n'
          for (const chunk of chunkText(mild + full.slice(0, 120), this.options.chunkSize)) {
            throwIfAborted(input.signal)
            yield { type: 'text-delta', text: chunk }
            await delay(this.options.chunkDelayMs, input.signal)
          }
          yield { type: 'message-end' }
          return
        }
      } else {
        await delay(this.options.toolDelayMs, input.signal)
      }

      yield {
        type: 'tool-result',
        id: toolId,
        result:
          locale === 'zh-CN'
            ? '// mock: src/main.ts\nexport function bootstrap() {\n  // ...\n}\n'
            : '// mock: src/main.ts\nexport function bootstrap() {\n  // ...\n}\n',
      }

      for (const chunk of chunkText(full, this.options.chunkSize)) {
        throwIfAborted(input.signal)
        yield { type: 'text-delta', text: chunk }
        await delay(this.options.chunkDelayMs, input.signal)
      }

      yield { type: 'message-end' }
    } catch (error) {
      if (isAbortError(error)) {
        return
      }
      const message =
        error instanceof Error ? error.message : 'Unknown agent error'
      yield { type: 'error', message }
    } finally {
      // Drop any stranded approval waiters for this stream.
      for (const [id, waiter] of this.pending) {
        this.pending.delete(id)
        waiter.reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
      }
    }
  }

  private waitForDecision(
    toolId: string,
    signal?: AbortSignal,
  ): Promise<ToolDecision> {
    return new Promise<ToolDecision>((resolve, reject) => {
      if (signal?.aborted) {
        const error = new Error('Aborted')
        error.name = 'AbortError'
        reject(error)
        return
      }

      const onAbort = () => {
        this.pending.delete(toolId)
        signal?.removeEventListener('abort', onAbort)
        const error = new Error('Aborted')
        error.name = 'AbortError'
        reject(error)
      }

      this.pending.set(toolId, {
        resolve: (decision) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(decision)
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort)
          reject(error)
        },
      })

      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
}
