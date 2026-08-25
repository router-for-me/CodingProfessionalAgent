import {
  Atom,
  Brain,
  Flame,
  Flower2,
  Hexagon,
  Orbit,
  Sparkle,
  Sun,
  cn,
} from '@cpa/plugin-ui'
import type { SubAgentIconId } from '@cpa/plugin-api'

const ICONS: Record<SubAgentIconId, typeof Sparkle> = {
  sparkle: Sparkle,
  atom: Atom,
  flower: Flower2,
  sun: Sun,
  hexagon: Hexagon,
  orbit: Orbit,
  flame: Flame,
  brain: Brain,
}

export function SubAgentAvatar({
  icon,
  color,
  size = 18,
  className,
}: {
  icon: SubAgentIconId
  color: string
  size?: number
  className?: string
}) {
  const Icon = ICONS[icon] ?? Sparkle
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full',
        className,
      )}
      style={{
        width: size,
        height: size,
        backgroundColor: `${color}22`,
        color,
      }}
      aria-hidden
    >
      <Icon size={Math.max(10, Math.round(size * 0.62))} strokeWidth={2.2} />
    </span>
  )
}
