/**
 * The startup images a Home Screen app shows while it opens on an iPhone or iPad. iOS uses one only when its media
 * query matches the screen exactly, so there is one per screen: CSS points (portrait) and pixel ratio, deduplicated by
 * that triple (from the apple-web-app skill's device table, checked 2026-09-04). `scripts/app-icons.ts` draws the
 * images from this table and the root route links them, so the two never drift apart.
 */
const SCREENS: readonly (readonly [width: number, height: number, ratio: number])[] = [
  [320, 568, 2],
  [375, 667, 2],
  [414, 736, 3],
  [375, 812, 3],
  [414, 896, 2],
  [414, 896, 3],
  [390, 844, 3],
  [428, 926, 3],
  [393, 852, 3],
  [430, 932, 3],
  [402, 874, 3],
  [440, 956, 3],
  [420, 912, 3],
  [768, 1024, 2],
  [810, 1080, 2],
  [820, 1180, 2],
  [744, 1133, 2],
  [834, 1112, 2],
  [834, 1194, 2],
  [834, 1210, 2],
  [1024, 1366, 2],
  [1032, 1376, 2],
]

/** Bump when the images change: iOS caches them hard, and a new URL is the only way past that cache. */
const VERSION = 1

export type StartupImage = {
  /** Under apps/web/public. */
  readonly file: string
  readonly href: string
  readonly media: string
  readonly pixels: { readonly width: number; readonly height: number }
}

/**
 * Two per screen, portrait and landscape. `device-width` and `device-height` stay the portrait points in both, as in
 * Apple's own examples: iOS reports the screen's portrait size whatever way it is held, and only the orientation
 * clause tells the two apart.
 */
export const startupImages = (): readonly StartupImage[] =>
  SCREENS.flatMap(([width, height, ratio]) =>
    (['portrait', 'landscape'] as const).map((orientation) => {
      const file = `splash/${width}x${height}@${ratio}-${orientation}.png`
      const [across, down] = orientation === 'portrait' ? [width, height] : [height, width]
      return {
        file,
        href: `/${file}?v=${VERSION}`,
        media: `(device-width: ${width}px) and (device-height: ${height}px) and (-webkit-device-pixel-ratio: ${ratio}) and (orientation: ${orientation})`,
        pixels: { width: across * ratio, height: down * ratio },
      }
    }),
  )
