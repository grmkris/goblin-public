// The App stage: one fixed box holding the live App's iframe and the host's chrome above it. It never moves in the
// DOM; it follows the slot its display mode names, frame by frame, and springs between slots when the mode changes,
// so the App leaves the transcript for the panel and returns along the same path without reloading. Picture-in-picture
// and the phone sheet are dragged by the chrome and thrown with momentum.
import { type PointerEvent as ReactPointerEvent, type RefObject, useEffect, useRef, useState } from 'react'
import type { McpUiDisplayMode } from '@modelcontextprotocol/ext-apps/app-bridge'
import { Maximize2Icon, Minimize2Icon, PanelRightOpenIcon, PictureInPicture2Icon, XIcon } from 'lucide-react'
import { Button, Receipt } from '@purrable/ui'
import { CHROME_HEIGHT, pipCorners, type Rect, sheetSnaps, stageRect, type Viewport } from '../../lib/app-stage.ts'
import { type AppPlacement, inlineHeight } from '../../lib/host-context.ts'
import {
  atRest,
  type Motion,
  nearestCorner,
  nearestSnap,
  type Point,
  project,
  releaseVelocity,
  rubberband,
  type Spring,
  SPRINGS,
  stepSpring,
} from '../../lib/spring.ts'
import { AppFrame } from './frame.tsx'
import { LinkOffer } from './offers.tsx'
import { type AppSession, useApps } from './provider.tsx'
import { AppPanel } from './slot.tsx'

type Axes = { x: Motion; y: Motion; width: Motion; height: Motion }
const AXES = ['x', 'y', 'width', 'height'] as const

/** What the stage's frame loop keeps between frames; plain mutable state, never rendered. */
type Live = {
  axes: Axes
  seeded: boolean
  spring: Spring | undefined
  dragging: boolean
  pip: Point | undefined
  sheet: number | undefined
}

function viewport(): Viewport {
  const header = document.querySelector('[data-slot="site-header"]')?.getBoundingClientRect().bottom ?? 56
  return { width: window.innerWidth, height: window.visualViewport?.height ?? window.innerHeight, top: header }
}

function rectOf(element: HTMLElement | undefined): Rect | undefined {
  if (element === undefined) return undefined
  const { x, y, width, height } = element.getBoundingClientRect()
  return { x, y, width, height }
}

const still = (value: number): Motion => ({ value, velocity: 0 })

function write(element: HTMLElement, axes: Axes): void {
  element.style.transform = `translate3d(${axes.x.value}px, ${axes.y.value}px, 0)`
  element.style.width = `${axes.width.value}px`
  element.style.height = `${axes.height.value}px`
}

/** One frame: follow the target exactly, or spring towards it after a mode change or a throw. */
function advance(live: Live, target: Rect, seconds: number, reduced: boolean): boolean {
  if (live.dragging) return true
  if (!live.seeded || reduced || live.spring === undefined) {
    live.axes = { x: still(target.x), y: still(target.y), width: still(target.width), height: still(target.height) }
    live.seeded = true
    live.spring = undefined
    return false
  }
  const spring = live.spring
  let moving = false
  for (const axis of AXES) {
    const next = stepSpring(live.axes[axis], target[axis], spring, seconds)
    live.axes[axis] = atRest(next, target[axis]) ? still(target[axis]) : next
    moving ||= !atRest(next, target[axis])
  }
  if (!moving) live.spring = undefined
  return moving
}

