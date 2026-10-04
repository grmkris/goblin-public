import { describe, expect, it } from 'vitest'
import {
  CHROME_HEIGHT,
  panelWidth,
  pipCorners,
  pipSize,
  sheetSnaps,
  stageRect,
  type Viewport,
} from '../src/lib/app-stage.ts'

const desktop: Viewport = { width: 1440, height: 900, top: 56 }
const phone: Viewport = { width: 390, height: 844, top: 56 }

describe('where the App stage sits', () => {
  it('rests picture-in-picture in four corners below the header, sized for the screen', () => {
    expect(pipSize(desktop)).toEqual({ width: 380, height: CHROME_HEIGHT + 236 })
    expect(pipSize(phone).width).toBe(358)
    const [topRight, topLeft, bottomRight] = pipCorners(desktop)
    expect(topRight).toEqual({ x: 1044, y: 72 })
    expect(topLeft).toEqual({ x: 16, y: 72 })
    expect(bottomRight.y + pipSize(desktop).height).toBe(884)
  })
  it('snaps the phone sheet to half and to full height under the header', () => {
    expect(sheetSnaps(phone)).toEqual([422, 780])
  })
  it('keeps the panel wide enough to use without crowding out the conversation', () => {
    expect(panelWidth(200, desktop)).toBe(360)
    expect(panelWidth(1200, desktop)).toBe(1020)
    expect(panelWidth(520, desktop)).toBe(520)
  })
  it('follows the slot inline and the panel on desktop, and becomes a sheet on a phone', () => {
    const slot = { x: 300, y: 400, width: 840, height: 480 }
    const panel = { x: 960, y: 56, width: 480, height: 844 }
    const measured = { viewport: desktop, phone: false, inline: slot, panel, pip: { x: 16, y: 72 }, sheet: 422 }
    expect(stageRect('inline', measured)).toBe(slot)
    expect(stageRect('fullscreen', measured)).toBe(panel)
    expect(stageRect('pip', measured)).toEqual({ x: 16, y: 72, ...pipSize(desktop) })
    expect(stageRect('fullscreen', { ...measured, viewport: phone, phone: true })).toEqual({
      x: 0,
      y: 422,
      width: 390,
      height: 422,
    })
    expect(stageRect('inline', { ...measured, inline: undefined })).toBeUndefined()
  })
})
