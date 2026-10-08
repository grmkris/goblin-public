import { diagramNodes, highlightDiagram, type DiagramNode } from './diagram-selection.ts'

/** Distinguish a tap from dragging/pinching, including release beyond the viewport. */
function trackGesture(viewport: HTMLDivElement) {
  const starts = new Map<number, { x: number; y: number }>()
  let dragged = false
  const down = (event: PointerEvent) => {
    if (starts.size === 0) dragged = false
    starts.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (starts.size > 1) dragged = true
  }
  const move = (event: PointerEvent) => {
    const start = starts.get(event.pointerId)
    if (start !== undefined && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) dragged = true
  }
  const up = (event: PointerEvent) => starts.delete(event.pointerId)
  viewport.addEventListener('pointerdown', down, true)
  document.addEventListener('pointermove', move, true)
  document.addEventListener('pointerup', up, true)
  document.addEventListener('pointercancel', up, true)
  return {
    dragging: () => starts.size > 0,
    dragged: () => dragged,
    destroy: () => {
      viewport.removeEventListener('pointerdown', down, true)
      document.removeEventListener('pointermove', move, true)
      document.removeEventListener('pointerup', up, true)
      document.removeEventListener('pointercancel', up, true)
    },
  }
}

function prepareNodes(svg: SVGSVGElement) {
  const nodes = diagramNodes(svg)
  for (const node of nodes) {
    node.element.setAttribute('role', 'button')
    node.element.setAttribute('tabindex', '0')
    node.element.setAttribute('aria-label', `Select ${node.label}`)
    node.element.setAttribute('aria-pressed', 'false')
    node.element.dataset.diagramSelectable = ''
  }
  return nodes
}

export function diagramInteraction(
  viewport: HTMLDivElement,
  svg: SVGSVGElement,
  onSelection: (node: DiagramNode | undefined, count: number) => void,
) {
  const nodes = prepareNodes(svg)
  const gesture = trackGesture(viewport)
  let selected: DiagramNode | undefined
  const select = (node: DiagramNode | undefined) => {
    selected = node
    const count = highlightDiagram(svg, node?.id)
    for (const item of nodes) item.element.setAttribute('aria-pressed', String(item.id === node?.id))
    onSelection(node, count)
  }
  const nodeAt = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return
    const group = target.closest('[data-diagram-selectable]')
    return nodes.find((node) => node.element === group)
  }
  const click = (event: MouseEvent) => {
    if (!gesture.dragged() || event.detail === 0) select(nodeAt(event.target))
  }
  const keydown = (event: KeyboardEvent) => {
    const node = nodeAt(event.target)
    if (node !== undefined && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault()
      select(node)
    }
  }
  const hover = (event: PointerEvent) => {
    if (!matchMedia('(hover: hover) and (pointer: fine)').matches || gesture.dragging()) return
    highlightDiagram(svg, nodeAt(event.target)?.id ?? selected?.id)
  }
  const leave = () => highlightDiagram(svg, selected?.id)
  viewport.addEventListener('click', click)
  viewport.addEventListener('keydown', keydown)
  viewport.addEventListener('pointerover', hover)
  viewport.addEventListener('pointerleave', leave)
  return {
    clear: () => select(undefined),
    destroy: () => {
      gesture.destroy()
      viewport.removeEventListener('click', click)
      viewport.removeEventListener('keydown', keydown)
      viewport.removeEventListener('pointerover', hover)
      viewport.removeEventListener('pointerleave', leave)
    },
  }
}
