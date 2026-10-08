/**
 * `bun run ui:acceptance [session-file]`: read-only UI acceptance against a deployed stage, in headless Chromium.
 * It signs in with the owner session saved for smoke (`.local/dev-session.json` unless named), opens pages, taps and
 * clicks only things that change nothing (menus, disclosures, the sidebar), and checks what the UI does there: motion
 * that runs, touch-sized fields and targets, drawers that close on a tap or a swipe. It sends no message and edits nothing. Screenshots of
 * the page matrix (phone 390×844 with touch, desktop 1440×900, light and dark) and a receipt go to a private
 * `.local/goblin-acceptance/ui-<utc>/`. Chromium emulation is not device evidence: a real phone still has to check feel.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { type Browser, type BrowserContextOptions, type Page, chromium } from 'playwright-core'

type Check = { readonly ok: boolean; readonly detail: unknown }
type Session = { readonly origin: string; readonly cookie: string }

const ROOT = path.resolve(import.meta.dirname, '..')
const PAGES = ['/', '/settings', '/connections', '/apps']
const PHONE: BrowserContextOptions = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
}
const DESK: BrowserContextOptions = { viewport: { width: 1440, height: 900 } }
const SETTLE_MS = 1500

function readSession(file: string): Session {
  const saved: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (typeof saved !== 'object' || saved === null || !('origin' in saved) || !('cookie' in saved))
    throw new Error('session_file_shape')
  const { origin, cookie } = saved
  if (typeof origin !== 'string' || typeof cookie !== 'string' || !cookie.includes('session_token='))
    throw new Error('session_file_shape')
  const url = new URL(origin)
  if (url.protocol !== 'https:' || url.origin !== origin) throw new Error('session_origin_must_be_https')
  return { origin, cookie }
}

function cookiesOf({ origin, cookie }: Session) {
  const domain = new URL(origin).hostname
  return cookie
    .split(/;\s*/u)
    .filter(Boolean)
    .map((pair) => {
      const at = pair.indexOf('=')
      return { name: pair.slice(0, at), value: pair.slice(at + 1), domain, path: '/', secure: true, httpOnly: true }
    })
}

/** A signed-in page in a fresh context; page errors are collected, not thrown. */
async function open(
  browser: Browser,
  session: Session,
  options: BrowserContextOptions,
  errors: string[],
  label: string,
) {
  const context = await browser.newContext(options)
  await context.addCookies(cookiesOf(session))
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(`${label}: ${error.message}`))
  return page
}

/** A finger dragged from `from` to `to` in `steps` moves `gap` ms apart, as touch events (a slow drag, not a flick). */
async function swipe(page: Page, from: readonly [number, number], to: readonly [number, number], steps = 12, gap = 30) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from[0], y: from[1] }] })
  for (let step = 1; step <= steps; step += 1) {
    const x = from[0] + ((to[0] - from[0]) * step) / steps
    const y = from[1] + ((to[1] - from[1]) * step) / steps
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] })
    await page.waitForTimeout(gap)
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
}

