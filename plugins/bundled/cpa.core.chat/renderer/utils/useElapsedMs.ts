import { useEffect, useState } from 'react'

/** Live millisecond clock while `running`; frozen `completedAt - startedAt - pausedMs` otherwise. */
export function useElapsedMs(
  startedAt: number,
  completedAt: number | undefined,
  running: boolean,
  pausedMs = 0,
): number {
  const [, setTick] = useState(0)

  useEffect(() => {
    if (!running) return
    const tick = window.setInterval(() => {
      setTick((t) => t + 1)
    }, 1000)
    return () => window.clearInterval(tick)
  }, [running])

  const safePausedMs =
    typeof pausedMs === 'number' && Number.isFinite(pausedMs) && pausedMs > 0
      ? pausedMs
      : 0

  if (running) return Math.max(0, Date.now() - startedAt - safePausedMs)
  if (typeof completedAt !== 'number') return 0
  return Math.max(0, completedAt - startedAt - safePausedMs)
}
