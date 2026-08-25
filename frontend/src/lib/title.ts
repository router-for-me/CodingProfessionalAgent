import type { Locale } from '@/types/models'

const MAX = 40

export function deriveSessionTitle(content: string, _locale: Locale): string {
  const trimmed = content.trim().replace(/\s+/g, ' ')
  if (!trimmed) {
    return 'New chat'
  }
  if (trimmed.length <= MAX) return trimmed
  return `${trimmed.slice(0, MAX - 1)}…`
}
