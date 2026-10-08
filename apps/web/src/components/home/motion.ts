import { type RefObject, useEffect, useLayoutEffect, useRef } from 'react'
import type { HomeTile } from '@goblin/contracts'
import { useAppHost } from '../apps/host.tsx'
import { atRest, PLACE, stepSpring, type Motion, type Spring } from '../../lib/spring.ts'

type Point = { x: Motion; y: Motion }
type Offset = { readonly x: number; readonly y: number }
/** A tile's motion in flight: where it is now (its offset from its place, with velocity), and how to stop it. */
type Moving = { readonly cancel: () => void; readonly point: () => Point }
/** A tile let go of by a drag: where it was dropped (relative to Home) and how fast it was moving. */
export type Release = {
  readonly id: string
  readonly rect: DOMRect
  readonly velocity: Offset
  readonly spring: Spring
}

const STILL: Point = { x: { value: 0, velocity: 0 }, y: { value: 0, velocity: 0 } }
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches

export const homeElements = (root: HTMLElement | null) => [
  ...(root?.querySelectorAll<HTMLElement>('[data-home-tile]') ?? []),
]

/**
 * Springs `element` from `point` (its offset from its place) to its place. It starts where the tile is and keeps the
 * velocity it was given; `point()` reads where it is now, so the next move can start there instead of jumping.
 */
export function settleTile(
  element: HTMLElement,
  start: Point,
  spring: Spring = PLACE,
  kick: () => void = () => undefined,
): Moving {
  if (reduced()) {
    element.style.transform = ''
    const fade = element.animate([{ opacity: 0.6 }, { opacity: 1 }], { duration: 150 })
    return { cancel: () => fade.cancel(), point: () => STILL }
  }
  let point = start
  let raf = 0
  let last = performance.now()
  const frame = (now: number) => {
    const seconds = (now - last) / 1000
    last = now
    point = { x: stepSpring(point.x, 0, spring, seconds), y: stepSpring(point.y, 0, spring, seconds) }
    element.style.transform = `translate3d(${point.x.value}px,${point.y.value}px,0)`
    kick()
    if (atRest(point.x, 0) && atRest(point.y, 0)) {
      element.style.transform = ''
      point = STILL
    } else raf = requestAnimationFrame(frame)
  }
  raf = requestAnimationFrame(frame)
  return { cancel: () => cancelAnimationFrame(raf), point: () => point }
}

/** A tile that is new to Home materialises once; a grab or a later move takes over from wherever it is. */
function materialiseTile(element: HTMLElement, kick: () => void): Moving {
  if (reduced()) {
    const fade = element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150 })
    return { cancel: () => fade.cancel(), point: () => STILL }
  }
  let progress: Motion = { value: 0, velocity: 0 }
  let last = performance.now()
  let raf = 0
  const clear = () => {
    element.style.opacity = ''
    element.style.transform = ''
    element.style.filter = ''
  }
  const frame = (now: number) => {
    progress = stepSpring(progress, 1, { damping: 1, response: 0.35 }, (now - last) / 1000)
    last = now
    element.style.opacity = String(progress.value)
    element.style.transform = `scale(${0.96 + 0.04 * progress.value})`
    element.style.filter = `blur(${6 * (1 - progress.value)}px)`
    kick()
    if (atRest(progress, 1) && progress.value > 0.99) clear()
    else raf = requestAnimationFrame(frame)
  }
  raf = requestAnimationFrame(frame)
  return {
    cancel: () => {
      cancelAnimationFrame(raf)
      clear()
    },
    point: () => STILL,
  }
}

const relative = (rect: DOMRect, origin: DOMRect): Offset => ({ x: rect.x - origin.x, y: rect.y - origin.y })
const idOf = (node: HTMLElement) => node.dataset.homeTile ?? ''
/** A tile that was at `was` and is `now` off it (mid-glide), heading to `place`: or nowhere, for a tile new here. */
function fromWas(was: Offset | undefined, now: Point, place: Offset): Point | undefined {
  if (was === undefined) return undefined
  return {
    x: { value: was.x + now.x.value - place.x, velocity: now.x.velocity },
    y: { value: was.y + now.y.value - place.y, velocity: now.y.velocity },
  }
}

