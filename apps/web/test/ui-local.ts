/** Local browser acceptance against real source components. No account, model call, upload is made. */
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
  await page.goto(`${origin}?mode=attachments`)
  const composer = page.getByRole('textbox', { name: 'Message' })
  assert.equal(await composer.getAttribute('enterkeyhint'), touch ? 'enter' : 'send')
  await composer.fill('Example')
  await composer.press('Enter')
  if (touch) {
    assert.equal(await composer.inputValue(), 'Example\n')
    assert.equal(await page.getByLabel('Sent').innerText(), '0')
  } else {
    assert.equal(await page.getByLabel('Sent').innerText(), '1')
  }
  results.push({ name: `${label}.composer-return`, detail: { touch } })
  await page.close()
}

async function attachments(browser: Browser, origin: string) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true })
  page.on('pageerror', (error) => errors.push(`attachments: ${error.message}`))
  let attempts = 0
  await page.route('**/api/files?*', (route) =>
    route.fulfill({ json: { entries: [], usedBytes: 0, limitBytes: 536870912 } }),
  )
  await page.route('**/api/files/content?*', (route) => {
    attempts += 1
    return route.fulfill(
      attempts === 1
        ? { status: 503, json: { error: 'TemporaryFailure' } }
        : {
            json: {
              path: '/uploads/example.txt',
              name: 'example.txt',
              kind: 'file',
              size: 7,
              mimeType: 'text/plain',
              updatedAt: 1,
            },
          },
    )
  })
  await page.goto(`${origin}?mode=attachments`)
  await page.getByRole('textbox', { name: 'Message' }).fill('Keep this message')
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: 'example.txt', mimeType: 'text/plain', buffer: Buffer.from('example') })
  const alert = page.getByRole('alert')
  await alert.waitFor()
  assert((await alert.innerText()).includes('TemporaryFailure'))
  assert(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled())
  await page.getByRole('textbox', { name: 'Message' }).press('Control+Enter')
  assert.equal(await page.getByLabel('Sent').innerText(), '0')
  await page.screenshot({ path: path.join(out, 'attachment-failed-phone.png') })
  await page.getByRole('button', { name: 'Retry example.txt' }).click()
  await alert.waitFor({ state: 'hidden' })
  await page.locator('.pending-files > [data-state="ready"]').waitFor()
  assert.equal(attempts, 2)
  await page.waitForFunction(() => !document.querySelector('button[type="submit"]')?.hasAttribute('disabled'))
  assert(await page.getByRole('button', { name: 'Send', exact: true }).isEnabled())
  assert.equal(await page.getByRole('textbox', { name: 'Message' }).inputValue(), 'Keep this message')
  await page.getByRole('button', { name: 'Remove example.txt' }).click()
  assert.equal(await page.locator('.pending-files').count(), 0)
  results.push({ name: 'attachments.failure-retry-remove-send-block', detail: { attempts } })
  await page.close()
}

async function styles(browser: Browser, origin: string, label: string, options: BrowserContextOptions) {
  const page = await browser.newPage({ ...options, reducedMotion: 'reduce' })
  page.on('pageerror', (error) => errors.push(`styles/${label}: ${error.message}`))
  await page.goto(`${origin}?mode=styles`)
  await page.locator('[data-sample="tree"]').waitFor()
  const samples = await page.locator('[data-sample], .app-offer [data-slot="button"]').evaluateAll((items) =>
    items.map((item) => {
      const style = getComputedStyle(item)
      return {
        name: item.getAttribute('data-sample') ?? item.getAttribute('aria-label') ?? item.textContent,
        font: style.fontSize,
        height: style.height,
        minHeight: style.minHeight,
        width: style.width,
        radius: style.borderRadius,
        padding: style.padding,
        color: style.color,
        background: style.backgroundColor,
        flex: style.flex,
        transition: style.transitionProperty,
      }
    }),
  )
  await page.screenshot({ path: path.join(out, `styles-${label}.png`) })
  const card = page.locator('[data-sample="interactive-card"]')
  await card.hover()
  await card.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const hover = await card.evaluate((element) => getComputedStyle(element).backgroundColor)
  const fine = await page.evaluate(() => matchMedia('(hover: hover) and (pointer: fine)').matches)
  const expectedHover = await card.evaluate((element) => {
    const probe = document.createElement('span')
    probe.style.backgroundColor = 'color-mix(in oklab, var(--card), var(--foreground) 4%)'
    element.appendChild(probe)
    const color = getComputedStyle(probe).backgroundColor
    probe.remove()
    return color
  })
  if (fine) assert.equal(hover, expectedHover, 'interactive card tints on hover')
  await page.getByRole('button', { name: 'Thoughts' }).click()
  const panel = page.locator('[data-slot="reasoning-content"]')
  await panel.waitFor()
  assert(await panel.isVisible())
  await page.getByRole('button', { name: 'Thoughts' }).click()
  await panel.waitFor({ state: 'hidden' })
  results.push({ name: `styles.${label}`, detail: { samples, cardHover: hover, expectedHover, thoughtsClosed: true } })
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
    await attachments(browser, origin)
    await styles(browser, origin, 'desk', { viewport: { width: 1440, height: 900 } })
    await styles(browser, origin, 'phone', { viewport: { width: 390, height: 844 }, hasTouch: true })
    await styles(hybrid, origin, 'hybrid', { viewport: { width: 820, height: 1180 } })
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
