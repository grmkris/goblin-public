// Places an App's stage can follow. In its transcript, the App's tool row holds a slot as tall as the App asked, and
// loads the App when it comes on screen; while the App is a page the row says so, with the way there and back; an App
// unloaded to stay under the cap leaves a stub that shows it again. The App's page (page.tsx) is a slot filling its pane.
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type { AppView } from '@goblin/contracts'
import { AppWindowIcon } from 'lucide-react'
import { Button } from '@goblin/ui'
import { CHROME_HEIGHT } from '../../lib/app-stage.ts'
import { inlineHeight } from '../../lib/host-context.ts'
import { appKey, isOpen } from '../../lib/workspace.ts'
import { useOnScreen } from '../on-screen.ts'
import { useWorkspace } from '../workspace.tsx'
import { useWorkspaceFeed } from '../workspace-feed.tsx'
import { showHome } from '../../lib/home.ts'
import { type SlotName, useAppHost } from './host.tsx'

/** A ref callback that registers the slot's element under `name` and tells the stages whenever it resizes. */
export function useSlot(name: SlotName) {
  const { slot, kick } = useAppHost()
  const register = slot(name)
  const observer = useRef<ResizeObserver>(undefined)
  return useCallback(
    (node: HTMLElement | null) => {
      observer.current?.disconnect()
      observer.current = undefined
      if (node) {
        observer.current = new ResizeObserver(kick)
        observer.current.observe(node)
      }
      register(node)
    },
    [register, kick],
  )
}

/** A note in the App's place: what it is, why it is not here, and what can be done about that. */
export function AppNote({
  app,
  children,
  note,
}: {
  readonly app: AppView
  readonly note: string
  readonly children: ReactNode
}) {
  return (
    <div className="app-slot-note">
      <AppWindowIcon aria-hidden />
      <span className="truncate">
        {app.title} {note}
      </span>
      {children}
    </div>
  )
}

/** The App's room in its transcript, as tall as it asked, loading it once it is on screen unless it was unloaded. */
function InlinePlace({ app }: { readonly app: AppView }) {
  const host = useAppHost()
  const place = useRef<HTMLDivElement>(null)
  const onScreen = useOnScreen(place)
  const register = useSlot(`app-inline:${app.id}`)
  const live = host.instances.get(app.id)
  const problem = host.problems.get(app.id)
  const asleep = host.dormant.has(app.id) || problem !== undefined
  const { show } = host
  useEffect(() => {
    if (onScreen && !asleep) show(app)
  }, [onScreen, asleep, app, show])
  useLayoutEffect(() => {
    const height = CHROME_HEIGHT + inlineHeight(live?.height, window.innerHeight)
    place.current?.style.setProperty('--app-height', `${height}px`)
  }, [live?.height])
  return (
    <div ref={place} className="app-place">
      {asleep && live === undefined ? (
        <AppNote app={app} note={problem === undefined ? 'was unloaded to save memory' : `could not load: ${problem}`}>
          <Button variant="outline" size="sm" onClick={() => show(app)}>
            {problem === undefined ? 'Show' : 'Try again'}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => host.close(app.id)}>
            Close
          </Button>
        </AppNote>
      ) : (
        <div ref={register} className="app-inline-slot" />
      )}
    </div>
  )
}

/** A kept App's place in its tool row: the App itself, or, while it is a page, a note of that. */
export function AppPlace({ app }: { readonly app: AppView }) {
  const workspace = useWorkspace()
  const key = appKey(app.id)
  const tile = useWorkspaceFeed().home?.tiles.find((each) => each.kind === 'app' && each.appId === app.id)
  if (tile !== undefined && !isOpen(workspace.state, key))
    return (
      <AppNote app={app} note="is on Home">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            workspace.open('c:1', 'beside')
            requestAnimationFrame(() => showHome([tile.id]))
          }}
        >
          On Home
        </Button>
      </AppNote>
    )
  if (!isOpen(workspace.state, key)) return <InlinePlace app={app} />
  return (
    <AppNote app={app} note="is open as a page">
      <Button variant="outline" size="sm" onClick={() => workspace.focus(key)}>
        Go to it
      </Button>
      <Button variant="ghost" size="sm" onClick={() => workspace.close(key)}>
        Show here
      </Button>
    </AppNote>
  )
}
