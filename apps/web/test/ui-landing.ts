/**
 * Local browser look at goblin's landing (`/`, signed out) against its real source components, at phone and desktop
 * widths in light and dark: the hero's session playing, waiting on its question, answered by pressing Allow or on its
 * own, and at its end; the page in full; and, under reduced motion, the session already at its question, with Allow
 * still answering it. `/health` and the session check are routed here; no account is made. It checks the way in, the
 * Goblin Wallet's address from `/health`, that a signed-in session leaves for its channel, and that nothing scrolls
 * sideways, and keeps screenshots.
 *
 *   heavy bun apps/web/test/ui-landing.ts [--out <dir>]
 */
import assert from 'node:assert/strict'
import { mkdirSync, writeSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { createServer } from 'vite'
import { type Browser, type BrowserContextOptions, type Page, chromium } from 'playwright-core'

const STDOUT = 1
const { values: options } = parseArgs({ options: { out: { type: 'string' } } })
const out =
  options.out ?? path.resolve(import.meta.dirname, '../../../.local/goblin-acceptance', `landing-${Date.now()}`)
mkdirSync(out, { recursive: true, mode: 0o700 })

const WALLET = 'https://wallet-dev.goblin.surf'
const HEALTH = {
  ok: true,
  service: 'goblin',
  stage: 'dev',
  signup: 'invite',
  mail: true,
  plans: [
    { id: 'day', amountUsd: '1.00', periodDays: 1 },
    { id: 'month', amountUsd: '15.00', periodDays: 30 },
  ],
  walletOrigin: WALLET,
}
const errors: string[] = []

/** A page of the fixture with `/health` and Better Auth's session answered: signed out unless `signedIn`. */
async function open(browser: Browser, origin: string, label: string, context: BrowserContextOptions, signedIn = false) {
  const page = await browser.newPage(context)
  page.on('pageerror', (error) => errors.push(`${label}: ${error.message}`))
  page.on('response', (response) => {
    if (response.status() >= 400) errors.push(`${label}: ${String(response.status())} ${response.url()}`)
  })
  await page.route('**/health', (route) => route.fulfill({ json: HEALTH }))
  await page.route('**/api/auth/get-session', (route) =>
    route.fulfill({
      json: signedIn ? { session: { id: 's', userId: 'u' }, user: { id: 'u', email: 'owner@example.com' } } : null,
    }),
  )
  await page.goto(`${origin}landing.html`)
  await page.locator('.hero-session').waitFor()
  return page
}

async function noSideways(page: Page, label: string) {
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  assert(sideways <= 0, `${label}: scrolls sideways by ${String(sideways)}px`)
}

/** The page as a visitor meets it: the session plays, waits, is answered (`press` Allow, or left to answer itself). */
async function drive(browser: Browser, origin: string, label: string, context: BrowserContextOptions, press: boolean) {
  const page = await open(browser, origin, label, context)
  const phone = context.isMobile === true
  // A phone shows the copy first: the session is looked at where the panel is, as a visitor scrolls to it.
  const shoot = async (name: string) => {
    if (phone) await page.locator('.moss-frame-panel').scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(out, `${label}-${name}.png`) })
  }
  await page.screenshot({ path: path.join(out, `${label}-first.png`) })
  await page.waitForTimeout(1500)
  await shoot('hero-playing')
  // The question is on screen once the orb waits on the owner (the Allow button is laid out, unseen, from the start).
  await page.getByText('Waiting for you').waitFor()
  await page.waitForTimeout(500)
  await shoot('hero-asking')
  const allow = page.getByRole('button', { name: 'Allow' })
  if (press) await allow.click()
  else await allow.scrollIntoViewIfNeeded()
  await page.getByText('Allowed.', { exact: false }).waitFor({ timeout: press ? 3000 : 9000 })
  await page.locator('.hero-final[data-shown]').waitFor()
  await page.waitForTimeout(600)
  await shoot('hero-done')
  await page.evaluate(() => window.scrollTo(0, 0))
  // The way in, the wallet's address from /health, the command for this origin, and mainnet's receipts.
  assert.equal(await page.getByRole('link', { name: 'Meet your goblin' }).first().getAttribute('href'), '/login?new=1')
  assert.equal(await page.getByRole('link', { name: 'Open Goblin Wallet' }).first().getAttribute('href'), WALLET)
  assert.match(
    (await page.locator('.landing-command code').textContent()) ?? '',
    /^claude mcp add --transport http goblin http:\/\/127\.0\.0\.1:\d+\/mcp$/u,
  )
  assert.equal(await page.locator('a[href^="https://basescan.org/tx/0x"]').count(), 4)
  assert.equal(await page.getByRole('link', { name: 'Source' }).count(), 0)
  await noSideways(page, label)
  // Below the fold the screenshots load lazily: scroll through once so the whole page has them.
  for (const shot of await page.locator('.landing-shot img').all()) {
    await shot.scrollIntoViewIfNeeded()
    await shot.evaluate((image: HTMLImageElement) => image.decode())
  }
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: path.join(out, `${label}-page.png`), fullPage: true })
  await page.close()
}

/** Under reduced motion the session is already at its question, nothing slides, and Allow still answers it. */
async function still(browser: Browser, origin: string, label: string, context: BrowserContextOptions) {
  const page = await open(browser, origin, label, { ...context, reducedMotion: 'reduce' })
  const allow = page.getByRole('button', { name: 'Allow' })
  await allow.waitFor({ state: 'visible', timeout: 1000 })
  assert.equal(await page.getByText('Asking Ferryhopper…').isVisible(), false)
  await page.locator('.moss-frame').screenshot({ path: path.join(out, `${label}-hero-still.png`) })
  await allow.click()
  await page.getByText('Allowed.', { exact: false }).waitFor({ timeout: 2000 })
  await page.locator('.hero-final[data-shown]').waitFor({ timeout: 2000 })
  await page.locator('.moss-frame').screenshot({ path: path.join(out, `${label}-hero-still-done.png`) })
  await noSideways(page, label)
  await page.close()
}

/** A session the check finds signed in leaves the landing for its channel. */
async function leavesWhenSignedIn(browser: Browser, origin: string) {
  const page = await open(browser, origin, 'signed-in', { viewport: { width: 1280, height: 800 } }, true)
  await page.locator('#channel').waitFor({ timeout: 3000 })
  await page.close()
}

const vite = await createServer({ configFile: path.join(import.meta.dirname, 'browser/vite.config.ts') })
await vite.listen()
const origin = vite.resolvedUrls?.local[0]
assert(origin, 'missing browser fixture origin')
const browser = await chromium.launch()
const phone = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }
const desktop = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 }
try {
  await drive(browser, origin, 'phone-light', { ...phone, colorScheme: 'light' }, true)
  await drive(browser, origin, 'desktop-dark', { ...desktop, colorScheme: 'dark' }, false)
  await drive(browser, origin, 'phone-dark', { ...phone, colorScheme: 'dark' }, false)
  await drive(browser, origin, 'desktop-light', { ...desktop, colorScheme: 'light' }, true)
  await still(browser, origin, 'phone-light-reduced', { ...phone, colorScheme: 'light' })
  await still(browser, origin, 'desktop-dark-reduced', { ...desktop, colorScheme: 'dark' })
  await leavesWhenSignedIn(browser, origin)
  assert.deepEqual(errors, [])
  writeSync(STDOUT, `${JSON.stringify({ ok: true, out })}\n`)
} finally {
  await browser.close()
  await vite.close()
}