/** A dropped tile, from where it was let go and as fast as it was moving. */
function fromDrop(drop: Release, origin: DOMRect, place: Offset): Point {
  const from = relative(drop.rect, origin)
  return {
    x: { value: from.x - place.x, velocity: drop.velocity.x },
    y: { value: from.y - place.y, velocity: drop.velocity.y },
  }
}

/** Tiles no longer on Home: their places and motions go, so one added again later materialises instead of gliding. */
function forgetGone(places: Map<string, Offset>, moving: Map<string, Moving>, present: ReadonlySet<string>): void {
  for (const id of places.keys())
    if (!present.has(id)) {
      places.delete(id)
      moving.get(id)?.cancel()
      moving.delete(id)
    }
}

/** The tiles' order and sizes: only a change to these moves anything. A new object with the same tiles does not. */
const geometryOf = (tiles: readonly HomeTile[]) => tiles.map((tile) => `${tile.id}:${tile.size}`).join(' ')

/**
 * Tiles glide when Home's order or sizes change, each from where it is on screen (mid-glide too, keeping its velocity)
 * to its new place; a dropped tile goes from where it was let go with the drag's velocity. Places are kept relative to
 * Home, so the transcript scrolling or growing never reads as tile movement. Tiles already there when Home first loads
 * are still; a tile added after that materialises. The stage's kick measures each frame for App tiles.
 */
export function useHomeMotion(root: RefObject<HTMLElement | null>, tiles: readonly HomeTile[], loaded: boolean) {
  const { kick } = useAppHost()
  const places = useRef(new Map<string, Offset>())
  const moving = useRef(new Map<string, Moving>())
  const released = useRef<Release>(undefined)
  const seeded = useRef(false)
  const geometry = geometryOf(tiles)
  useLayoutEffect(() => {
    const element = root.current
    if (element === null || !loaded) return
    const origin = element.getBoundingClientRect()
    const first = !seeded.current
    seeded.current = true
    const drop = released.current
    released.current = undefined
    const present = new Set<string>()
    for (const node of homeElements(element)) {
      const id = idOf(node)
      present.add(id)
      const was = places.current.get(id)
      const now = moving.current.get(id)?.point() ?? STILL
      moving.current.get(id)?.cancel()
      node.style.transform = ''
      const place = relative(node.getBoundingClientRect(), origin)
      places.current.set(id, place)
      const thrown = drop?.id === id ? drop : undefined
      const start = thrown === undefined ? fromWas(was, now, place) : fromDrop(thrown, origin, place)
      if (start !== undefined) moving.current.set(id, settleTile(node, start, thrown?.spring ?? PLACE, kick))
      else if (first) moving.current.delete(id)
      else moving.current.set(id, materialiseTile(node, kick))
    }
    forgetGone(places.current, moving.current, present)
  }, [root, geometry, loaded, kick])
  useEffect(
    () => () => {
      for (const motion of moving.current.values()) motion.cancel()
    },
    [],
  )
  /** The tile `id`, back to its place from `rect` (a drop that changes nothing, or an edit that never went out). */
  const settle = (id: string, rect: DOMRect, velocity: Offset, spring: Spring) => {
    const node = homeElements(root.current).find((candidate) => idOf(candidate) === id)
    if (node === undefined) return
    moving.current.get(id)?.cancel()
    node.style.transform = ''
    const place = node.getBoundingClientRect()
    const start = {
      x: { value: rect.x - place.x, velocity: velocity.x },
      y: { value: rect.y - place.y, velocity: velocity.y },
    }
    moving.current.set(id, settleTile(node, start, spring, kick))
  }
  return {
    /** The next layout change carries this drop: the tile leaves from where it was let go. */
    release: (drop: Release) => {
      released.current = drop
    },
    /** A drop the next layout change did not carry (the edit never went out, or changed nothing) goes home. */
    unreleased: () => {
      const drop = released.current
      released.current = undefined
      if (drop !== undefined) settle(drop.id, drop.rect, drop.velocity, drop.spring)
    },
    cancel: (id: string) => moving.current.get(id)?.cancel(),
  }
}
