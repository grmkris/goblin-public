import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { type Box, type DropPlan, planDrop, previewBox, zoneOf } from '../lib/pane-drop.ts'
import { type ItemKey, isOpen } from '../lib/workspace.ts'
import { useWorkspace } from './workspace.tsx'

/** How far the pointer moves before a press becomes a drag, so a click on a grip stays a click. */
const SLOP = 6

type Drag = {
  readonly item: ItemKey
  readonly title: string
  readonly x: number
  readonly y: number
  readonly plan: DropPlan
  readonly preview: Box | undefined
}

/** The pane under a point, as the item its host shows and that host's box. */
function paneAt(x: number, y: number): { readonly item: ItemKey; readonly box: Box } | undefined {
  for (const element of document.elementsFromPoint(x, y)) {
    const host = element.closest<HTMLElement>('.workspace-trellis [data-workspace-item]')
    const item = host?.dataset.workspaceItem
    if (host === null || item === undefined) continue
    const { left, top, width, height } = host.getBoundingClientRect()
    return { item, box: { left, top, width, height } }
  }
  return undefined
}

type Live = { readonly current: ReturnType<typeof useWorkspace> }

/**
 * One press on a drag source, from `down` until release: past `SLOP` it shows where the item would land (`show`), and
 * a release applies that. Escape or a cancelled pointer drops it.
 */
function track(down: PointerEvent, workspace: Live, show: (drag: Drag | undefined) => void): void {
  const source = down.target instanceof Element ? down.target.closest<HTMLElement>('[data-drag-item]') : null
  const item = source?.dataset.dragItem
  if (source === null || item === undefined || down.button !== 0) return
  let current: Drag | undefined
  const move = (event: PointerEvent) => {
    if (current === undefined && Math.hypot(event.clientX - down.clientX, event.clientY - down.clientY) < SLOP) return
    if (current === undefined) source.setPointerCapture(event.pointerId)
    const over = paneAt(event.clientX, event.clientY)
    const zone = over === undefined ? undefined : zoneOf(over.box, event.clientX, event.clientY)
    const open = isOpen(workspace.current.state, item)
    const plan: DropPlan =
      over === undefined || zone === undefined
        ? { kind: 'refused' }
        : planDrop({ item, target: over.item, zone, box: over.box, open, scrolls: true })
    const preview = over === undefined ? undefined : previewBox(over.box, plan)
    current = { item, title: workspace.current.titleOf(item), x: event.clientX, y: event.clientY, plan, preview }
    show(current)
  }
  const end = (commit: boolean) => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', cancel)
    window.removeEventListener('keydown', escape)
    const plan = current?.plan
    current = undefined
    show(undefined)
    if (!commit || plan === undefined || plan.kind === 'refused') return
    if (plan.kind === 'split') workspace.current.open(item, { target: plan.target, edge: plan.edge })
    else workspace.current.open(item, { into: plan.target })
  }
  const up = () => end(true)
  const cancel = () => end(false)
  const escape = (event: KeyboardEvent) => event.key === 'Escape' && end(false)
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', cancel)
  window.addEventListener('keydown', escape)
}

const px = (value: number) => `${Math.round(value)}px`

/**
 * Drag and drop between panes on a desktop. Anything marked `data-drag-item` (a pane's grip) can be dragged onto a
 * pane: near an edge it splits that pane there (refused when a half would be too small), in the middle it opens there,
 * trading places with it when the dragged item is already open. Escape cancels.
 */
export function WorkspaceDrag() {
  const workspace = useWorkspace()
  const latest = useRef(workspace)
  latest.current = workspace
  const [drag, setDrag] = useState<Drag>()
  const overlay = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const begin = (down: PointerEvent) => track(down, latest, setDrag)
    window.addEventListener('pointerdown', begin)
    return () => window.removeEventListener('pointerdown', begin)
  }, [])
  // Positions go through custom properties: the overlay follows the pointer every frame.
  useLayoutEffect(() => {
    const element = overlay.current
    if (element === null || drag === undefined) return
    const { preview } = drag
    const box = preview ?? { left: 0, top: 0, width: 0, height: 0 }
    for (const [name, value] of [
      ['--drag-x', drag.x],
      ['--drag-y', drag.y],
      ['--preview-left', box.left],
      ['--preview-top', box.top],
      ['--preview-width', box.width],
      ['--preview-height', box.height],
    ] as const)
      element.style.setProperty(name, px(value))
  }, [drag])
  if (drag === undefined) return null
  return (
    <div className="pane-drag" ref={overlay} aria-hidden>
      {drag.preview !== undefined && <div className="pane-drag-preview" />}
      <div className="pane-drag-ghost" data-refused={drag.plan.kind === 'refused'}>
        {drag.title}
      </div>
    </div>
  )
}
