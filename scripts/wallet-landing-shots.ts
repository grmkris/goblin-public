/**
 * `bun scripts/wallet-landing-shots.ts [out-dir]`: a local browser look at Goblin Wallet's public landing (`/` signed
 * out, `apps/wallet-web/src/pages/landing`), run on the app's fixtures (`?fixtures=signed-out`): no Privy, no API.
 * Phone 390×844 and desktop 1280×800, light and dark, and the settled story with reduced motion. It checks that no
 * page scrolls sideways, that the hero's ask can be approved by hand and settles by itself when left alone, and that a
 * deep link keeps the plain sign-in; it keeps full-page screenshots (default `.local/goblin-acceptance/wallet-landing-*`).
 * Chromium emulation is not device evidence: a real phone still checks feel.
 */
import assert from 'node:assert/strict'
import { mkdirSync, writeSync } from 'node:fs'
import path from 'node:path'
import { type Browser, type BrowserContextOptions, chromium, type Page } from 'playwright-core'
import { createServer } from 'vite'

const STDOUT = 1
const ROOT = path.resolve(import.meta.dirname, '..')
const APP = path.join(ROOT, 'apps/wallet-web')
const out = path.resolve(process.argv[2] ?? path.join(ROOT, '.local/goblin-acceptance', `wallet-landing-${Date.now()}`))
mkdirSync(out, { recursive: true, mode: 0o700 })

const PHONE: BrowserContextOptions = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }
const DESK: BrowserContextOptions = { viewport: { width: 1280, height: 800 } }

const errors: string[] = []

async function open(browser: Browser, origin: string, at: string, label: string, options: BrowserContextOptions) {
  const page = await browser.newPage(options)
  page.on('pageerror', (error) => errors.push(`${label}: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`${label}: ${message.text()}`)
  })
  await page.goto(`${origin}${at}`)
  return page
}

async function sideways(page: Page, label: string): Promise<void> {
  const by = await page
    .locator('html')
    .evaluate((root) => root.scrollWidth - (root.ownerDocument.defaultView?.innerWidth ?? 0))
  assert(by <= 0, `${label}: scrolls sideways by ${String(by)}px`)
}

const shot = (page: Page, name: string) => page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true })

/** The landing in one viewport and scheme: the ask approved by hand, the whole page kept. */
async function landing(browser: Browser, origin: string, name: string, options: BrowserContextOptions) {
  const page = await open(browser, origin, '/?fixtures=signed-out', name, options)
  await page.getByRole('heading', { level: 1 }).waitFor()
  const approve = page.getByRole('button', { name: 'Approve' })
  await approve.waitFor({ state: 'visible' })
  // The row's fade (320ms) finishes before the frame is kept.
  await page.waitForTimeout(400)
  await page.screenshot({ path: path.join(out, `${name}-asking.png`) })
  await approve.click()
  await page.getByText('On Base, gas 0.0073 USDC').waitFor()
  await sideways(page, name)
  await shot(page, name)
  await page.close()
}

/** Left alone, the ask approves itself; with less motion, the story is settled from the first frame. */
async function selfSettling(browser: Browser, origin: string) {
  const idle = await open(browser, origin, '/?fixtures=signed-out', 'idle', DESK)
  await idle.getByText('On Base, gas 0.0073 USDC').waitFor({ timeout: 15_000 })
  await idle.close()
  const still = await open(browser, origin, '/?fixtures=signed-out', 'reduced', {
    ...PHONE,
    reducedMotion: 'reduce',
    colorScheme: 'light',
  })
  await still.getByText('On Base, gas 0.0073 USDC').waitFor({ timeout: 1000 })
  await sideways(still, 'reduced')
  await shot(still, 'phone-reduced-motion')
  await still.close()
}

/** A deep link keeps the plain sign-in: nobody who came to approve scrolls past the pitch. */
async function deepLink(browser: Browser, origin: string) {
  const page = await open(browser, origin, '/approve/op_1?fixtures=signed-out', 'deep-link', PHONE)
  await page.getByRole('heading', { name: 'Goblin Wallet' }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Approve' }).count(), 0, 'deep link shows the landing')
  await page.close()
}

const vite = await createServer({ root: APP, configFile: path.join(APP, 'vite.config.ts'), server: { port: 28_980 } })
await vite.listen()
const origin = vite.resolvedUrls?.local[0]?.replace(/\/$/u, '')
assert(origin, 'missing wallet-web origin')
const browser = await chromium.launch()
try {
  await landing(browser, origin, 'phone-light', { ...PHONE, colorScheme: 'light' })
  await landing(browser, origin, 'phone-dark', { ...PHONE, colorScheme: 'dark' })
  await landing(browser, origin, 'desktop-light', { ...DESK, colorScheme: 'light' })
  await landing(browser, origin, 'desktop-dark', { ...DESK, colorScheme: 'dark' })
  await selfSettling(browser, origin)
  await deepLink(browser, origin)
  assert.deepEqual(errors, [])
  writeSync(STDOUT, `${JSON.stringify({ ok: true, out })}\n`)
} finally {
  await browser.close()
  await vite.close()
}