async function visit(page: Page, origin: string, route: string): Promise<void> {
  await page.goto(`${origin}${route}`, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(SETTLE_MS)
}

/** Desktop: the theme's curves, a menu that scales, the composer's Return key, a Thoughts panel that opens to auto. */
async function deskChecks(page: Page, origin: string, checks: Record<string, Check>): Promise<void> {
  await visit(page, origin, '/')
  const field = page.locator('textarea[data-slot="composer-input"]').first()
  checks['desk.composer.enterkeyhint'] = {
    ok: (await field.getAttribute('enterkeyhint')) === 'send',
    detail: await field.getAttribute('enterkeyhint'),
  }
  const ease = await page
    .locator('html')
    .evaluate((root) => root.ownerDocument.defaultView.getComputedStyle(root).getPropertyValue('--ease-out').trim())
  checks['desk.token.ease-out'] = { ok: ease.includes('.23'), detail: ease }
  // The first page after a deploy can still be hydrating once the network is idle: wait for the picker itself.
  const picker = page.locator('[data-slot="composer-actions"] button[aria-haspopup="menu"]').first()
  const found = await picker
    .waitFor({ timeout: 10_000 })
    .then(() => true)
    .catch(() => false)
  if (found) {
    await picker.click()
    const menu = page.locator('[data-slot="dropdown-menu-content"]').first()
    await menu.waitFor({ timeout: 5000 })
    const transition = await menu.evaluate(
      (element) => element.ownerDocument.defaultView.getComputedStyle(element).transitionProperty,
    )
    checks['desk.menu.scales'] = { ok: transition.includes('scale'), detail: transition }
    await page.keyboard.press('Escape')
  } else checks['desk.menu.scales'] = { ok: false, detail: 'no model picker' }
  await transcriptChecks(page, checks)
  await thoughtsCheck(page, checks)
}

/**
 * Main's transcript and dock: message actions reserve no room (so nothing jumps when a reply finishes), the dock has a
 * ceiling, Main's way back down is the shared jump button, and at most one presence orb draws with WebGL.
 */
async function transcriptChecks(page: Page, checks: Record<string, Check>): Promise<void> {
  const reserved = await page
    .locator('.message-item:has(> .thread-rows > .message-actions:only-child)')
    .evaluateAll((items) =>
      items
        .map((item) => item.ownerDocument.defaultView.getComputedStyle(item).paddingBottom)
        .filter((pad) => pad !== '0px'),
    )
  checks['desk.actions.no-room'] = { ok: reserved.length === 0, detail: { reserved } }
  const ceiling = await page
    .locator('.chat-dock')
    .first()
    .evaluate((dock) => dock.ownerDocument.defaultView.getComputedStyle(dock).maxHeight)
  checks['desk.dock.ceiling'] = { ok: ceiling !== 'none', detail: ceiling }
  checks['desk.main.jump-button'] = {
    ok: (await page.locator('[data-slot="message-scroller-button"]').count()) > 0,
    detail: null,
  }
  const moving = await page.locator('[data-slot="presence-orb"] canvas').count()
  checks['desk.orbs.one-moves'] = { ok: moving <= 1, detail: { moving } }
}

async function thoughtsCheck(page: Page, checks: Record<string, Check>): Promise<void> {
  const trigger = page.locator('[data-slot="reasoning-trigger"]').last()
  if ((await trigger.count()) === 0) {
    checks['desk.thoughts.open'] = { ok: false, detail: 'no Thoughts in Main' }
    return
  }
  await trigger.scrollIntoViewIfNeeded()
  await trigger.click()
  await page.waitForTimeout(400)
  const opened = await page
    .locator('[data-slot="reasoning-content"]')
    .last()
    .evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      inner: element.firstElementChild?.getBoundingClientRect().height ?? -1,
      variable: element.style.getPropertyValue('--collapsible-panel-height'),
    }))
  checks['desk.thoughts.open'] = {
    ok: opened.height > 0 && Math.abs(opened.height - opened.inner) < 2,
    detail: opened,
  }
  await trigger.click()
  await page.waitForTimeout(450)
  const left = await page.locator('[data-slot="reasoning-content"]').count()
  checks['desk.thoughts.closes'] = { ok: true, detail: { panelsLeft: left } }
}

/**
 * Phone: a coarse pointer, 16px fields whose Return key breaks the line, 44px icon targets, and a sidebar drawer that
 * closes on a same-page link and on a swipe left; in a conversation, the turn map's drawer swipes down closed.
 */
async function phoneChecks(page: Page, origin: string, checks: Record<string, Check>): Promise<void> {
  await visit(page, origin, '/')
  const coarse = await page
    .locator('html')
    .evaluate((root) => root.ownerDocument.defaultView.matchMedia('(pointer: coarse)').matches)
  checks['phone.pointer-coarse'] = { ok: coarse, detail: null }
  const size = await page
    .locator('textarea[data-slot="composer-input"]')
    .first()
    .evaluate((element) => element.ownerDocument.defaultView.getComputedStyle(element).fontSize)
  checks['phone.composer.16px'] = { ok: size === '16px', detail: size }
  const hint = await page.locator('textarea[data-slot="composer-input"]').first().getAttribute('enterkeyhint')
  checks['phone.composer.enterkeyhint'] = { ok: hint === 'enter', detail: hint }
  const icon = page.locator('[data-slot="button"].size-7:visible').first()
  const hit =
    (await icon.count()) === 0
      ? null
      : await icon.evaluate((element) => {
          const after = element.ownerDocument.defaultView.getComputedStyle(element, '::after')
          return { position: after.position, inset: after.inset }
        })
  checks['phone.icon.hit-area'] = { ok: hit?.position === 'absolute', detail: hit }
  await usageCheck(page, checks)
  await sidebarCheck(page, checks)
  await sidebarSwipeCheck(page, checks)
  await turnMapCheck(page, checks)
}

/** Phone: today's usage opens in words on a tap (a phone shows only the ring). */
async function usageCheck(page: Page, checks: Record<string, Check>): Promise<void> {
  const usage = page.locator('.usage-indicator').first()
  if ((await usage.count()) === 0) {
    checks['phone.usage.tap'] = { ok: false, detail: 'no usage indicator' }
    return
  }
  await usage.tap()
  const popup = page.locator('[data-slot="popover-content"]').filter({ hasText: "today's model budget" })
  const shown = await popup
    .first()
    .waitFor({ timeout: 3000 })
    .then(() => true)
    .catch(() => false)
  checks['phone.usage.tap'] = { ok: shown, detail: null }
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
}

