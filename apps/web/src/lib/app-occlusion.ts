// What of an App's fixed stage shows over its slot: the stage sits outside every pane, so it clips itself to the
// containers that scroll its slot and to what floats over it in its pane. Clipping also stops the iframe taking
// pointer events where it is hidden.
import type { Rect } from './app-stage.ts'

/** The part of `box` inside `bounds`, or nothing where they do not overlap. */
export function intersect(box: Rect, bounds: Rect): Rect | undefined {
  const x = Math.max(box.x, bounds.x)
  const y = Math.max(box.y, bounds.y)
  const right = Math.min(box.x + box.width, bounds.x + bounds.width)
  const bottom = Math.min(box.y + box.height, bounds.y + bounds.height)
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : undefined
}

/** Subtract overlay rectangles: what of `box` the blockers leave, as disjoint regions. */
export function visibleRegions(box: Rect, blockers: readonly Rect[]): Rect[] {
  return blockers.reduce<Rect[]>((regions, blocker) => regions.flatMap((region) => subtract(region, blocker)), [box])
}
function subtract(box: Rect, blocker: Rect): Rect[] {
  const left = Math.max(box.x, blocker.x)
  const top = Math.max(box.y, blocker.y)
  const right = Math.min(box.x + box.width, blocker.x + blocker.width)
  const bottom = Math.min(box.y + box.height, blocker.y + blocker.height)
  if (left >= right || top >= bottom) return [box]
  return [
    { x: box.x, y: box.y, width: box.width, height: top - box.y },
    { x: box.x, y: bottom, width: box.width, height: box.y + box.height - bottom },
    { x: box.x, y: top, width: left - box.x, height: bottom - top },
    { x: right, y: top, width: box.x + box.width - right, height: bottom - top },
  ].filter((rect) => rect.width > 0 && rect.height > 0)
}

/** What of `box` shows: inside every one of `clips` (the containers around its slot), minus the `covers` over it. */
export function visibleParts(box: Rect, clips: readonly Rect[], covers: readonly Rect[]): Rect[] {
  let inside: Rect | undefined = box
  for (const clip of clips) inside = inside === undefined ? undefined : intersect(inside, clip)
  return inside === undefined ? [] : visibleRegions(inside, covers)
}

const rectOf = (element: Element): Rect => {
  const { x, y, width, height } = element.getBoundingClientRect()
  return { x, y, width, height }
}

/** The window, and every ancestor of `slot` that scrolls or hides its overflow. */
function clipsOf(slot: HTMLElement): Rect[] {
  const clips: Rect[] = [{ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }]
  for (let element = slot.parentElement; element !== null; element = element.parentElement) {
    const { overflowX, overflowY } = getComputedStyle(element)
    if (overflowX !== 'visible' || overflowY !== 'visible') clips.push(rectOf(element))
  }
  return clips
}

/**
 * Clips the stage to what of `slot` shows: inside the containers that scroll it, and under what its pane floats over
 * it (`data-app-cover`: the pill, the composer). Returns whether any of the App shows.
 */
export function clipStage(stage: HTMLElement, slot: HTMLElement | undefined): boolean {
  if (slot === undefined) {
    stage.style.clipPath = ''
    return false
  }
  const box = rectOf(stage)
  const pane = slot.closest('.workspace-pane')
  const covers = [...(pane?.querySelectorAll('[data-app-cover]') ?? [])]
    .filter((cover) => !cover.contains(slot))
    .map(rectOf)
  const regions = visibleParts(box, clipsOf(slot), covers)
  const whole = regions.length === 1 && regions[0]?.width === box.width && regions[0].height === box.height
  const path = regions
    .map(({ x, y, width, height }) => `M${x - box.x} ${y - box.y}h${width}v${height}h${-width}Z`)
    .join(' ')
  stage.style.clipPath = whole ? '' : regions.length === 0 ? 'inset(100%)' : `path("${path}")`
  return regions.length > 0
}
