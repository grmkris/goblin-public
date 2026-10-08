// The agent's presence: the one living element on screen. A small orb of moving colour (Paper Shaders' MeshGradient)
// whose pace follows what the agent does, and a pulsing border for when it waits on the owner. Colours come from the
// theme's --presence-* tokens, resolved to rgb at runtime (the shaders do not read OKLCH). Under reduced motion, in a
// hidden tab, before hydration, without WebGL, or where its caller says it is not `active`, the orb is a still gradient
// with no WebGL context of its own: the app keeps one moving orb, in the pane the owner is looking at.
import { lazy, Suspense, useEffect, useState } from 'react'
import { cva } from 'class-variance-authority'
import { cn } from '../lib/cn'

type PresenceState =
  | 'idle'
  | 'thinking'
  | 'responding'
  | 'tool'
  | 'waiting'
  | 'retrying'
  | 'error'
  | 'offline'
  | 'exhausted'

const MeshGradient = lazy(() =>
  import('@paper-design/shaders-react').then((module) => ({ default: module.MeshGradient })),
)
const PulsingBorder = lazy(() =>
  import('@paper-design/shaders-react').then((module) => ({ default: module.PulsingBorder })),
)

/** Pace and colours per state: busier work moves faster; waiting and failing stand still in other colours. */
const MOTION: Record<
  PresenceState,
  { readonly speed: number; readonly distortion: number; readonly swirl: number; readonly tokens: readonly string[] }
> = {
  idle: {
    speed: 0.12,
    distortion: 0.6,
    swirl: 0.2,
    tokens: ['--presence-1', '--presence-2', '--presence-3', '--presence-4'],
  },
  thinking: {
    speed: 0.45,
    distortion: 0.9,
    swirl: 0.6,
    tokens: ['--presence-2', '--presence-1', '--presence-4', '--presence-3'],
  },
  responding: {
    speed: 0.6,
    distortion: 0.8,
    swirl: 0.4,
    tokens: ['--presence-1', '--presence-3', '--presence-4', '--presence-2'],
  },
  tool: {
    speed: 0.9,
    distortion: 1,
    swirl: 0.8,
    tokens: ['--presence-3', '--presence-1', '--presence-2', '--presence-4'],
  },
  waiting: { speed: 0, distortion: 0.6, swirl: 0.3, tokens: ['--presence-warm', '--presence-4', '--presence-2'] },
  retrying: { speed: 0.2, distortion: 0.7, swirl: 0.3, tokens: ['--presence-warm', '--presence-1', '--presence-4'] },
  error: { speed: 0, distortion: 0.5, swirl: 0.2, tokens: ['--destructive', '--presence-4', '--muted'] },
  offline: { speed: 0, distortion: 0.4, swirl: 0.1, tokens: ['--muted-foreground', '--muted', '--border'] },
  exhausted: { speed: 0, distortion: 0.4, swirl: 0.1, tokens: ['--muted-foreground', '--presence-4', '--muted'] },
}

/** Resolve theme colour tokens to `rgb()` strings through a 1×1 canvas, which understands every CSS colour form. */
function resolveColors(element: Element, tokens: readonly string[]): string[] {
  const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  if (context === null) return []
  const style = getComputedStyle(element)
  return tokens.map((token) => {
    context.clearRect(0, 0, 1, 1)
    context.fillStyle = style.getPropertyValue(token).trim() || 'transparent'
    context.fillRect(0, 0, 1, 1)
    const [red = 0, green = 0, blue = 0] = context.getImageData(0, 0, 1, 1).data
    return `rgb(${red}, ${green}, ${blue})`
  })
}

/** The theme's colours for `tokens`, re-read when light and dark switch; empty until mounted in a browser. */
function useThemeColors(tokens: readonly string[]): string[] {
  const key = tokens.join(' ')
  const [colors, setColors] = useState<string[]>([])
  useEffect(() => {
    const read = () => setColors(resolveColors(document.documentElement, key.split(' ')))
    read()
    const observer = new MutationObserver(read)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] })
    return () => observer.disconnect()
  }, [key])
  return colors
}

/** Whether things may move: not under reduced motion, and not while the tab is hidden. */
function useMayMove(): boolean {
  const [may, setMay] = useState(false)
  useEffect(() => {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setMay(!reduce.matches && document.visibilityState === 'visible')
    update()
    reduce.addEventListener('change', update)
    document.addEventListener('visibilitychange', update)
    return () => {
      reduce.removeEventListener('change', update)
      document.removeEventListener('visibilitychange', update)
    }
  }, [])
  return may
}

const orbVariants = cva(
  'relative block size-5 shrink-0 overflow-hidden rounded-full bg-[radial-gradient(circle_at_35%_30%,var(--presence-4),var(--presence-1)_55%,var(--presence-2))] shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--foreground)_10%,transparent)]',
  {
    variants: {
      state: {
        idle: '',
        thinking: '',
        responding: '',
        tool: '',
        waiting: 'bg-[radial-gradient(circle_at_35%_30%,var(--presence-4),var(--presence-warm)_60%)]',
        retrying: 'bg-[radial-gradient(circle_at_35%_30%,var(--presence-4),var(--presence-warm)_60%)]',
        error: 'bg-[radial-gradient(circle_at_35%_30%,var(--muted),var(--destructive)_70%)]',
        offline: 'bg-muted-foreground/40',
        exhausted: 'bg-muted-foreground/40',
      },
    },
  },
)

/**
 * The orb. `label` names the state for screen readers; the visible label sits beside it. `active` false keeps it a
 * still gradient: each moving orb is a WebGL context and frames every second, so only the focused pane's moves.
 */
function PresenceOrb({
  state,
  label,
  active = true,
  className,
}: {
  readonly state: PresenceState
  readonly label: string
  readonly active?: boolean
  readonly className?: string
}) {
  const motion = MOTION[state]
  const colors = useThemeColors(motion.tokens)
  const mayMove = useMayMove()
  return (
    <span
      data-slot="presence-orb"
      data-state={state}
      role="img"
      aria-label={label}
      className={cn(orbVariants({ state }), className)}
    >
      {active && colors.length > 0 && (
        <Suspense fallback={null}>
          <MeshGradient
            className="absolute inset-0"
            colors={colors}
            distortion={motion.distortion}
            swirl={motion.swirl}
            speed={mayMove ? motion.speed : 0}
            maxPixelCount={4096}
          />
        </Suspense>
      )}
    </span>
  )
}

/** A soft, pulsing frame around the composer while the agent waits on the owner; nothing under reduced motion. */
function PresenceBorder({ className }: { readonly className?: string }) {
  const colors = useThemeColors(['--presence-warm', '--presence-2', '--presence-1'])
  const mayMove = useMayMove()
  if (!mayMove || colors.length === 0) return null
  return (
    <Suspense fallback={null}>
      <PulsingBorder
        data-slot="presence-border"
        aria-hidden
        className={cn('pointer-events-none absolute -inset-2.5 rounded-[1.625rem]', className)}
        colors={colors}
        colorBack="rgba(0, 0, 0, 0)"
        scale={1}
        roundness={0.45}
        thickness={0.12}
        softness={0.8}
        intensity={0.3}
        bloom={0.3}
        spots={3}
        spotSize={0.4}
        pulse={0.3}
        smoke={0}
        speed={0.6}
        maxPixelCount={400_000}
      />
    </Suspense>
  )
}

export { PresenceBorder, PresenceOrb, type PresenceState }
