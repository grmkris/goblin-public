import Panzoom from '@panzoom/panzoom'

/** Fitted drawing starts at 1x; bounds stay visible on either axis, including tall/narrow diagrams. */
export function diagramPan(viewport: HTMLDivElement, canvas: HTMLDivElement, onScale: (scale: number) => void) {
  const svg = canvas.querySelector('svg')
  if (!(svg instanceof SVGSVGElement)) return
  const { width, height } = svg.viewBox.baseVal
  if (width <= 0 || height <= 0) return
  let active = true
  let drawingWidth = 0
  let drawingHeight = 0
  const panzoom = Panzoom(canvas, {
    canvas: true,
    minScale: 1,
    maxScale: 4,
    panOnlyWhenZoomed: true,
    step: 0.3,
    cursor: 'grab',
    overflow: 'clip',
    animate: false,
    handleStartEvent: (event) => {
      // touch-action owns touch gestures; cancelling their pointerdown can swallow the next native button click.
      if (event instanceof PointerEvent && event.pointerType === 'touch') return
      event.preventDefault()
    },
    setTransform: (element, { x, y, scale }) => {
      // Panzoom schedules frames: ignore an old zoom frame after Fit or a later gesture.
      if (!active || scale !== panzoom.getScale()) return
      const maxX = Math.max(0, (drawingWidth * scale - viewport.clientWidth) / (2 * scale))
      const maxY = Math.max(0, (drawingHeight * scale - viewport.clientHeight) / (2 * scale))
      const boundedX = Math.min(maxX, Math.max(-maxX, x))
      const boundedY = Math.min(maxY, Math.max(-maxY, y))
      element.style.transform = `scale(${scale}) translate(${boundedX}px, ${boundedY}px)`
      if (x !== boundedX || y !== boundedY) panzoom.pan(boundedX, boundedY, { force: true, silent: true })
      onScale(scale)
    },
  })
  let previousSize = ''
  const fit = () => {
    if (!active) return
    const size = `${viewport.clientWidth}:${viewport.clientHeight}`
    if (size === previousSize) return
    previousSize = size
    const ratio = Math.min(1, (viewport.clientWidth - 32) / width, (viewport.clientHeight - 32) / height)
    drawingWidth = Math.max(1, width * ratio)
    drawingHeight = Math.max(1, height * ratio)
    svg.style.inlineSize = `${drawingWidth}px`
    svg.style.blockSize = `${drawingHeight}px`
    panzoom.reset({ animate: false })
  }
  fit()
  const observer = new ResizeObserver(fit)
  observer.observe(viewport)
  const wheel = (event: WheelEvent) => panzoom.zoomWithWheel(event)
  viewport.addEventListener('wheel', wheel, { passive: false })
  const keydown = (event: KeyboardEvent) => {
    const directions: Record<string, readonly [number, number]> = {
      ArrowLeft: [40, 0],
      ArrowRight: [-40, 0],
      ArrowUp: [0, 40],
      ArrowDown: [0, -40],
    }
    const direction = directions[event.key]
    if (direction !== undefined) {
      event.preventDefault()
      panzoom.pan(direction[0] / panzoom.getScale(), direction[1] / panzoom.getScale(), { relative: true })
    }
  }
  viewport.addEventListener('keydown', keydown)
  return {
    fit: () => panzoom.reset({ animate: false }),
    zoomIn: () => panzoom.zoomIn({ animate: false }),
    zoomOut: () => panzoom.zoomOut({ animate: false }),
    destroy: () => {
      active = false
      observer.disconnect()
      viewport.removeEventListener('wheel', wheel)
      viewport.removeEventListener('keydown', keydown)
      panzoom.destroy()
    },
  }
}
