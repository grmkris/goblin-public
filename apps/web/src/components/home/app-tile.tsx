import { useEffect, useRef, useState } from 'react'
import type { AppView } from '@goblin/contracts'
import { Button, Receipt } from '@goblin/ui'
import { failureText } from '../../lib/boundary.ts'
import { appKey } from '../../lib/workspace.ts'
import { useWorkspace } from '../workspace.tsx'
import { useWorkspaceFeed } from '../workspace-feed.tsx'
import { useAppHost } from '../apps/host.tsx'
import { useAppPlacement } from '../apps/placement.ts'
import { useSlot } from '../apps/slot.tsx'

/** Only a nearby tile launches a frame; dormant and explicitly closed Apps wait for Show. */
function useNearTile() {
  const element = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(false)
  useEffect(() => {
    if (element.current === null) return
    const observer = new IntersectionObserver(([entry]) => setNear(entry?.isIntersecting ?? false), {
      rootMargin: `${window.innerHeight}px 0px`,
    })
    observer.observe(element.current)
    return () => observer.disconnect()
  }, [])
  return { element, near }
}

export function HomeAppTile({ app }: { readonly app: AppView }) {
  const host = useAppHost()
  const feed = useWorkspaceFeed()
  const workspace = useWorkspace()
  const place = useAppPlacement(app)
  const register = useSlot(`app-home:${app.id}`)
  const { element, near } = useNearTile()
  const [revealError, setRevealError] = useState('')
  const problem = host.problems.get(app.id) ?? (revealError || undefined)
  const loaded = host.instances.has(app.id)
  const closed = app.closedAt !== undefined
  const asleep = host.dormant.has(app.id) || problem !== undefined
  const { show } = host
  useEffect(() => {
    if (near && !closed && !asleep && !place.paged) show(app)
  }, [near, closed, asleep, place.paged, app, show])
  const reveal = async () => {
    setRevealError('')
    try {
      const opened = !closed
        ? app
        : app.source.kind === 'mcp'
          ? await feed.keepApp(app.conversation, app.source.callId)
          : await feed.reopenApp(app.id)
      show(opened)
    } catch (cause) {
      setRevealError(failureText(cause))
    }
  }
  let stub
  if (place.paged)
    stub = (
      <div className="home-app-stub">
        <span>Open as a page</span>
        <Button variant="ghost" size="sm" onClick={() => workspace.focus(appKey(app.id))}>
          Go to it
        </Button>
        <Button variant="ghost" size="sm" onClick={place.inline}>
          Back on Home
        </Button>
      </div>
    )
  else if (!loaded) stub = <Unloaded app={app} closed={closed} asleep={asleep} problem={problem} reveal={reveal} />
  return (
    <div className="home-app" ref={element}>
      <div className="home-app-slot" ref={register} />
      {stub}
    </div>
  )
}

function Unloaded({
  app,
  closed,
  asleep,
  problem,
  reveal,
}: {
  readonly app: AppView
  readonly closed: boolean
  readonly asleep: boolean
  readonly problem: string | undefined
  readonly reveal: () => Promise<void>
}) {
  const message = closed ? 'Closed' : asleep ? 'Unloaded to save memory' : 'Ready when in view'
  return (
    <div className="home-app-stub">
      {problem === undefined ? <span>{message}</span> : <Receipt tone="error">{problem}</Receipt>}
      <Button variant="ghost" size="sm" onClick={() => void reveal()}>
        {problem === undefined ? 'Show' : 'Retry'}
      </Button>
      <span className="home-freshness">Kept {new Date(app.createdAt * 1000).toLocaleDateString()}</span>
    </div>
  )
}
