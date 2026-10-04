// Where the App stage sits in each display mode. Pure: the stage component feeds it measured rects and the viewport.
import type { McpUiDisplayMode } from '@modelcontextprotocol/ext-apps/app-bridge'
import type { Point } from './spring.ts'

export type Rect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

/** The visible area: the header's height on top, the safe area at the bottom. */
export type Viewport = { readonly width: number; readonly height: number; readonly top: number }

/** The host's own bar above every App: title, display modes and close. Apps cannot draw over it. */
export const CHROME_HEIGHT = 36

const MARGIN = 16

export function pipSize(viewport: Viewport): { readonly width: number; readonly height: number } {
  const width = Math.min(380, viewport.width - 2 * MARGIN)
  return { width, height: CHROME_HEIGHT + Math.round(width * 0.62) }
}

/** The four corners picture-in-picture rests in, below the header. */
export function pipCorners(viewport: Viewport): [Point, Point, Point, Point] {
  const { width, height } = pipSize(viewport)
  const left = MARGIN
  const right = viewport.width - width - MARGIN
  const top = viewport.top + MARGIN
  const bottom = viewport.height - height - MARGIN
  return [
    { x: right, y: top },
    { x: left, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ]
}

/** The bottom sheet's resting heights on a phone: half the screen, and all of it under the header. */
export function sheetSnaps(viewport: Viewport): [number, number] {
  return [Math.round(viewport.height * 0.5), Math.round(viewport.height - viewport.top - 8)]
}

export function sheetRect(viewport: Viewport, height: number): Rect {
  return { x: 0, y: viewport.height - height, width: viewport.width, height }
}

/** The right panel's width: at least 360px, and never so wide that the conversation drops below 420px. */
export function panelWidth(wanted: number, viewport: Viewport): number {
  return Math.round(Math.max(360, Math.min(wanted, viewport.width - 420)))
}

/** What the stage measured this frame: the inline slot and the panel, when they are on screen. */
export type Measured = {
  readonly viewport: Viewport
  readonly phone: boolean
  readonly inline?: Rect | undefined
  readonly panel?: Rect | undefined
  readonly pip: Point
  readonly sheet: number
}

/** The stage's rect for `mode`, or nothing when the App has nowhere to be shown right now. */
export function stageRect(mode: McpUiDisplayMode, measured: Measured): Rect | undefined {
  if (mode === 'inline') return measured.inline
  if (mode === 'pip') return { ...measured.pip, ...pipSize(measured.viewport) }
  return measured.phone ? sheetRect(measured.viewport, measured.sheet) : measured.panel
}
