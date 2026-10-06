// The App stages: one fixed box per live App, holding its iframe (and, in its transcript, the host's bar above it). A stage never moves in
// the DOM; it follows its App's page while the App has one, else the App's place in its transcript, frame by frame,
// and springs between the two when the App moves, so it leaves the transcript for its page and comes back along the
// same path without reloading. It clips itself to what of that place shows, and tells the host whether any does.
import { type RefObject, useEffect, useRef, useState } from 'react'
import { PanelRightOpenIcon, XIcon } from 'lucide-react'
import { Button, Receipt } from '@goblin/ui'
import { clipStage } from '../../lib/app-occlusion.ts'
import { CHROME_HEIGHT, type Rect } from '../../lib/app-stage.ts'
import { APP_MODES, type AppPlacement, inlineHeight } from '../../lib/host-context.ts'
import { atRest, type Motion, PLACE, stepSpring } from '../../lib/spring.ts'
import { AppFrame, selectionOrigin } from './frame.tsx'
import { AppJobs } from './app-jobs.tsx'
import { useAppGrantAsks } from './grant-ask.tsx'
import { type Instance, type SlotName, useAppHost } from './host.tsx'
import { DownloadOffer, LinkOffer } from './offers.tsx'
import { useAppPlacement } from './placement.ts'
import { useHomePin } from '../home/pin.ts'
import { appNames } from '../../lib/workspace-tree.ts'
import { useWorkspaceFeed } from '../workspace-feed.tsx'

type Axes = { x: Motion; y: Motion; width: Motion; height: Motion }
const AXES = ['x', 'y', 'width', 'height'] as const

/** What a stage's frame loop keeps between frames; plain mutable state, never rendered. */
type Live = { axes: Axes; seeded: boolean; moving: boolean; visible: boolean | undefined }

const still = (value: number): Motion => ({ value, velocity: 0 })

function write(element: HTMLElement, axes: Axes): void {
  element.style.transform = `translate3d(${axes.x.value}px, ${axes.y.value}px, 0)`
  element.style.width = `${axes.width.value}px`
  element.style.height = `${axes.height.value}px`
}

/** One frame: follow the target exactly, or spring towards it after the App moved between its place and its page. */
function advance(live: Live, target: Rect, seconds: number, reduced: boolean): boolean {
  if (!live.seeded || reduced || !live.moving) {
    live.axes = { x: still(target.x), y: still(target.y), width: still(target.width), height: still(target.height) }
    live.seeded = true
    live.moving = false
    return false
  }
  let moving = false
  for (const axis of AXES) {
    const next = stepSpring(live.axes[axis], target[axis], PLACE, seconds)
    live.axes[axis] = atRest(next, target[axis]) ? still(target[axis]) : next
    moving ||= !atRest(next, target[axis])
  }
  live.moving = moving
  return moving
}

/** The slot the stage follows, while it is laid out: one in a parked pane is not on screen anywhere. */
function slotOf(element: HTMLElement | undefined): HTMLElement | undefined {
  return element === undefined || element.closest('.workspace-parking') !== null ? undefined : element
}

function rectOf(element: HTMLElement): Rect {
  const { x, y, width, height } = element.getBoundingClientRect()
  return { x, y, width, height }
}

function slotName(surface: 'inline' | 'home' | 'page', id: string): SlotName {
  if (surface === 'page') return `app-page:${id}`
  if (surface === 'home') return `app-home:${id}`
  return `app-inline:${id}`
}

type StageMotion = {
  readonly stage: RefObject<HTMLDivElement | null>
  readonly live: RefObject<Live>
  /** The slot to follow now. */
  readonly slot: () => HTMLElement | undefined
  readonly onTarget: (rect: Rect) => void
  readonly onVisible: (visible: boolean) => void
}

/** Runs frames only while something moves; scrolling, resizing and slot changes ask for one more. */
function useStageMotion({ stage, live, slot, onTarget, onVisible }: StageMotion): () => void {
  const kickRef = useRef<() => void>(() => undefined)
  const { onKick } = useAppHost()
  useEffect(() => {
    let raf = 0
    let last = 0
    const reduced = matchMedia('(prefers-reduced-motion: reduce)')
    const frame = (now: number) => {
      raf = 0
      const seconds = last === 0 ? 1 / 60 : (now - last) / 1000
      last = now
      const element = stage.current
      if (element === null) return
      const followed = slot()
      if (followed === undefined) {
        element.dataset.hidden = ''
        live.current.seeded = false
        onVisible(false)
        return
      }
      element.toggleAttribute('data-editing', followed.closest('[data-editing]') !== null)
      delete element.dataset.hidden
      const rect = rectOf(followed)
      onTarget(rect)
      const moving = advance(live.current, rect, seconds, reduced.matches)
      write(element, live.current.axes)
      onVisible(clipStage(element, followed))
      if (moving) raf = requestAnimationFrame(frame)
      else last = 0
    }
    const kick = () => {
      if (raf === 0) raf = requestAnimationFrame(frame)
    }
    kickRef.current = kick
    const off = onKick(kick)
    window.addEventListener('scroll', kick, { capture: true, passive: true })
    window.addEventListener('resize', kick)
    window.addEventListener('pointermove', kick, { passive: true })
    window.visualViewport?.addEventListener('resize', kick)
    kick()
    return () => {
      cancelAnimationFrame(raf)
      off()
      window.removeEventListener('scroll', kick, { capture: true })
      window.removeEventListener('resize', kick)
      window.removeEventListener('pointermove', kick)
      window.visualViewport?.removeEventListener('resize', kick)
    }
  }, [stage, live, slot, onTarget, onVisible, onKick])
  return () => kickRef.current()
}

