import { useEffect, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { useUiStore } from '@/stores/uiStore'
import { EasterEggSplashOverlay } from './EasterEggSplashOverlay'
import { SidebarToggle } from './SidebarToggle'
import { TitlebarChrome } from './TitlebarChrome'

interface BrandSegment {
  letter: string
  rest: string
  hasTrailingSpace: boolean
}

const BRAND_SEGMENTS: BrandSegment[] = [
  { letter: 'C', rest: 'oding', hasTrailingSpace: true },
  { letter: 'P', rest: 'rofessional', hasTrailingSpace: true },
  { letter: 'A', rest: 'gent', hasTrailingSpace: false },
]

/**
 * Sidebar chrome + brand strip.
 * Top row aligns the collapse control with macOS traffic lights.
 * Second row keeps brand / search controls.
 */
export function TitleBar() {
  const { t } = useTranslation()
  const [easterEggOpen, setEasterEggOpen] = useState(false)
  const [clickStep, setClickStep] = useState<number>(0)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
    }
  }, [])

  const handleSegmentClick = (letter: string) => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
    }

    // Reset sequence after 5 seconds of inactivity
    timeoutRef.current = setTimeout(() => {
      setClickStep(0)
    }, 5000)

    if (letter === 'C') {
      setClickStep(1)
    } else if (letter === 'P' && clickStep === 1) {
      setClickStep(2)
    } else if (letter === 'A' && clickStep === 2) {
      setClickStep(0)
      setEasterEggOpen(true)
    } else {
      setClickStep(0)
    }
  }

  return (
    <div className="shrink-0">
      <TitlebarChrome>
        <SidebarToggle />
      </TitlebarChrome>

      <div className="flex h-10 items-center gap-1 px-2.5">
        <div
          className="flex min-w-0 flex-1 items-center overflow-hidden text-sm font-semibold text-[var(--text-primary)] select-none"
          title="Coding Professional Agent"
          aria-label="Coding Professional Agent"
        >
          {BRAND_SEGMENTS.map((segment) => (
            <button
              key={segment.letter}
              type="button"
              onClick={() => handleSegmentClick(segment.letter)}
              className="group inline-flex items-baseline cursor-default border-none bg-transparent p-0 text-inherit font-inherit outline-none focus:outline-none"
            >
              <span>{segment.letter}</span>
              <span
                className={cn(
                  'inline-block max-w-0 overflow-hidden whitespace-nowrap opacity-0 transition-all duration-150 ease-out group-hover:max-w-36 group-hover:opacity-100',
                  segment.hasTrailingSpace
                    ? 'group-hover:pr-1'
                    : 'group-hover:pr-0',
                )}
              >
                {segment.rest}
              </span>
            </button>
          ))}
        </div>

        <button
          type="button"
          aria-label={t('nav.search')}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]"
          onClick={() => useUiStore.getState().setSearchOpen(true)}
        >
          <Search className="size-3.5" />
        </button>
      </div>

      <EasterEggSplashOverlay
        open={easterEggOpen}
        onClose={() => setEasterEggOpen(false)}
      />
    </div>
  )
}
