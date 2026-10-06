/**
 * `bun run icons`: the app's icons, drawn from the one cat mark (lucide's `cat`, ISC) so the sizes never drift apart.
 * Writes committed files to apps/web/public: the 180px Home Screen icon iOS uses, the manifest's 192/512/1024 icons and
 * a maskable one for Android (the mark inside its safe zone), all on the page's opaque background, which iOS needs
 * (it composites transparency on black), an SVG favicon that follows the light or dark scheme, and the startup image
 * for every iPhone and iPad screen a Home Screen app opens on (apps/web/src/lib/startup-images.ts).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import sharp from 'sharp'
import { startupImages } from '../apps/web/src/lib/startup-images.ts'

const OUT = resolve(import.meta.dirname, '../apps/web/public')
/** The light theme's --background and --foreground, and the dark --foreground (packages/ui/src/styles.css). */
const PAPER = '#fafaf9'
const INK = '#0d1014'
const INK_DARK = '#ecebe8'
/** lucide's cat on its 24-unit grid. */
const CAT = [
  'M12 5c.67 0 1.35.09 2 .26 1.78-2 5.03-2.84 6.42-2.26 1.4.58-.42 7-.42 7 .57 1.07 1 2.24 1 3.44C21 17.9 16.97 21 12 21s-9-3-9-7.56c0-1.25.5-2.4 1-3.44 0 0-1.89-6.42-.5-7 1.39-.58 4.72.23 6.5 2.23A9.04 9.04 0 0 1 12 5Z',
  'M8 14v.5',
  'M16 14v.5',
  'M11.25 16.25h1.5L12 17l-.75-.75Z',
]
const STROKE = 'fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'
const paths = CAT.map((d) => `<path d="${d}"/>`).join('')

/** The mark centred on an opaque square, `scale` of its side. */
function square(size: number, scale: number): string {
  const glyph = size * scale
  const offset = (size - glyph) / 2
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
    `<rect width="${size}" height="${size}" fill="${PAPER}"/>`,
    `<g transform="translate(${offset} ${offset}) scale(${glyph / 24})" stroke="${INK}" ${STROKE}>${paths}</g>`,
    '</svg>',
  ].join('')
}

/**
 * A startup image: the page's background, which the first paint keeps, with the mark small at its centre, clear of the
 * status bar, the notch and the home indicator on every screen.
 */
function splash(width: number, height: number): string {
  const glyph = Math.round(Math.min(width, height) * 0.16)
  const [x, y] = [(width - glyph) / 2, (height - glyph) / 2]
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" fill="${PAPER}"/>`,
    `<g transform="translate(${x} ${y}) scale(${glyph / 24})" stroke="${INK}" ${STROKE}>${paths}</g>`,
    '</svg>',
  ].join('')
}

const FAVICON = [
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ${STROKE}>`,
  `<style>g{stroke:${INK}}@media (prefers-color-scheme:dark){g{stroke:${INK_DARK}}}</style>`,
  `<g>${paths}</g></svg>`,
].join('')

const PNGS: readonly (readonly [string, number, number])[] = [
  ['apple-touch-icon.png', 180, 0.6],
  ['icon-192.png', 192, 0.6],
  ['icon-512.png', 512, 0.6],
  ['icon-1024.png', 1024, 0.6],
  // Android crops a maskable icon to a circle 80% wide: the mark stays well inside it.
  ['icon-maskable-512.png', 512, 0.46],
]

mkdirSync(OUT, { recursive: true })
for (const [name, size, scale] of PNGS) {
  await sharp(Buffer.from(square(size, scale)))
    .png({ compressionLevel: 9 })
    .toFile(resolve(OUT, name))
  console.log(`${name} ${size}x${size}`)
}
writeFileSync(resolve(OUT, 'favicon.svg'), `${FAVICON}\n`)
console.log('favicon.svg')
mkdirSync(resolve(OUT, 'splash'), { recursive: true })
for (const image of startupImages()) {
  const { width, height } = image.pixels
  await sharp(Buffer.from(splash(width, height)))
    .png({ compressionLevel: 9, palette: true })
    .toFile(resolve(OUT, image.file))
}
console.log(`splash/ ${startupImages().length} startup images`)