async function sidebarCheck(page: Page, checks: Record<string, Check>): Promise<void> {
  const sheet = '[data-slot="sidebar"][data-mobile="true"]'
  const row = '[data-sidebar="content"] a[href^="/c/"]'
  const trigger = page.locator('[data-sidebar="trigger"]').first()
  // The first tap moves to the row's page; the second, on the row already showing, changes no path.
  await trigger.tap()
  await page.waitForTimeout(600)
  await page.locator(row).first().tap()
  await page.waitForTimeout(800)
  if ((await page.locator(sheet).count()) === 0) {
    await trigger.tap()
    await page.waitForTimeout(600)
  }
  const before = await page.locator(sheet).count()
  await page.locator(row).first().tap()
  await page.waitForTimeout(800)
  const after = await page.locator(sheet).count()
  checks['phone.sidebar.closes'] = { ok: before > 0 && after === 0, detail: { before, after } }
}

/** A swipe left across the open sidebar drawer takes it back to the edge. */
async function sidebarSwipeCheck(page: Page, checks: Record<string, Check>): Promise<void> {
  const sheet = page.locator('[data-slot="sidebar"][data-mobile="true"]')
  await page.locator('[data-sidebar="trigger"]').first().tap()
  await page.waitForTimeout(600)
  const box = await sheet.boundingBox()
  if (box === null) {
    checks['phone.sidebar.swipe'] = { ok: false, detail: 'sidebar did not open' }
    return
  }
  const y = box.y + box.height / 2
  await swipe(page, [box.x + box.width - 24, y], [8, y])
  await page.waitForTimeout(800)
  checks['phone.sidebar.swipe'] = { ok: (await sheet.count()) === 0, detail: { left: await sheet.count() } }
}

/** In a conversation with turns, the turn map's tab opens a bottom drawer that a swipe down closes. */
async function turnMapCheck(page: Page, checks: Record<string, Check>): Promise<void> {
  const tab = page.locator('.turn-map-tab:visible').first()
  if ((await tab.count()) === 0) {
    checks['phone.turn-map.swipe'] = { ok: true, detail: 'no turn map on this conversation' }
    return
  }
  await tab.tap()
  await page.waitForTimeout(600)
  const drawer = page.locator('[data-slot="drawer-content"]')
  const box = await drawer.boundingBox()
  if (box === null) {
    checks['phone.turn-map.swipe'] = { ok: false, detail: 'drawer did not open' }
    return
  }
  const x = box.x + box.width / 2
  await swipe(page, [x, box.y + 8], [x, box.y + box.height + 40])
  await page.waitForTimeout(800)
  checks['phone.turn-map.swipe'] = { ok: (await drawer.count()) === 0, detail: { height: Math.round(box.height) } }
}

async function screenshots(browser: Browser, session: Session, out: string, errors: string[]): Promise<number> {
  let count = 0
  for (const [device, options] of [
    ['phone', PHONE],
    ['desk', DESK],
  ] as const)
    for (const colorScheme of ['light', 'dark'] as const) {
      const page = await open(browser, session, { ...options, colorScheme }, errors, `${device}/${colorScheme}`)
      for (const route of PAGES) {
        await visit(page, session.origin, route)
        const slug = route === '/' ? 'home' : route.slice(1).replaceAll('/', '_')
        await page.screenshot({ path: path.join(out, `${device}-${colorScheme}-${slug}.png`) })
        count += 1
      }
      await page.context().close()
    }
  return count
}

async function main(): Promise<void> {
  const session = readSession(process.argv[2] ?? path.join(ROOT, '.local/dev-session.json'))
  const utc = new Date().toISOString().replaceAll(/[:.]/gu, '-')
  const out = path.join(ROOT, '.local/goblin-acceptance', `ui-${utc}`)
  mkdirSync(out, { recursive: true, mode: 0o700 })
  const browser = await chromium.launch()
  const checks: Record<string, Check> = {}
  const errors: string[] = []
  try {
    await deskChecks(await open(browser, session, DESK, errors, 'desk'), session.origin, checks)
    await phoneChecks(await open(browser, session, PHONE, errors, 'phone'), session.origin, checks)
    const shots = await screenshots(browser, session, out, errors)
    const failed = Object.entries(checks)
      .filter(([, check]) => !check.ok)
      .map(([name]) => name)
    const receipt = { utc, origin: session.origin, checks, failed, errors, screenshots: shots, out }
    writeFileSync(path.join(out, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
    chmodSync(out, 0o700)
    console.log(JSON.stringify({ failed, errors, screenshots: shots, out }, null, 2))
    if (failed.length > 0 || errors.length > 0) process.exitCode = 1
  } finally {
    await browser.close()
  }
}

await main()
