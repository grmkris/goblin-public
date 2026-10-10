/**
 * `bun run ui:acceptance [session-file]`: read-only UI acceptance of the Slack-style shell, in headless Chromium,
 * against a deployed stage (or the local stack). It signs in with the owner session saved for smoke
 * (`.local/dev-session.json` unless named), opens pages, taps and clicks only things that change nothing (menus,
 * disclosures, the navigation drawer, a thread's panel), and checks what the UI does there: motion that runs,
 * touch-sized fields and targets, drawers that close on a tap or a swipe, a panel beside the channel on a desktop and a
 * full view on a phone, and no page wider than the screen. It sends no message and edits nothing. Screenshots of the
 * page matrix (a channel, a thread's panel, Threads, Activity, Tasks, Settings, Connections, Apps; phone 390×844 with
 * touch, landscape, tablet, desktop 1440×900; light and dark) and a receipt go to a private
 * `.local/goblin-acceptance/ui-<utc>/`. Chromium emulation is not device evidence: a real phone still checks feel.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { type Browser, type BrowserContextOptions, type Page, chromium } from 'playwright-core'
import { readSession, type Session } from './session.ts'

type Check = { readonly ok: boolean; readonly detail: unknown } | { readonly skipped: true; readonly detail: unknown }

const ROOT = path.resolve(import.meta.dirname, '..')
const PAGES = ['/c/1', '/threads', '/activity', '/tasks', '/settings', '/connections', '/apps']
const PHONE: BrowserContextOptions = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
}
const DESK: BrowserContextOptions = { viewport: { width: 1440, height: 900 } }
const SETTLE_MS = 1500

const skipped = (detail: unknown): Check => ({ skipped: true, detail })

function cookiesOf({ origin, cookie }: Session) {
  const { hostname: domain, protocol } = new URL(origin)
  const secure = protocol === 'https:'
  return cookie
    .split(/;\s*/u)
    .filter(Boolean)
    .map((pair) => {
      const at = pair.indexOf('=')
      return { name: pair.slice(0, at), value: pair.slice(at + 1), domain, path: '/', secure, httpOnly: true }
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

/**
 * An open thread of the account, as a link to its own `/c/<id>` (which opens its channel with the panel), if it has
 * one: the first snapshot of the workspace feed the page itself follows.
 */
async function threadRoute(page: Page): Promise<string | undefined> {
  const id = await page.evaluate(
    () =>
      new Promise<string | undefined>((resolve) => {
        // The page's own EventSource; the script's Bun typings give its constructor no URL.
        const Feed: new (url: string) => {
          addEventListener: (type: string, listener: (event: { readonly data: string }) => void) => void
          close: () => void
        } = EventSource
        const feed = new Feed('/api/workspace/events')
        const settle = (found: string | undefined) => {
          feed.close()
          resolve(found)
        }
        feed.addEventListener('snapshot', (event) => {
          const snapshot: { conversations?: { id?: unknown; kind?: string; closedAt?: number }[] } = JSON.parse(
            event.data,
          )
          const thread = snapshot.conversations?.find((view) => view.kind === 'thread' && view.closedAt === undefined)
          settle(typeof thread?.id === 'string' ? thread.id : undefined)
        })
        feed.addEventListener('error', () => settle(undefined))
        setTimeout(() => settle(undefined), 10_000)
      }),
  )
  return id === undefined ? undefined : `/c/${id}`
}

/**
 * A thread's panel: beside the channel (or over its right side) wherever the navigation shows, a full view of its own
 * on a phone.
 */
async function panelCheck(page: Page, origin: string, checks: Record<string, Check>, prefix: string): Promise<void> {
  const route = await threadRoute(page)
  if (route === undefined) {
    checks[`${prefix}.panel`] = skipped('no thread in this account snapshot')
    return
  }
  await visit(page, origin, route)
  const panel = page.locator('.thread-panel').first()
  const shown = await panel
    .waitFor({ timeout: 10_000 })
    .then(() => true)
    // expected: a timeout means it did not show, which the check records
    .catch(() => false)
  if (!shown) {
    checks[`${prefix}.panel`] = { ok: false, detail: 'the panel did not open' }
    return
  }
  const box = await panel.evaluate((element) => ({
    width: Math.round(element.getBoundingClientRect().width),
    viewport: element.ownerDocument.defaultView?.innerWidth ?? 0,
    search: element.ownerDocument.location.search,
  }))
  const channel = await page.locator('.channel-column').first().isVisible()
  // A phone gives the panel the whole screen. Wider, the navigation stays: the panel sits beside the channel, over its
  // right side, or over all of it where the channel is too narrow to share (then the channel itself is hidden).
  const phone = box.viewport < 768
  checks[`${prefix}.panel`] = {
    ok: box.search.includes('thread=') && (phone ? box.width === box.viewport : box.width < box.viewport),
    detail: { ...box, channel },
  }
}

/** Desktop: the theme's curves, a menu that scales, the composer's Return key, a Thoughts panel that opens to auto. */
async function deskChecks(page: Page, origin: string, checks: Record<string, Check>): Promise<void> {
  await visit(page, origin, '/c/1')
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
    // expected: a timeout means it did not show, which the check records
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
  } else checks['desk.menu.scales'] = skipped('no model picker in this account snapshot')
  await transcriptChecks(page, checks)
  await thoughtsCheck(page, checks)
  await panelCheck(page, origin, checks, 'desk')
}

/**
 * The channel's transcript and dock: message actions float and reserve no room (so nothing jumps when a reply finishes),
 * the dock has a ceiling, the way back down is the shared jump button, and at most one presence orb draws with WebGL.
 */
async function transcriptChecks(page: Page, checks: Record<string, Check>): Promise<void> {
  const reserved = await page
    .locator('.message-item > .message-actions')
    .evaluateAll((items) =>
      items
        .map((item) => item.ownerDocument.defaultView.getComputedStyle(item).position)
        .filter((position) => position !== 'absolute'),
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
    checks['desk.thoughts.open'] = skipped('no Thoughts in Main in this account snapshot')
    checks['desk.thoughts.closes'] = skipped('no Thoughts in Main in this account snapshot')
    return
  }
  await trigger.scrollIntoViewIfNeeded()
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click()
  await page.waitForTimeout(400)
  const panel = trigger.locator('..').locator('[data-slot="reasoning-content"]')
  const opened = await panel.evaluate((element) => ({
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
  const closed =
    (await panel.count()) === 0
      ? { removed: true }
      : await panel.evaluate((element) => ({
          removed: false,
          height: element.getBoundingClientRect().height,
          hidden: element.hasAttribute('hidden'),
        }))
  checks['desk.thoughts.closes'] = {
    ok: closed.removed || ('height' in closed && (closed.hidden || closed.height < 1)),
    detail: closed,
  }
}

/**
 * Phone: a coarse pointer, 16px fields whose Return key breaks the line, 44px icon targets, and a sidebar drawer that
 * closes on a same-page link and on a swipe left; in a conversation, the turn map's drawer swipes down closed.
 */
async function phoneChecks(page: Page, origin: string, checks: Record<string, Check>, prefix = 'phone'): Promise<void> {
  await visit(page, origin, '/c/1')
  const coarse = await page
    .locator('html')
    .evaluate((root) => root.ownerDocument.defaultView.matchMedia('(pointer: coarse), (any-pointer: coarse)').matches)
  checks[`${prefix}.pointer-coarse`] = { ok: coarse, detail: null }
  const size = await page
    .locator('textarea[data-slot="composer-input"]')
    .first()
    .evaluate((element) => element.ownerDocument.defaultView.getComputedStyle(element).fontSize)
  checks[`${prefix}.composer.16px`] = { ok: size === '16px', detail: size }
  const hint = await page.locator('textarea[data-slot="composer-input"]').first().getAttribute('enterkeyhint')
  checks[`${prefix}.composer.enterkeyhint`] = { ok: hint === 'enter', detail: hint }
  await editableChecks(page, checks, prefix)
  const icon = page.locator('[data-slot="button"].size-7:visible').first()
  const hit =
    (await icon.count()) === 0
      ? null
      : await icon.evaluate((element) => {
          const after = element.ownerDocument.defaultView.getComputedStyle(element, '::after')
          return { position: after.position, inset: after.inset }
        })
  checks[`${prefix}.icon.hit-area`] =
    hit === null ? skipped('no small icon control on this page') : { ok: hit.position === 'absolute', detail: hit }
  await usageCheck(page, checks, prefix)
  const narrow = await page
    .locator('html')
    .evaluate((root) => root.ownerDocument.defaultView.matchMedia('(max-width: 767px)').matches)
  if (narrow) {
    await sidebarCheck(page, checks, prefix)
    await sidebarSwipeCheck(page, checks, prefix)
  } else {
    checks[`${prefix}.sidebar.closes`] = skipped('this viewport uses the desktop sidebar')
    checks[`${prefix}.sidebar.swipe`] = skipped('this viewport uses the desktop sidebar')
  }
  await turnMapCheck(page, checks, prefix)
  await panelCheck(page, origin, checks, prefix)
}

async function editableChecks(page: Page, checks: Record<string, Check>, prefix: string): Promise<void> {
  const editable = await page.locator('input, textarea, select').evaluateAll((items) =>
    items
      // A checkbox, radio or range has no text whose size matters.
      .filter((element) => element.getBoundingClientRect().height > 0)
      .filter((element) => !['checkbox', 'radio', 'range'].includes(element.getAttribute('type') ?? ''))
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        type: element.getAttribute('type'),
        code: element.getAttribute('data-variant') === 'code',
        font: Number.parseFloat(element.ownerDocument.defaultView?.getComputedStyle(element).fontSize ?? '0'),
      })),
  )
  checks[`${prefix}.editable.readable`] =
    editable.length === 0
      ? skipped('no visible editable controls')
      : {
          ok: editable.every(({ font, code }) => font >= 16 && (!code || font === 18)),
          detail: editable,
        }
  if (!editable.some(({ code }) => code))
    checks[`${prefix}.code.18px`] = skipped('no sign-in code input on this page; local fixture covers it')
}

/** Phone: today's usage opens in words on a tap (a phone shows only the ring). */
async function usageCheck(page: Page, checks: Record<string, Check>, prefix: string): Promise<void> {
  const usage = page.locator('.usage-indicator').first()
  if ((await usage.count()) === 0) {
    checks[`${prefix}.usage.tap`] = skipped('no usage indicator in this account snapshot')
    return
  }
  await usage.click()
  const popup = page.locator('[data-slot="popover-content"]').filter({ hasText: "today's model budget" })
  const shown = await popup
    .first()
    .waitFor({ timeout: 3000 })
    .then(() => true)
    // expected: a timeout means it did not show, which the check records
    .catch(() => false)
  checks[`${prefix}.usage.tap`] = { ok: shown, detail: null }
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
}

const DRAWER = '[data-slot="drawer-side"]'
const OPEN_NAVIGATION = 'button[aria-label="Open navigation"]'

async function sidebarCheck(page: Page, checks: Record<string, Check>, prefix: string): Promise<void> {
  const sheet = DRAWER
  const row = `${DRAWER} .shell-sidebar a[href^="/c/"]`
  const trigger = page.locator(OPEN_NAVIGATION).first()
  // The first tap moves to the row's page; the second, on the row already showing, changes no path.
  await trigger.tap()
  await page.waitForTimeout(600)
  if ((await page.locator(row).count()) === 0) {
    checks[`${prefix}.sidebar.closes`] = skipped('no conversation row in this account snapshot')
    await page.keyboard.press('Escape')
    return
  }
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
  checks[`${prefix}.sidebar.closes`] = { ok: before > 0 && after === 0, detail: { before, after } }
}

/** A swipe left across the open navigation drawer takes it back to the edge. */
async function sidebarSwipeCheck(page: Page, checks: Record<string, Check>, prefix: string): Promise<void> {
  const sheet = page.locator(DRAWER)
  await page.locator(OPEN_NAVIGATION).first().tap()
  await page.waitForTimeout(600)
  const box = await sheet.boundingBox()
  if (box === null) {
    checks[`${prefix}.sidebar.swipe`] = { ok: false, detail: 'sidebar did not open' }
    return
  }
  const y = box.y + box.height / 2
  await swipe(page, [box.x + box.width - 24, y], [8, y])
  await page.waitForTimeout(800)
  checks[`${prefix}.sidebar.swipe`] = { ok: (await sheet.count()) === 0, detail: { left: await sheet.count() } }
}

/** In a conversation with turns, the turn map's tab opens a bottom drawer that a swipe down closes. */
async function turnMapCheck(page: Page, checks: Record<string, Check>, prefix: string): Promise<void> {
  const tab = page.locator('.turn-map-tab:visible').first()
  if ((await tab.count()) === 0) {
    checks[`${prefix}.turn-map.swipe`] = skipped('no turn map in this account snapshot')
    return
  }
  await tab.click()
  await page.waitForTimeout(600)
  const drawer = page.locator('[data-slot="drawer-content"]')
  const box = await drawer.boundingBox()
  if (box === null) {
    checks[`${prefix}.turn-map.swipe`] = { ok: false, detail: 'drawer did not open' }
    return
  }
  const x = box.x + box.width / 2
  await swipe(page, [x, box.y + 8], [x, box.y + box.height + 40])
  await page.waitForTimeout(800)
  checks[`${prefix}.turn-map.swipe`] = { ok: (await drawer.count()) === 0, detail: { height: Math.round(box.height) } }
}

async function screenshots(
  browser: Browser,
  session: Session,
  out: string,
  errors: string[],
  checks: Record<string, Check>,
): Promise<number> {
  let count = 0
  for (const [device, options] of [
    ['phone', PHONE],
    ['landscape', { ...PHONE, viewport: { width: 844, height: 390 } }],
    ['tablet', { viewport: { width: 820, height: 1180 }, hasTouch: true }],
    ['desk', DESK],
  ] as const)
    for (const colorScheme of ['light', 'dark'] as const) {
      const page = await open(browser, session, { ...options, colorScheme }, errors, `${device}/${colorScheme}`)
      await visit(page, session.origin, '/c/1')
      const thread = await threadRoute(page)
      for (const route of thread === undefined ? PAGES : [...PAGES, thread]) {
        await visit(page, session.origin, route)
        const slug = route === thread ? 'thread' : route.slice(1).replaceAll('/', '_')
        await editableChecks(page, checks, `${device}.${colorScheme}.${slug}`)
        const width = await page
          .locator('html')
          .evaluate((root) => ({ page: root.scrollWidth, screen: root.ownerDocument.defaultView?.innerWidth ?? 0 }))
        checks[`${device}.${colorScheme}.${slug}.no-overflow`] = { ok: width.page <= width.screen, detail: width }
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
  const hybrid = await chromium.launch({
    args: ['--blink-settings=primaryHoverType=2,availableHoverTypes=3,primaryPointerType=4,availablePointerTypes=6'],
  })
  const checks: Record<string, Check> = {}
  const errors: string[] = []
  try {
    await deskChecks(await open(browser, session, DESK, errors, 'desk'), session.origin, checks)
    await phoneChecks(await open(browser, session, PHONE, errors, 'phone'), session.origin, checks)
    await phoneChecks(
      await open(browser, session, { ...PHONE, viewport: { width: 844, height: 390 } }, errors, 'landscape'),
      session.origin,
      checks,
      'landscape',
    )
    await phoneChecks(
      await open(browser, session, { viewport: { width: 820, height: 1180 }, hasTouch: true }, errors, 'tablet'),
      session.origin,
      checks,
      'tablet',
    )
    await phoneChecks(
      await open(hybrid, session, { viewport: { width: 820, height: 1180 } }, errors, 'hybrid'),
      session.origin,
      checks,
      'hybrid',
    )
    const shots = await screenshots(browser, session, out, errors, checks)
    const failed = Object.entries(checks)
      .filter(([, check]) => 'ok' in check && !check.ok)
      .map(([name]) => name)
    const unavailable = Object.entries(checks)
      .filter(([, check]) => 'skipped' in check)
      .map(([name]) => name)
    const receipt = {
      utc,
      origin: session.origin,
      checks,
      failed,
      skipped: unavailable,
      errors,
      screenshots: shots,
      out,
    }
    writeFileSync(path.join(out, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
    chmodSync(out, 0o700)
    console.log(JSON.stringify({ failed, skipped: unavailable, errors, screenshots: shots, out }, null, 2))
    if (failed.length > 0 || errors.length > 0) process.exitCode = 1
  } finally {
    await browser.close()
    await hybrid.close()
  }
}

await main()
