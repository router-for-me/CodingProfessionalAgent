import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { isBrowserEnvironment, isWindowsPlatform } from '@/lib/platform'

interface TitlebarChromeProps {
  children: ReactNode
  className?: string
}

/**
 * Window title-bar strip that clears macOS traffic lights in Electron desktop window
 * and vertically centers toolbar controls with them.
 * In browser mode or on Windows, native traffic lights do not exist, so controls align cleanly to the left.
 *
 * Layout (Electron macOS): [ traffic-light spacer | controls | drag fill ]
 * Layout (Browser / Windows):  [ controls | drag fill ]
 */
export function TitlebarChrome({ children, className }: TitlebarChromeProps) {
  const isWebLayout = isBrowserEnvironment() || isWindowsPlatform()

  if (isWebLayout) {
    return (
      <div
        data-drag-region
        className={cn(
          'flex h-[var(--titlebar-height)] shrink-0 items-center px-2.5',
          className,
        )}
      >
        <div className="flex -translate-y-px items-center">
          {children}
        </div>
      </div>
    )
  }

  return (
    <div
      data-drag-region
      className={cn(
        'grid h-[var(--titlebar-height)] shrink-0 items-center pr-2',
        className,
      )}
      style={{
        gridTemplateColumns: 'var(--traffic-lights-pad) auto minmax(0, 1fr)',
      }}
    >
      {/* Reserved for native traffic lights — must stay empty / non-interactive. */}
      <div aria-hidden className="h-full" data-drag-region />
      {/* Nudge 1px up to optically match native traffic-light center. */}
      <div className="flex -translate-y-px items-center justify-center">
        {children}
      </div>
      <div className="h-full min-w-0" data-drag-region />
    </div>
  )
}
