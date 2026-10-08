/** Local browser acceptance against real source components. No account, model call, upload or Home edit is made. */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createServer } from 'vite'
import { chromium, type Browser, type BrowserContextOptions } from 'playwright-core'

type Result = { readonly name: string; readonly detail: unknown }
const results: Result[] = []
const errors: string[] = []
const out = path.resolve(import.meta.dirname, '../../../.local/goblin-acceptance', `local-${Date.now()}`)
mkdirSync(out, { recursive: true, mode: 0o700 })

async function fields(browser: Browser, origin: string, label: string, options: BrowserContextOptions, touch: boolean) {
  const page = await browser.newPage(options)
  page.on('pageerror', (error) => errors.push(`${label}: ${error.message}`))
  await page.goto(origin)
  await page.locator('#input').waitFor()
  const sizes = await page.locator('input, textarea, select').evaluateAll((items) =>
    items.map((item) => ({
      id: item.id,
      font: Number.parseFloat(getComputedStyle(item).fontSize),
      height: item.getBoundingClientRect().height,
    })),
  )
  for (const item of sizes) {
    assert(item.font >= 16, `${label}/${item.id}: font ${item.font}`)
    if (item.id === 'code') assert.equal(item.font, 18)
    if (touch) assert(item.height >= 44, `${label}/${item.id}: height ${item.height}`)
  }
  results.push({ name: `${label}.fields`, detail: sizes })
  await page.screenshot({ path: path.join(out, `${label}.png`) })
  await page.close()
}

async function note(browser: Browser, origin: string, mobile: boolean) {
  const page = await browser.newPage({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    hasTouch: mobile,
  })
  page.on('pageerror', (error) => errors.push(`note: ${error.message}`))
  await page.goto(`${origin}?mode=note`)
  const trigger = page.getByRole('button', { name: 'Read more' })
  await trigger.click()
  const popup = page.locator(mobile ? '[data-slot="drawer-content"]' : '[data-slot="dialog-content"]')
  await popup.waitFor()
  assert(await popup.getByText('Paragraph 30.', { exact: false }).isVisible())
  const scrollable = await popup
    .locator('.home-note-content')
    .evaluate((element) => element.scrollHeight > element.clientHeight)
  assert(scrollable, 'long note must have its own scrollable body')
  await page.getByRole('button', { name: 'Close note' }).click()
  await popup.waitFor({ state: 'hidden' })
  assert(await trigger.evaluate((element) => element === document.activeElement), 'note returns focus to its trigger')
  results.push({ name: `note.${mobile ? 'phone' : 'desk'}`, detail: { scrollable, focusReturned: true } })
  await page.close()
}

async function keyboard(browser: Browser, origin: string) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  await page.addInitScript(() => {
    const viewport = Object.assign(new EventTarget(), {
      height: 844,
      width: 390,
      offsetTop: 0,
      offsetLeft: 0,
      scale: 1,
    })
    Object.defineProperty(window, 'visualViewport', { value: viewport })
  })
  page.on('pageerror', (error) => errors.push(`keyboard: ${error.message}`))
  await page.goto(`${origin}?mode=keyboard`)
  const pane = page.locator('.chat-pane')
  await pane.waitFor()
  await page.getByRole('textbox', { name: 'Message' }).focus()
  await page.evaluate(() => {
    if (!window.visualViewport) throw new Error('synthetic_viewport_missing')
    Object.assign(window.visualViewport, { height: 524 })
    window.visualViewport?.dispatchEvent(new Event('resize'))
  })
  await page.waitForFunction(() => document.querySelector('.chat-pane')?.getAttribute('data-snap') === '1')
  const bounds = await page.locator('.chat-dock').evaluate((dock) => ({
    bottom: dock.getBoundingClientRect().bottom,
    fieldBottom: dock.querySelector('textarea')?.getBoundingClientRect().bottom ?? Infinity,
    actionsBottom: dock.querySelector('[data-slot="composer-actions"]')?.getBoundingClientRect().bottom ?? Infinity,
  }))
  assert(bounds.bottom <= 525 && bounds.fieldBottom <= 525 && bounds.actionsBottom <= 525, JSON.stringify(bounds))
  await page.evaluate(() => {
    if (!window.visualViewport) throw new Error('synthetic_viewport_missing')
    Object.assign(window.visualViewport, { height: 844 })
    window.visualViewport?.dispatchEvent(new Event('resize'))
  })
  await page.waitForFunction(() => document.querySelector('.chat-pane')?.getAttribute('data-snap') === '0.55')
  await page.evaluate(() => {
    if (!window.visualViewport) throw new Error('synthetic_viewport_missing')
    Object.assign(window.visualViewport, { height: 422, scale: 2 })
    window.visualViewport?.dispatchEvent(new Event('resize'))
  })
  await page.waitForFunction(
    () => getComputedStyle(document.querySelector('.chat-pane')!).getPropertyValue('--keyboard-inset') === '0px',
  )
  results.push({ name: 'keyboard.half-full-restore-zoom', detail: bounds })
  await page.close()
}

async function main() {
  const server = await createServer({ configFile: path.join(import.meta.dirname, 'browser/vite.config.ts') })
  await server.listen()
  const origin = server.resolvedUrls?.local[0]
  if (!origin) throw new Error('fixture_server_url_missing')
  const browser = await chromium.launch()
  const hybrid = await chromium.launch({
    args: ['--blink-settings=primaryHoverType=2,availableHoverTypes=3,primaryPointerType=4,availablePointerTypes=6'],
  })
  try {
    await fields(
      browser,
      origin,
      'phone',
      { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
      true,
    )
    await fields(
      browser,
      origin,
      'landscape',
      { viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true },
      true,
    )
    await fields(browser, origin, 'tablet', { viewport: { width: 820, height: 1180 }, hasTouch: true }, true)
    await fields(browser, origin, 'desk', { viewport: { width: 1440, height: 900 } }, false)
    await fields(hybrid, origin, 'hybrid', { viewport: { width: 820, height: 1180 } }, true)
    await note(browser, origin, false)
    await note(browser, origin, true)
    await keyboard(browser, origin)
    assert.deepEqual(errors, [], 'browser page errors')
  } finally {
    writeFileSync(
      path.join(out, 'receipt.json'),
      `${JSON.stringify({ evidence: 'local Chromium; synthetic keyboard and hybrid capabilities', results, errors }, null, 2)}\n`,
      { mode: 0o600 },
    )
    await browser.close()
    await hybrid.close()
    await server.close()
  }
  console.log(JSON.stringify({ checks: results.length, errors, out }))
}

await main()
