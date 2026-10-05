import type { Rect } from './app-stage.ts'

/** Subtract overlay rectangles so a fixed App stage respects Trellis's floating window order. */
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

/** The iframe remains fixed; clipping also excludes hit testing beneath windows above its own pane. */
export function clipStage(stage: HTMLElement, slot: HTMLElement | undefined): void {
  const root = slot?.closest('.trellis')
  const panelId = slot?.closest<HTMLElement>('[data-workspace-panel]')?.dataset.workspacePanel
  const own = [...(root?.querySelectorAll<HTMLElement>('[data-trellis-part="panel"]') ?? [])].find(
    (panel) => panel.dataset.panel === panelId,
  )
  if (!own || !root) {
    stage.style.clipPath = ''
    return
  }
  const box = stage.getBoundingClientRect()
  const ownZ = own.hasAttribute('data-floating') ? Number(own.style.zIndex) : -1
  const blockers = [...root.querySelectorAll<HTMLElement>('[data-trellis-part="panel"][data-floating]')]
    .filter((panel) => panel !== own && Number(panel.style.zIndex) >= ownZ)
    .map((panel) => panel.getBoundingClientRect())
  blockers.push(...[...root.querySelectorAll<HTMLElement>('[role=menu]')].map((menu) => menu.getBoundingClientRect()))
  const regions = visibleRegions(box, blockers)
  const path = regions
    .map(({ x, y, width, height }) => {
      const left = x - box.x,
        top = y - box.y
      return `M${left} ${top}h${width}v${height}h${-width}Z`
    })
    .join(' ')
  stage.style.clipPath = regions.length === 0 ? 'inset(100%)' : `path("${path}")`
}
