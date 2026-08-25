import type { ConversationEntry } from '@/features/agent-runtime/session/types'
import { syncFileChangesFromEntries, useFileChangeStore } from '@/stores/fileChangeStore'

export type MessageApplicationEvent =
  | {
      type: 'entries-updated'
      sessionId: string
      entries: readonly ConversationEntry[]
      skipExpensiveProjections?: boolean
    }
  | {
      type: 'session-cleared'
      sessionId: string
    }
  | {
      type: 'session-evicted'
      sessionId: string
    }

type MessageEventListener = (event: MessageApplicationEvent) => void

const listeners = new Set<MessageEventListener>()

export function subscribeMessageEvents(listener: MessageEventListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function emitMessageEvent(event: MessageApplicationEvent): void {
  for (const listener of listeners) {
    try {
      listener(event)
    } catch (err) {
      console.error('Error in message event listener:', err)
    }
  }
}

// Auto-wire built-in projections subscriber so FileChange projections update seamlessly
subscribeMessageEvents((event) => {
  if (event.type === 'entries-updated') {
    if (!event.skipExpensiveProjections) {
      syncFileChangesFromEntries(event.sessionId, event.entries)
    }
  } else if (event.type === 'session-cleared' || event.type === 'session-evicted') {
    useFileChangeStore.getState().clearSessionChanges(event.sessionId)
  }
})
