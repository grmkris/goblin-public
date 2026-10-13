/**
 * `bun scripts/wallet-og.ts`: Goblin Wallet's link preview, `apps/wallet-web/public/wallet-og.png` (1200×630), which
 * index.html names as its Open Graph and Twitter image. The goblin mark and the landing's headline on the shell's moss,
 * set in Geist (the face the app is set in) by headless Chromium, then packed by sharp. The file is committed; run this
 * again when the headline or the mark changes.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright-core'
import sharp from 'sharp'
import { GOBLIN_PATHS } from '../packages/ui/src/brand.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, 'apps/wallet-web/public/wallet-og.png')
const GEIST = readFileSync(
  path.join(ROOT, 'packages/ui/node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2'),
).toString('base64')
const [WIDTH, HEIGHT] = [1200, 630]

/** The theme's light shell tokens (packages/ui/src/styles.css): the field, its text, and the lichen of a chosen item. */
const MOSS = 'oklch(0.335 0.052 148)'
const ON_MOSS = 'oklch(0.965 0.014 110)'
const ON_MOSS_MUTED = 'oklch(0.82 0.03 125)'
const LICHEN = 'oklch(0.93 0.05 118)'
const ON_LICHEN = 'oklch(0.27 0.055 148)'

const mark = [
  `<svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="${ON_LICHEN}" stroke-width="1.75"`,
  ' stroke-linecap="round" stroke-linejoin="round">',
  ...GOBLIN_PATHS.map((d) => `<path d="${d}"/>`),
  '</svg>',
].join('')

const html = `<!doctype html><html><head><style>
@font-face { font-family: Geist; src: url(data:font/woff2;base64,${GEIST}) format('woff2'); font-weight: 100 900; }
* { margin: 0; box-sizing: border-box; }
body { width: ${WIDTH}px; height: ${HEIGHT}px; background: ${MOSS}; color: ${ON_MOSS}; font-family: Geist;
  -webkit-font-smoothing: antialiased; display: flex; flex-direction: column; justify-content: space-between;
  padding: 72px 80px 76px; }
.brand { display: flex; align-items: center; gap: 22px; font-size: 40px; font-weight: 640; letter-spacing: -0.015em; }
.tile { display: grid; place-items: center; width: 76px; height: 76px; border-radius: 22px; background: ${LICHEN}; }
h1 { font-size: 92px; font-weight: 680; line-height: 0.98; letter-spacing: -0.04em; max-width: 960px; }
p { margin-top: 28px; font-size: 30px; color: ${ON_MOSS_MUTED}; letter-spacing: -0.005em; }
</style></head><body>
<div class="brand"><span class="tile">${mark}</span>Goblin Wallet</div>
<div><h1>Your agent can pay.<br>Within limits you set.</h1><p>The wallet your AI agent pays from, in USDC.</p></div>
</body></html>`

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 })
  await page.setContent(html)
  // The script's own typings have no DOM; the page waits for Geist before the shot.
  await page.evaluate('document.fonts.ready.then(() => true)')
  const shot = await page.screenshot({ type: 'png' })
  const info = await sharp(shot).png({ compressionLevel: 9, palette: true, quality: 90 }).toFile(OUT)
  console.log(`${path.relative(ROOT, OUT)} ${String(info.width)}x${String(info.height)} ${String(info.size)} bytes`)
} finally {
  await browser.close()
}
