import { type RefObject, useEffect, useLayoutEffect, useRef } from 'react'
import type { HomeTile } from '@goblin/contracts'
import { useAppHost } from '../apps/host.tsx'
import { atRest, PLACE, stepSpring, type Motion, type Spring } from '../../lib/spring.ts'

type Point = { x: Motion; y: Motion }
export const homeElements = (root: HTMLElement | null) => [
  ...(root?.querySelectorAll<HTMLElement>('[data-home-tile]') ?? []),
]

/** Layout moves start at the presentation rectangle; release keeps the gesture's velocity. */
export function settleTile(
  element: HTMLElement,
  point: Point,
  spring: Spring = PLACE,
  kick: () => void = () => undefined,
): () => void {
  let raf = 0
  let last = performance.now()
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  if (reduced) {
    element.style.transform = ''
    element.animate([{ opacity: 0.6 }, { opacity: 1 }], { duration: 150 })
    return () => undefined
  }
  const frame = (now: number) => {
    const seconds = (now - last) / 1000
    last = now
    point = { x: stepSpring(point.x, 0, spring, seconds), y: stepSpring(point.y, 0, spring, seconds) }
    element.style.transform = `translate3d(${point.x.value}px,${point.y.value}px,0)`
    kick()
    if (atRest(point.x, 0) && atRest(point.y, 0)) element.style.transform = ''
    else raf = requestAnimationFrame(frame)
  }
  raf = requestAnimationFrame(frame)
  return () => cancelAnimationFrame(raf)
}

/** A new tile appears once; every motion can be interrupted by a grab. */
function materialiseTile(element: HTMLElement, kick: () => void): () => void {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const fade = element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150 })
    return () => fade.cancel()
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
  return () => {
    cancelAnimationFrame(raf)
    clear()
  }
}

/** Empty slots move, never frames. The stage's kick measures each frame of a tile's settling motion. */
export function useHomeMotion(root: RefObject<HTMLElement | null>, tiles: readonly HomeTile[]) {
  const { kick } = useAppHost()
  const previous = useRef(new Map<string, DOMRect>())
  const moving = useRef(new Map<string, () => void>())
  const remember = () => {
    for (const node of homeElements(root.current))
      previous.current.set(node.dataset.homeTile ?? '', node.getBoundingClientRect())
  }
  useLayoutEffect(() => {
    for (const node of homeElements(root.current)) {
      const id = node.dataset.homeTile ?? ''
      const before = previous.current.get(id)
      moving.current.get(id)?.()
      node.style.transform = ''
      const rect = node.getBoundingClientRect()
      previous.current.set(id, rect)
      if (before === undefined) moving.current.set(id, materialiseTile(node, kick))
      else
        moving.current.set(
          id,
          settleTile(
            node,
            {
              x: { value: before.x - rect.x, velocity: 0 },
              y: { value: before.y - rect.y, velocity: 0 },
            },
            PLACE,
            kick,
          ),
        )
    }
  }, [root, tiles, kick])
  useEffect(
    () => () => {
      for (const cancel of moving.current.values()) cancel()
    },
    [],
  )
  return { remember, cancel: (id: string) => moving.current.get(id)?.() }
}
