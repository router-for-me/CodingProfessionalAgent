/**
 * Format a millisecond duration for turn headers and timers.
 * Always precise to seconds, preserving seconds and minutes even when scaled up to hours, days, months, or years.
 */
export function formatElapsed(ms: number, _locale?: string): string {
  const totalSec = Math.floor(Math.max(0, ms) / 1000)
  const seconds = totalSec % 60
  const totalMinutes = Math.floor(totalSec / 60)
  const minutes = totalMinutes % 60
  const totalHours = Math.floor(totalMinutes / 60)
  const hours = totalHours % 24
  const totalDays = Math.floor(totalHours / 24)

  // Standard duration approximation: 1 year = 365 days, 1 month = 30 days
  const years = Math.floor(totalDays / 365)
  const remDays = totalDays % 365
  const months = Math.floor(remDays / 30)
  const days = remDays % 30

  const parts: string[] = []

  if (years > 0) {
    parts.push(`${years}y`)
  }
  if (months > 0) {
    parts.push(`${months}mo`)
  }
  if (days > 0) {
    parts.push(`${days}d`)
  }
  if (hours > 0 || parts.length > 0) {
    parts.push(`${hours}h`)
  }
  if (minutes > 0 || parts.length > 0) {
    parts.push(`${minutes}m`)
  }
  parts.push(`${seconds}s`)

  return parts.join(' ')
}