function ChromeButton({ label, icon: Icon, onClick }: { label: string; icon: typeof XIcon; onClick: () => void }) {
  return (
    <Button variant="ghost" size="icon-sm" aria-label={label} title={label} onClick={onClick}>
      <Icon />
    </Button>
  )
}

/** The host's bar above the App in its transcript: its name, to its page, and close. On its page the pill does this. */
function AppChrome({ instance, onPage }: { readonly instance: Instance; readonly onPage: () => void }) {
  const host = useAppHost()
  const home = useHomePin(instance.app)
  const title = appNames(useWorkspaceFeed().apps).get(instance.app.id) ?? instance.app.title
  return (
    <div className="app-chrome">
      <span className="app-chrome-title">{title}</span>
      {home.available && (
        <Button variant="ghost" size="sm" disabled={home.pending} onClick={() => void home.pin()}>
          Put on Home
        </Button>
      )}
      {home.notice && <span role="status">{home.notice}</span>}
      {instance.app.source.kind === 'agent' && <AppJobs jobs={instance.app.source.jobs} />}
      <ChromeButton label="Open as a page" icon={PanelRightOpenIcon} onClick={onPage} />
      <ChromeButton label="Close the app" icon={XIcon} onClick={() => host.close(instance.app.id)} />
    </div>
  )
}

/** The stage's measured room: the App's page, or its place in the transcript less the host's bar above it. */
function useRoom(chrome: RefObject<number>) {
  const [box, setBox] = useState({ width: 0, height: 0 })
  const [onTarget] = useState(() => (rect: Rect) => {
    const width = Math.round(rect.width)
    const height = Math.round(rect.height) - chrome.current
    setBox((current) => (current.width === width && current.height === height ? current : { width, height }))
  })
  return { box, onTarget }
}

/** The link and the file the App offers the owner, drawn by the host above the App. */
function StageOffers({ instance, origin }: { readonly instance: Instance; readonly origin: string }) {
  const host = useAppHost()
  const { id } = instance.app
  return (
    <>
      {instance.link && <LinkOffer link={instance.link} serverId={origin} onDone={() => host.setLink(id, undefined)} />}
      {instance.download && (
        <DownloadOffer file={instance.download} from={origin} onDone={() => host.setDownload(id, undefined)} />
      )}
    </>
  )
}

/** The App's state revision, for an agent app (its frame gets each newer one). */
const revisionOf = (instance: Instance) =>
  instance.app.source.kind === 'agent' ? { revision: instance.app.source.revision } : {}

function Stage({ instance }: { readonly instance: Instance }) {
  const host = useAppHost()
  const { id } = instance.app
  const origin = selectionOrigin(instance.selection)
  const place = useAppPlacement(instance.app)
  const name = slotName(place.surface, id)
  const stage = useRef<HTMLDivElement>(null)
  const live = useRef<Live>({
    axes: { x: still(0), y: still(0), width: still(0), height: still(0) },
    seeded: false,
    moving: false,
    visible: undefined,
  })
  const [error, setError] = useState('')
  const grants = useAppGrantAsks(origin, place.surface === 'home' ? place.page : undefined)
  const chrome = useRef(CHROME_HEIGHT)
  chrome.current = place.surface === 'inline' ? CHROME_HEIGHT : 0
  const { box, onTarget } = useRoom(chrome)
  const latest = useRef({ name, host })
  latest.current = { name, host }
  const [slot] = useState(() => () => slotOf(latest.current.host.element(latest.current.name)))
  const [onVisible] = useState(() => (visible: boolean) => {
    if (live.current.visible === visible) return
    live.current.visible = visible
    latest.current.host.seen(id, visible)
  })
  const kick = useStageMotion({ stage, live, slot, onTarget, onVisible })
  const previous = useRef(place.surface)
  useEffect(() => {
    if (previous.current === place.surface) return
    previous.current = place.surface
    if (matchMedia('(prefers-reduced-motion: reduce)').matches)
      stage.current?.animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: 150 })
    live.current.moving = live.current.seeded
    kick()
  }, [place.surface, kick])
  const placement: AppPlacement = {
    mode: place.paged ? 'fullscreen' : 'inline',
    available: APP_MODES,
    width: box.width,
    height: place.surface === 'inline' ? inlineHeight(10_000, window.innerHeight) : box.height,
    surface: place.surface,
    ...(place.surface === 'home' && place.tile !== undefined ? { tileSize: place.tile.size } : {}),
  }
  return (
    <div ref={stage} className="app-stage" data-mode={place.surface} data-app={id} data-hidden="">
      {place.surface === 'inline' && <AppChrome instance={instance} onPage={place.page} />}
      {error && (
        <Receipt tone="error">
          {error}.{' '}
          {place.surface === 'inline'
            ? 'The ordinary tool result remains available.'
            : 'Open the app or try showing it again.'}
        </Receipt>
      )}
      {grants.card}
      <StageOffers instance={instance} origin={origin} />
      <AppFrame
        selection={instance.selection}
        {...revisionOf(instance)}
        placement={placement}
        events={{
          report: setError,
          resize: (height) => {
            if (place.surface !== 'home') host.setHeight(id, height)
          },
          close: () => host.close(id),
          requestMode: place.request,
          share: (text) => host.setContext(id, text),
          offerLink: (link) => host.setLink(id, link),
          offerDownload: (file) => host.setDownload(id, file),
          askGrant: grants.ask,
        }}
      />
    </div>
  )
}

/** Every live App's stage, above the workspace. */
export function AppLayer() {
  const { instances } = useAppHost()
  return [...instances.values()].map((instance) => <Stage key={instance.app.id} instance={instance} />)
}
