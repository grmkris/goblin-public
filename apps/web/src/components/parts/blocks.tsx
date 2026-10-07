import { Component, type ReactNode, Suspense, lazy, useSyncExternalStore } from 'react'
import { chartSpec, mapSpec } from '@goblin/kit'
import { Skeleton } from '@goblin/ui'
import type { BlockKind } from '../../lib/fences.ts'

// Each kind loads its library only when a message first shows one.
const Diagram = lazy(() => import('@goblin/kit/diagram').then((module) => ({ default: module.Diagram })))
const Chart = lazy(() => import('@goblin/kit/chart').then((module) => ({ default: module.Chart })))
const MapView = lazy(() => import('@goblin/kit/map').then((module) => ({ default: module.MapView })))

/** If a block fails while drawing, the message shows its code instead; the rest of the transcript is unaffected. */
class Fallback extends Component<{ readonly fallback: ReactNode; readonly children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

const noSubscription = () => () => undefined
/** Blocks draw in the browser only: their libraries touch the DOM and the theme as they load. */
const useInBrowser = () =>
  useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  )

function drawn(kind: BlockKind, source: string, code: ReactNode): ReactNode {
  if (kind === 'mermaid') return <Diagram source={source} fallback={code} />
  if (kind === 'chart') {
    const spec = chartSpec(source)
    return spec === undefined ? code : <Chart spec={spec} />
  }
  const spec = mapSpec(source)
  return spec === undefined ? code : <MapView spec={spec} />
}

/**
 * A ```mermaid, ```chart, or ```map block drawn from its source; `code` shows before hydration
 * and whenever the source is not one it can draw.
 */
export function RichBlock({
  kind,
  source,
  code,
}: {
  readonly kind: BlockKind
  readonly source: string
  readonly code: ReactNode
}) {
  if (!useInBrowser()) return code
  return (
    <Fallback key={`${kind}:${source}`} fallback={code}>
      <Suspense
        fallback={
          <div className="kit-loading">
            <Skeleton className="h-full" />
          </div>
        }
      >
        {drawn(kind, source, code)}
      </Suspense>
    </Fallback>
  )
}
