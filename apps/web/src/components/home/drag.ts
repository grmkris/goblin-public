import { type PointerEvent as ReactPointerEvent, type RefObject, useEffect, useRef } from 'react'
import type { HomeOperation } from '@goblin/contracts'
import { nearestHomeSlot, projectHomeDrag } from '../../lib/home-drag.ts'
import { useAppHost } from '../apps/host.tsx'
import type { Spring } from '../../lib/spring.ts'
import { type Release, homeElements } from './motion.ts'

type Gesture = {
  readonly id: string
  readonly tile: HTMLElement
  readonly handle: HTMLElement
  readonly pointer: number
  readonly start: { x: number; y: number }
  last: { x: number; y: number; at: number }
  velocity: { x: number; y: number }
  active: boolean
  timer: ReturnType<typeof setTimeout> | undefined
}

function lift(gesture: Gesture): void {
  gesture.active = true
  gesture.tile.dataset.lifted = ''
  gesture.handle.setPointerCapture(gesture.pointer)
}

function beginGesture(event: ReactPointerEvent<HTMLElement>, id: string): Gesture | undefined {
  if (event.button !== 0) return
  const tile = event.currentTarget.closest<HTMLElement>('[data-home-tile]')
  if (tile === null) return
  const rect = tile.getBoundingClientRect()
  tile.style.transform = ''
  const base = tile.getBoundingClientRect()
  const gesture: Gesture = {
    id,
    tile,
    handle: event.currentTarget,
    pointer: event.pointerId,
    start: { x: event.clientX - rect.x + base.x, y: event.clientY - rect.y + base.y },
    last: { x: event.clientX, y: event.clientY, at: event.timeStamp },
    velocity: { x: 0, y: 0 },
    active: false,
    timer: undefined,
  }
  if (event.pointerType === 'touch') gesture.timer = setTimeout(() => lift(gesture), 250)
  else lift(gesture)
  return gesture
}

/**
 * A lifted tile keeps the page from scrolling under it. The blocking listener sits on Home alone, where every drag
 * starts: on the document it made every touch scroll in the conversation wait on the main thread.
 */
function useLiftedTouch(root: RefObject<HTMLElement | null>, current: RefObject<Gesture | undefined>) {
  useEffect(() => {
    const element = root.current
    const touch = (event: TouchEvent) => {
      if (current.current?.active) event.preventDefault()
    }
    element?.addEventListener('touchmove', touch, { passive: false })
    return () => element?.removeEventListener('touchmove', touch)
  }, [root, current])
}

/** The spring a dropped tile settles on: a little give, because a throw carried momentum into it. */
const DROP: Spring = { damping: 0.8, response: 0.3 }

/**
 * Native scrolling until the touch long press; lifted tiles follow the pointer with the original grab offset. A drop
 * hands its place and velocity to Home's motion: the tile goes straight from there to its new slot (the edit shows at
 * once), or back to its own if it moved nowhere, so it never heads home first and turns around.
 */
export function useHomeDrag(
  root: RefObject<HTMLElement | null>,
  edit: (ops: readonly HomeOperation[]) => Promise<void>,
  motion: { readonly release: (drop: Release) => void; readonly unreleased: () => void },
) {
  const { kick } = useAppHost()
  const current = useRef<Gesture | undefined>(undefined)
  const latest = useRef(edit)
  latest.current = edit
  useLiftedTouch(root, current)
  useEffect(() => () => clearTimeout(current.current?.timer), [])
  const start = (event: ReactPointerEvent<HTMLElement>, id: string) => {
    current.current = beginGesture(event, id)
  }
  const move = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = current.current
    if (gesture === undefined) return
    if (!gesture.active) {
      if (Math.hypot(event.clientX - gesture.last.x, event.clientY - gesture.last.y) > 8) {
        clearTimeout(gesture.timer)
        current.current = undefined
      }
      return
    }
    const seconds = Math.max(0.001, (event.timeStamp - gesture.last.at) / 1000)
    gesture.velocity = { x: (event.clientX - gesture.last.x) / seconds, y: (event.clientY - gesture.last.y) / seconds }
    gesture.last = { x: event.clientX, y: event.clientY, at: event.timeStamp }
    gesture.tile.style.transform = `translate3d(${event.clientX - gesture.start.x}px,${event.clientY - gesture.start.y}px,0)`
    // An App tile's frame follows its slot only when told to: tell it every move.
    kick()
  }
  const end = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = current.current
    current.current = undefined
    clearTimeout(gesture?.timer)
    if (gesture === undefined || !gesture.active) return
    delete gesture.tile.dataset.lifted
    if (gesture.handle.hasPointerCapture(gesture.pointer)) gesture.handle.releasePointerCapture(gesture.pointer)
    const rect = gesture.tile.getBoundingClientRect()
    const nodes = homeElements(root.current)
    gesture.tile.style.transform = ''
    const velocity = event.timeStamp - gesture.last.at > 100 ? { x: 0, y: 0 } : gesture.velocity
    const point = {
      x: projectHomeDrag(rect.x + rect.width / 2, velocity.x),
      y: projectHomeDrag(rect.y + rect.height / 2, velocity.y),
    }
    const index = nearestHomeSlot(
      point,
      nodes.map((node) => node.getBoundingClientRect()),
    )
    motion.release({ id: gesture.id, rect, velocity, spring: DROP })
    if (event.type === 'pointercancel' || index === nodes.indexOf(gesture.tile)) {
      motion.unreleased()
      return
    }
    void latest.current([{ kind: 'move', id: gesture.id, index }])
    // The edit shows within this event, before the next paint; if it did not go out, the drop goes home instead.
    queueMicrotask(motion.unreleased)
  }
  return { start, move, end }
}
