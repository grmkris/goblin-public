// The App stages: one fixed box per live App, holding its iframe and the host's chrome above it. A stage never moves in
// the DOM; it follows its App's page while the App has one, else the App's place in its transcript, frame by frame,
// and springs between the two when the App moves, so it leaves the transcript for its page and comes back along the
// same path without reloading. It clips itself to what of that place shows, and tells the host whether any does.
import { type RefObject, useEffect, useRef, useState } from 'react'
import type { McpUiDisplayMode } from '@modelcontextprotocol/ext-apps/app-bridge'
import { Maximize2Icon, Minimize2Icon, PanelLeftCloseIcon, PanelRightOpenIcon, XIcon } from 'lucide-react'
import { Button, Receipt } from '@purrable/ui'
import { clipStage } from '../../lib/app-occlusion.ts'
import { CHROME_HEIGHT, type Rect } from '../../lib/app-stage.ts'
import { APP_MODES, type AppPlacement, inlineHeight } from '../../lib/host-context.ts'
import { atRest, type Motion, PLACE, stepSpring } from '../../lib/spring.ts'
import { appKey, conversationKey, isOpen, order } from '../../lib/workspace.ts'
import { useWorkspace } from '../workspace.tsx'
import { AppFrame } from './frame.tsx'
import { useAppGrantAsks } from './grant-ask.tsx'
import { type Instance, type SlotName, useAppHost } from './host.tsx'
import { LinkOffer } from './offers.tsx'

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

/** Where an App is shown and how it moves: to its page beside its transcript, back, filling the workspace, or not. */
function usePlacement(instance: Instance) {
  const workspace = useWorkspace()
  const host = useAppHost()
  const { id, conversation } = instance.app
  const key = appKey(id)
  const paged = isOpen(workspace.state, key)
  const filled = workspace.state.maximized === key
  const page = () => {
    const source = host.element(`app-inline:${id}`)?.closest<HTMLElement>('[data-workspace-item]')
      ?.dataset.workspaceItem
    workspace.open(key, 'beside', source)
  }
  /** Back in its transcript: the page closes, or, as the last pane, shows the App's conversation in its place. */
  const inline = () => {
    if (filled) workspace.maximize(undefined)
    if (order(workspace.state).length > 1) workspace.close(key)
    else workspace.open(conversationKey(conversation), 'here', key)
  }
  const fill = () => workspace.maximize(filled ? undefined : key)
  /** What the App asked for: fullscreen is its page filling the workspace; inline is back in its transcript. */
  const request = (mode: McpUiDisplayMode): McpUiDisplayMode => {
    if (mode === 'fullscreen') {
      if (!paged) page()
      workspace.maximize(key)
      return 'fullscreen'
    }
    if (mode !== 'inline') return paged ? 'fullscreen' : 'inline'
    if (paged) inline()
    return 'inline'
  }
  return { paged, filled, page, inline, fill, request }
}

function ChromeButton({ label, icon: Icon, onClick }: { label: string; icon: typeof XIcon; onClick: () => void }) {
  return (
    <Button variant="ghost" size="icon-sm" aria-label={label} title={label} onClick={onClick}>
      <Icon />
    </Button>
  )
}

/** The host's bar above the App: its name, to its page or back, filling the workspace from its page, and close. */
function AppChrome({
  instance,
  place,
}: {
  readonly instance: Instance
  readonly place: ReturnType<typeof usePlacement>
}) {
  const host = useAppHost()
  return (
    <div className="app-chrome">
      <span className="app-chrome-title">{instance.app.title}</span>
      {place.paged ? (
        <ChromeButton label="Back in the conversation" icon={PanelLeftCloseIcon} onClick={place.inline} />
      ) : (
        <ChromeButton label="Open as a page" icon={PanelRightOpenIcon} onClick={place.page} />
      )}
      {place.paged && (
        <ChromeButton
          label={place.filled ? 'Stop filling the workspace' : 'Fill the workspace'}
          icon={place.filled ? Minimize2Icon : Maximize2Icon}
          onClick={place.fill}
        />
      )}
      <ChromeButton label="Close the app" icon={XIcon} onClick={() => host.close(instance.app.id)} />
    </div>
  )
}

/** The stage's measured room: the App's page less the chrome, or its place's width up to most of the window. */
function useRoom() {
  const [box, setBox] = useState({ width: 0, height: 0 })
  const [onTarget] = useState(() => (rect: Rect) => {
    const width = Math.round(rect.width)
    const height = Math.round(rect.height) - CHROME_HEIGHT
    setBox((current) => (current.width === width && current.height === height ? current : { width, height }))
  })
  return { box, onTarget }
}

function Stage({ instance }: { readonly instance: Instance }) {
  const host = useAppHost()
  const { id } = instance.app
  const { serverId } = instance.selection
  const place = usePlacement(instance)
  const name: SlotName = place.paged ? `app-page:${id}` : `app-inline:${id}`
  const stage = useRef<HTMLDivElement>(null)
  const live = useRef<Live>({
    axes: { x: still(0), y: still(0), width: still(0), height: still(0) },
    seeded: false,
    moving: false,
    visible: undefined,
  })
  const [error, setError] = useState('')
  const grants = useAppGrantAsks(serverId)
  const { box, onTarget } = useRoom()
  const latest = useRef({ name, host })
  latest.current = { name, host }
  const [slot] = useState(() => () => slotOf(latest.current.host.element(latest.current.name)))
  const [onVisible] = useState(() => (visible: boolean) => {
    if (live.current.visible === visible) return
    live.current.visible = visible
    latest.current.host.seen(id, visible)
  })
  const kick = useStageMotion({ stage, live, slot, onTarget, onVisible })
  const previous = useRef(place.paged)
  useEffect(() => {
    if (previous.current === place.paged) return
    previous.current = place.paged
    live.current.moving = live.current.seeded
    kick()
  }, [place.paged, kick])
  const placement: AppPlacement = {
    mode: place.paged ? 'fullscreen' : 'inline',
    available: APP_MODES,
    width: box.width,
    height: place.paged ? box.height : inlineHeight(10_000, window.innerHeight),
  }
  return (
    <div ref={stage} className="app-stage" data-mode={place.paged ? 'page' : 'inline'} data-app={id} data-hidden="">
      <AppChrome instance={instance} place={place} />
      {error && <Receipt tone="error">{error}. The ordinary tool result remains available.</Receipt>}
      {grants.card}
      {instance.link && (
        <LinkOffer link={instance.link} serverId={serverId} onDone={() => host.setLink(id, undefined)} />
      )}
      <AppFrame
        selection={instance.selection}
        placement={placement}
        events={{
          report: setError,
          resize: (height) => host.setHeight(id, height),
          close: () => host.close(id),
          requestMode: place.request,
          share: (text) => host.setContext(id, text),
          offerLink: (link) => host.setLink(id, link),
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