/** Runs frames only while something moves; scrolling, resizing and slot changes ask for one more. */
function useStageMotion(
  stage: RefObject<HTMLDivElement | null>,
  live: RefObject<Live>,
  target: () => Rect | undefined,
  onTarget: (rect: Rect) => void,
): () => void {
  const kickRef = useRef<() => void>(() => undefined)
  const { onKick } = useApps()
  useEffect(() => {
    let raf = 0
    let last = 0
    const reduced = matchMedia('(prefers-reduced-motion: reduce)')
    const frame = (now: number) => {
      raf = 0
      const seconds = last === 0 ? 1 / 60 : (now - last) / 1000
      last = now
      const element = stage.current
      const rect = target()
      if (element === null) return
      if (rect === undefined) {
        element.dataset.hidden = ''
        live.current.seeded = false
        return
      }
      delete element.dataset.hidden
      onTarget(rect)
      const moving = advance(live.current, rect, seconds, reduced.matches)
      write(element, live.current.axes)
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
    window.visualViewport?.addEventListener('resize', kick)
    kick()
    return () => {
      cancelAnimationFrame(raf)
      off()
      window.removeEventListener('scroll', kick, { capture: true })
      window.removeEventListener('resize', kick)
      window.visualViewport?.removeEventListener('resize', kick)
    }
  }, [stage, live, target, onTarget, onKick])
  return () => kickRef.current()
}

type Drag = { readonly start: Point; readonly origin: Rect; samples: (Point & { readonly time: number })[] }

/** Release: throw picture-in-picture to the corner its momentum points at, or snap (or dismiss) the sheet. */
function release(live: Live, drag: Drag, setMode: (mode: McpUiDisplayMode) => McpUiDisplayMode, sheet: boolean) {
  const velocity = releaseVelocity(drag.samples)
  const { axes } = live
  const view = viewport()
  if (sheet) {
    const snaps = sheetSnaps(view)
    const projected = axes.height.value - project(velocity.y)
    if (projected < snaps[0] * 0.6) setMode('inline')
    live.sheet = nearestSnap(projected, snaps)
    axes.y = { value: axes.y.value, velocity: velocity.y }
    axes.height = { value: axes.height.value, velocity: -velocity.y }
    live.spring = SPRINGS.sheet
    return
  }
  const projected = { x: axes.x.value + project(velocity.x), y: axes.y.value + project(velocity.y) }
  live.pip = nearestCorner(projected, pipCorners(view))
  axes.x = { value: axes.x.value, velocity: velocity.x }
  axes.y = { value: axes.y.value, velocity: velocity.y }
  live.spring = SPRINGS.momentum
}

/** 1:1 dragging by the chrome, from where it was grabbed; the sheet resists past its full height. */
function useStageDrag(live: RefObject<Live>, kick: () => void, mode: McpUiDisplayMode, sheet: boolean) {
  const drag = useRef<Drag>(undefined)
  const { setMode } = useApps()
  const grabbable = mode === 'pip' || sheet
  const move = (event: ReactPointerEvent) => {
    const current = drag.current
    if (current === undefined) return
    current.samples = [...current.samples.slice(-8), { x: event.clientX, y: event.clientY, time: event.timeStamp }]
    const dx = event.clientX - current.start.x
    const dy = event.clientY - current.start.y
    const { axes } = live.current
    if (sheet) {
      const [, full] = sheetSnaps(viewport())
      const wanted = current.origin.height - dy
      const height = wanted > full ? full + rubberband(wanted - full, full) : Math.max(0, wanted)
      axes.height = still(height)
      axes.y = still(viewport().height - height)
    } else {
      axes.x = still(current.origin.x + dx)
      axes.y = still(current.origin.y + dy)
    }
    kick()
  }
  const down = (event: ReactPointerEvent<HTMLElement>) => {
    const onButton = event.target instanceof Element && event.target.closest('button') !== null
    if (!grabbable || event.button !== 0 || onButton) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const { x, y, width, height } = live.current.axes
    const point = { x: event.clientX, y: event.clientY }
    drag.current = {
      start: point,
      origin: { x: x.value, y: y.value, width: width.value, height: height.value },
      samples: [{ ...point, time: event.timeStamp }],
    }
    live.current.dragging = true
  }
  const up = () => {
    const current = drag.current
    if (current === undefined) return
    drag.current = undefined
    live.current.dragging = false
    release(live.current, current, setMode, sheet)
    kick()
  }
  return grabbable ? { onPointerDown: down, onPointerMove: move, onPointerUp: up, onPointerCancel: up } : {}
}

const MODE_ACTIONS: Record<McpUiDisplayMode, { readonly label: string; readonly icon: typeof XIcon }> = {
  inline: { label: 'Back to the conversation', icon: Minimize2Icon },
  fullscreen: { label: 'Open in the side panel', icon: PanelRightOpenIcon },
  pip: { label: 'Picture in picture', icon: PictureInPicture2Icon },
}

function AppChrome({ session, drag }: { readonly session: AppSession; readonly drag: object }) {
  const { available, phone, setMode, close } = useApps()
  return (
    <div className="app-chrome" data-grabbable={'onPointerDown' in drag || undefined} {...drag}>
      <span className="app-chrome-title">App from {session.selection.serverId}</span>
      {available
        .filter((mode) => mode !== session.mode)
        .map((mode) => {
          const action = MODE_ACTIONS[mode]
          const Icon = phone && mode === 'fullscreen' ? Maximize2Icon : action.icon
          const label = phone && mode === 'fullscreen' ? 'Expand' : action.label
          return (
            <Button
              key={mode}
              variant="ghost"
              size="icon-sm"
              aria-label={label}
              title={label}
              onClick={() => setMode(mode)}
            >
              <Icon />
            </Button>
          )
        })}
      <Button variant="ghost" size="icon-sm" aria-label="Close the app" title="Close" onClick={close}>
        <XIcon />
      </Button>
    </div>
  )
}

function Stage({ session }: { readonly session: AppSession }) {
  const apps = useApps()
  const { mode, key } = session
  const sheet = apps.phone && mode === 'fullscreen'
  const stage = useRef<HTMLDivElement>(null)
  const live = useRef<Live>({
    axes: { x: still(0), y: still(0), width: still(0), height: still(0) },
    seeded: false,
    spring: undefined,
    dragging: false,
    pip: undefined,
    sheet: undefined,
  })
  const [error, setError] = useState('')
  const [box, setBox] = useState({ width: 0, height: 0 })
  const target = useRef<() => Rect | undefined>(() => undefined)
  target.current = () => {
    if (apps.phone && mode === 'inline') return undefined
    const view = viewport()
    return stageRect(mode, {
      viewport: view,
      phone: apps.phone,
      inline: rectOf(apps.element(`inline:${key}`)),
      panel: rectOf(apps.element('panel')),
      pip: live.current.pip ?? pipCorners(view)[0],
      sheet: live.current.sheet ?? sheetSnaps(view)[1],
    })
  }
  const [measure] = useState(() => () => target.current())
  const [onTarget] = useState(() => (rect: Rect) => {
    const width = Math.round(rect.width)
    const height = Math.round(rect.height) - CHROME_HEIGHT
    setBox((current) => (current.width === width && current.height === height ? current : { width, height }))
  })
  const kick = useStageMotion(stage, live, measure, onTarget)
  const drag = useStageDrag(live, kick, mode, sheet)
  const previous = useRef(mode)
  useEffect(() => {
    if (previous.current === mode) return
    previous.current = mode
    live.current.spring = SPRINGS.place
    kick()
  }, [mode, kick])
  const placement: AppPlacement = {
    mode,
    available: apps.available,
    width: box.width,
    height: mode === 'inline' ? inlineHeight(10_000, window.innerHeight) : box.height,
  }
  return (
    <div ref={stage} className="app-stage" data-mode={sheet ? 'sheet' : mode} data-hidden="">
      <AppChrome session={session} drag={drag} />
      {error && <Receipt tone="error">{error}. The ordinary tool result remains available.</Receipt>}
      {session.link && (
        <LinkOffer link={session.link} serverId={session.selection.serverId} onDone={() => apps.setLink(undefined)} />
      )}
      <AppFrame
        selection={session.selection}
        placement={placement}
        events={{
          report: setError,
          resize: apps.setHeight,
          close: apps.close,
          requestMode: apps.setMode,
          share: apps.setContext,
          offerLink: apps.setLink,
        }}
      />
    </div>
  )
}

/**
 * The chat view's App places beside the conversation: the side panel while the App is in it on a desktop, and the
 * stage holding the single live App, wherever its display mode puts it. Nothing while no App is open.
 */
export function AppLayer() {
  const { session, phone } = useApps()
  if (session === undefined) return null
  return (
    <>
      {session.mode === 'fullscreen' && !phone && <AppPanel />}
      <Stage key={`${session.key} ${session.selection.uri}`} session={session} />
    </>
  )
}
