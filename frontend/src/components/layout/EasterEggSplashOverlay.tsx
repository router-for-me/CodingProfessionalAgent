import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { cn } from '@/lib/cn'

export interface EasterEggSplashOverlayProps {
  open: boolean
  onClose: () => void
}

interface CharInfo {
  id: number
  char: string
  isCPA: boolean
  cpaKey?: 'C' | 'P' | 'A'
  rotateDeg: number
}

const INITIAL_CHARS: CharInfo[] = [
  { id: 0, char: 'C', isCPA: true, cpaKey: 'C', rotateDeg: 0 },
  { id: 1, char: 'L', isCPA: false, rotateDeg: -22 },
  { id: 2, char: 'I', isCPA: false, rotateDeg: 18 },
  { id: 3, char: 'P', isCPA: true, cpaKey: 'P', rotateDeg: 0 },
  { id: 4, char: 'r', isCPA: false, rotateDeg: -30 },
  { id: 5, char: 'o', isCPA: false, rotateDeg: 25 },
  { id: 6, char: 'x', isCPA: false, rotateDeg: -15 },
  { id: 7, char: 'y', isCPA: false, rotateDeg: 32 },
  { id: 8, char: 'A', isCPA: true, cpaKey: 'A', rotateDeg: 0 },
  { id: 9, char: 'P', isCPA: false, rotateDeg: -20 },
  { id: 10, char: 'I', isCPA: false, rotateDeg: 28 },
]

const CPA_SUFFIXES: Record<'C' | 'P' | 'A', string> = {
  C: 'oding',
  P: 'rofessional',
  A: 'gent',
}

type AnimationPhase =
  | 'initial'
  | 'dropping'
  | 'merging'
  | 'merged'
  | 'typing'
  | 'spaced'

function shuffleArray<T>(arr: T[]): T[] {
  const result = [...arr]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const temp = result[i]
    result[i] = result[j]
    result[j] = temp
  }
  return result
}

/**
 * Standalone Easter egg splash overlay with multi-stage animation:
 * 1. Shows "CLIProxyAPI".
 * 2. Non-CPA letters drop and vanish every ~0.7-1s.
 * 3. Remaining "C", "P", "A" letters merge into "CPA".
 * 4. "CPA" expands in random order via typing effect into "CodingProfessionalAgent".
 * 5. Animated transition adds spaces -> "Coding Professional Agent".
 */
