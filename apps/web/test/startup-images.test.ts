import { describe, expect, it } from 'vitest'
import { startupImages } from '../src/lib/startup-images.ts'

describe('startup images', () => {
  const images = startupImages()

  it('has one portrait and one landscape image per screen, never the same file twice', () => {
    expect(images).toHaveLength(44)
    expect(new Set(images.map((image) => image.file)).size).toBe(images.length)
    expect(new Set(images.map((image) => image.media)).size).toBe(images.length)
  })

  it('sizes each image in pixels, landscape turned, and keeps the portrait points in the media query', () => {
    const portrait = images.find((image) => image.file === 'splash/393x852@3-portrait.png')
    const landscape = images.find((image) => image.file === 'splash/393x852@3-landscape.png')
    expect(portrait?.pixels).toEqual({ width: 1179, height: 2556 })
    expect(landscape?.pixels).toEqual({ width: 2556, height: 1179 })
    expect(landscape?.media).toBe(
      '(device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3) and (orientation: landscape)',
    )
    expect(portrait?.href).toMatch(/^\/splash\/393x852@3-portrait\.png\?v=\d+$/u)
  })
})