export function EasterEggSplashOverlay({
  open,
  onClose,
}: EasterEggSplashOverlayProps) {
  const [closing, setClosing] = useState(false)
  const [phase, setPhase] = useState<AnimationPhase>('initial')
  const [fallingIds, setFallingIds] = useState<Set<number>>(new Set())
  const [droppedIds, setDroppedIds] = useState<Set<number>>(new Set())
  const [typedSuffixes, setTypedSuffixes] = useState<{
    C: string
    P: string
    A: string
  }>({ C: '', P: '', A: '' })

  const timeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([])

  const clearAllTimeouts = () => {
    timeoutsRef.current.forEach((id) => clearTimeout(id))
    timeoutsRef.current = []
  }

  const addTimeout = (callback: () => void, delayMs: number) => {
    const timer = setTimeout(callback, delayMs)
    timeoutsRef.current.push(timer)
    return timer
  }

  useEffect(() => {
    if (!open) {
      clearAllTimeouts()
      setClosing(false)
      setPhase('initial')
      setFallingIds(new Set())
      setDroppedIds(new Set())
      setTypedSuffixes({ C: '', P: '', A: '' })
      return
    }

    clearAllTimeouts()
    setClosing(false)
    setPhase('initial')
    setFallingIds(new Set())
    setDroppedIds(new Set())
    setTypedSuffixes({ C: '', P: '', A: '' })

    // Step 1: Start dropping non-CPA letters in random order
    const nonCpaIds = INITIAL_CHARS.filter((c) => !c.isCPA).map((c) => c.id)
    const dropOrder = shuffleArray(nonCpaIds)

    let currentDelay = 800

    addTimeout(() => {
      setPhase('dropping')
    }, 600)

    dropOrder.forEach((id) => {
      const dropDelay = currentDelay
      addTimeout(() => {
        setFallingIds((prev) => new Set([...prev, id]))
      }, dropDelay)

      addTimeout(() => {
        setDroppedIds((prev) => new Set([...prev, id]))
      }, dropDelay + 550)

      // Random interval between 700ms and 950ms for next drop
      currentDelay += 700 + Math.floor(Math.random() * 250)
    })

    const allDroppedTime = currentDelay + 600

    // Step 2: Smoothly merge C, P, A together into "CPA"
    addTimeout(() => {
      setPhase('merging')
    }, allDroppedTime)

    addTimeout(() => {
      setPhase('merged')
    }, allDroppedTime + 700)

    // Step 3: Type out full words in random order
    const typingStartTime = allDroppedTime + 1250
    addTimeout(() => {
      setPhase('typing')

      const cpaKeys: ('C' | 'P' | 'A')[] = shuffleArray(['C', 'P', 'A'])
      let typeOffset = 0

      cpaKeys.forEach((key) => {
        const fullSuffix = CPA_SUFFIXES[key]
        for (let i = 1; i <= fullSuffix.length; i++) {
          const partial = fullSuffix.slice(0, i)
          typeOffset += 50
          addTimeout(() => {
            setTypedSuffixes((prev) => ({
              ...prev,
              [key]: partial,
            }))
          }, typeOffset)
        }
        typeOffset += 140
      })

      // Step 4: Spacing animation to "Coding Professional Agent"
      addTimeout(() => {
        setPhase('spaced')
      }, typeOffset + 250)
    }, typingStartTime)

    return () => {
      clearAllTimeouts()
    }
  }, [open])

  useEffect(() => {
    if (!open) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        triggerClose()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open])

  if (!open) return null

  const triggerClose = () => {
    setClosing(true)
    clearAllTimeouts()
    setTimeout(() => {
      setClosing(false)
      onClose()
    }, 300)
  }

  const isCollapsed =
    phase === 'merging' ||
    phase === 'merged' ||
    phase === 'typing' ||
    phase === 'spaced'

  const isSpaced = phase === 'spaced'

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Coding Professional Agent Splash Easter Egg"
      data-testid="easter-egg-splash-overlay"
      onClick={triggerClose}
      className={cn(
        'fixed inset-0 z-[99999] flex flex-col items-center justify-center bg-[#06070f] select-none cursor-pointer transition-all duration-300 ease-out',
        closing ? 'opacity-0 scale-105 pointer-events-none' : 'opacity-100 scale-100',
      )}
    >
      <button
        type="button"
        aria-label="Close splash"
        onClick={(e) => {
          e.stopPropagation()
          triggerClose()
        }}
        className="absolute top-4 right-4 z-20 flex size-9 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-white/10 hover:text-white"
      >
        <X className="size-5" />
      </button>

      {/* Ambient glowing background */}
      <div
        className="pointer-events-none absolute h-[280px] w-[560px] rounded-full blur-[56px] animate-pulse"
        style={{
          background:
            'radial-gradient(ellipse at center, rgba(56, 189, 248, 0.18) 0%, rgba(37, 99, 235, 0.1) 45%, transparent 72%)',
        }}
      />

      {/* Main interactive animation stage */}
      <div className="relative z-10 flex flex-col items-center px-6 text-center">
        <h1
          className={cn(
            'm-0 inline-flex items-baseline text-[clamp(22px,3.8vw,36px)] font-bold tracking-tight leading-tight transition-all duration-500 select-none',
            isSpaced
              ? 'text-transparent bg-clip-text animate-[splash-shimmer_3s_ease-in-out_infinite]'
              : 'text-white',
          )}
          style={{
            fontFamily:
              'Inter, "PingFang SC", "Microsoft YaHei", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif',
            backgroundImage: isSpaced
              ? 'linear-gradient(115deg, #94a3b8 0%, #cbd5e1 20%, #ffffff 40%, #38bdf8 60%, #60a5fa 80%, #94a3b8 100%)'
              : undefined,
            backgroundSize: isSpaced ? '250% 100%' : undefined,
            WebkitBackgroundClip: isSpaced ? 'text' : undefined,
            WebkitTextFillColor: isSpaced ? 'transparent' : undefined,
            textShadow: isSpaced
              ? '0 0 32px rgba(56, 189, 248, 0.25)'
              : '0 0 20px rgba(56, 189, 248, 0.15)',
          }}
        >
          {INITIAL_CHARS.map((item) => {
            if (!item.isCPA) {
              const isFalling = fallingIds.has(item.id)
              const isDropped = droppedIds.has(item.id)

              return (
                <span
                  key={item.id}
                  data-testid={`char-${item.char}-${item.id}`}
                  className={cn(
                    'inline-block overflow-hidden whitespace-nowrap align-baseline transition-all',
                    isCollapsed
                      ? 'max-w-0 opacity-0 duration-700 ease-[cubic-bezier(0.16,1,0.3,1)] pointer-events-none'
                      : isFalling
                        ? 'max-w-[1.2em] duration-600 ease-in pointer-events-none'
                        : 'max-w-[1.2em] duration-200 opacity-100',
                  )}
                  style={{
                    transform:
                      isFalling || isDropped
                        ? `translateY(160px) rotate(${item.rotateDeg}deg)`
                        : 'translateY(0) rotate(0deg)',
                    opacity: isFalling || isDropped ? 0 : 1,
                  }}
                >
                  {item.char}
                </span>
              )
            }

            // CPA anchor character
            const cpaKey = item.cpaKey!
            const typed = typedSuffixes[cpaKey]
            const isJustMerged = phase === 'merged'

            return (
              <span
                key={item.id}
                data-testid={`cpa-segment-${cpaKey}`}
                className={cn(
                  'inline transition-all duration-500 ease-out',
                  isSpaced && cpaKey !== 'A' ? 'mr-[0.35em]' : 'mr-0',
                )}
              >
                <span
                  className={cn(
                    'inline-block transition-all duration-300 ease-out',
                    isJustMerged &&
                      'scale-115 text-sky-200 drop-shadow-[0_0_16px_rgba(56,189,248,0.75)]',
                  )}
                >
                  {item.char}
                </span>
                {typed ? <span>{typed}</span> : null}
              </span>
            )
          })}
        </h1>
      </div>
    </div>,
    document.body,
  )
}
