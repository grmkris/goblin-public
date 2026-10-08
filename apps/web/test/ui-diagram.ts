import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { chromium, type Page, type Locator } from 'playwright-core'
import { createServer } from 'vite'

const out = path.resolve(import.meta.dirname, '../../../.local/goblin-acceptance', `diagram-${Date.now()}`)
const checks: string[] = []
const errors: string[] = []
const requests: string[] = []
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Explore diagram' })
const scale = async (root: Locator) => Number((await root.getByLabel('Zoom level').innerText()).replace('%', ''))

async function desktop(page: Page) {
  const trigger = page
    .getByRole('region', { name: 'Diagram 0', exact: true })
    .getByRole('button', { name: 'Explore diagram' })
  // Sections without headings are located by their labels, independent of Markdown wrappers.
  await trigger.waitFor()
  assert.equal(await page.getByLabel('Invalid diagram', { exact: true }).locator('pre').count(), 1)
  assert.equal(await page.getByLabel('Inert diagram', { exact: true }).getByRole('button').count(), 0)
  assert.equal(await page.getByLabel('Streaming diagram', { exact: true }).locator('pre').count(), 1)
  const safety: unknown = JSON.parse(await page.getByLabel('SVG safety checks').innerText())
  assert(Array.isArray(safety))
  assert(safety.length >= 35)
  checks.push(`${safety.length} SVG boundary/metadata assertions`)
  const outside = await page.getByLabel('Outside SVG').evaluate((svg) => ({
    font: getComputedStyle(svg.querySelector('text') ?? svg).fontFamily,
    color: getComputedStyle(svg).getPropertyValue('--_text'),
  }))
  await trigger.click()
  const root = dialog(page)
  await root.waitFor()
  assert(
    await root
      .getByRole('button', { name: 'Close', exact: true })
      .evaluate((button) => button === document.activeElement),
  )
  assert.equal(await scale(root), 100)
  const draft = root.getByRole('button', { name: 'Select Draft', exact: true })
  await draft.hover()
  assert.equal(await root.locator('[data-diagram-selectable].kit-diagram-dimmed').count(), 2)
  assert.equal(await draft.getAttribute('aria-pressed'), 'false')
  await draft.click()
  assert.equal(await draft.getAttribute('aria-pressed'), 'true')
  assert(
    (await root.getByRole('status', { name: 'Diagram selection' }).innerText()).includes(
      'Draft selected. 1 connected nodes.',
    ),
  )
  assert.equal(
    await root
      .getByRole('button', { name: 'Select Review' })
      .getAttribute('class')
      .then((v) => v?.includes('kit-diagram-related')),
    true,
  )
  await page.keyboard.press('Escape')
  assert.equal(await root.count(), 1)
  assert.equal(await draft.getAttribute('aria-pressed'), 'false')
  await draft.focus()
  await page.keyboard.press('Enter')
  assert.equal(await draft.getAttribute('aria-pressed'), 'true')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Space')
  assert.equal(await draft.getAttribute('aria-pressed'), 'true')
  await root.getByLabel('Diagram viewport').click({ position: { x: 10, y: 10 } })
  assert.equal(await draft.getAttribute('aria-pressed'), 'false')
  await root.getByRole('button', { name: 'Zoom in' }).click()
  await root.getByLabel('Zoom level').filter({ hasNotText: '100%' }).waitFor()
  assert((await scale(root)) > 100)
  const viewport = root.getByLabel('Diagram viewport')
  await viewport.hover()
  await page.mouse.wheel(0, -900)
  await page.waitForTimeout(80)
  assert((await scale(root)) > 135)
  for (let n = 0; n < 8; n++) {
    const button = root.getByRole('button', { name: 'Zoom in' })
    if (await button.isDisabled()) break
    const previous = await scale(root)
    await button.click()
    await root
      .getByLabel('Zoom level')
      .filter({ hasNotText: `${previous}%` })
      .waitFor()
  }
  assert.equal(await scale(root), 400)
  const before = await root.locator('.kit-diagram-explorer-canvas').getAttribute('style')
  const box = await viewport.boundingBox()
  if (box === null) throw new Error('viewport box missing')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 70, box.y + box.height / 2, { steps: 6 })
  await page.mouse.up()
  await page.waitForTimeout(80)
  assert.notEqual(await root.locator('.kit-diagram-explorer-canvas').getAttribute('style'), before)
  assert.equal(await root.locator('[aria-pressed="true"]').count(), 0)
  await root.getByRole('button', { name: 'Fit', exact: true }).click()
  await root.getByLabel('Zoom level').filter({ hasText: '100%' }).waitFor()
  assert.equal(await scale(root), 100)
  assert(await root.getByRole('button', { name: 'Zoom out' }).isDisabled())
  assert(!(await root.getByRole('button', { name: 'Zoom in' }).isDisabled()))
  await page.screenshot({ path: path.join(out, 'desktop.png') })
  assert.deepEqual(
    await page.getByLabel('Outside SVG').evaluate((svg) => ({
      font: getComputedStyle(svg.querySelector('text') ?? svg).fontFamily,
      color: getComputedStyle(svg).getPropertyValue('--_text'),
    })),
    outside,
  )
  await page.keyboard.press('Escape')
  await root.waitFor({ state: 'detached' })
  assert(await trigger.evaluate((button) => button === document.activeElement))
  await page.getByRole('button', { name: 'Finish stream' }).click()
  await page.getByLabel('Streaming diagram', { exact: true }).getByRole('button', { name: 'Explore diagram' }).waitFor()
  for (const n of [1, 2, 3, 4, 5]) {
    await page.getByLabel(`Diagram ${n}`, { exact: true }).getByRole('button', { name: 'Explore diagram' }).click()
    const node = dialog(page).locator('[data-diagram-selectable]').first()
    if (n < 5) {
      await node.click()
      assert.equal(await node.getAttribute('aria-pressed'), 'true')
    }
    await dialog(page).getByRole('button', { name: 'Close', exact: true }).click()
  }
  await page.getByRole('button', { name: 'Toggle theme' }).click()
  await trigger.click()
  assert(
    await dialog(page)
      .locator('svg')
      .getAttribute('style')
      .then((style) => style?.includes('oklch')),
  )
  await page.setViewportSize({ width: 900, height: 650 })
  await dialog(page).getByLabel('Zoom level').filter({ hasText: '100%' }).waitFor()
  await dialog(page).getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('button', { name: 'Toggle diagrams' }).click()
  await page.getByRole('button', { name: 'Toggle diagrams' }).click()
  await trigger.click()
  await dialog(page).getByRole('button', { name: 'Select Draft', exact: true }).click()
  await dialog(page).getByRole('button', { name: 'Close', exact: true }).click()
  checks.push(
    'chat fence, fallback/streaming/inert opt-out; hover/click/keyboard/blank/Escape; wheel/buttons/drag/fit; 6 diagram families; focus return, CSS isolation, dark theme, resize and remount',
  )
}

async function mobile(page: Page) {
  await page.getByLabel('Diagram 0', { exact: true }).getByRole('button', { name: 'Explore diagram' }).tap()
  const root = dialog(page)
  await root.getByRole('button', { name: 'Select Draft', exact: true }).tap()
  assert((await root.getByRole('status', { name: 'Diagram selection' }).innerText()).includes('Draft selected'))
  const viewport = await root.getByLabel('Diagram viewport').boundingBox()
  const bounds = await root.boundingBox()
  if (viewport === null || bounds === null) throw new Error('mobile dialog bounds missing')
  assert(bounds.x >= 0 && bounds.x + bounds.width <= 391 && bounds.y >= 0 && bounds.y + bounds.height <= 845)
  const cdp = await page.context().newCDPSession(page)
  const x = viewport.x + viewport.width / 2
  const y = viewport.y + viewport.height / 2
  const point = (id: number, px: number) => ({ id, x: px, y, radiusX: 3, radiusY: 3, force: 1 })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(0, x - 25), point(1, x + 25)] })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(0, x - 125), point(1, x + 125)] })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await page.waitForTimeout(100)
  assert((await scale(root)) > 150)
  assert.equal(
    await root.getByRole('button', { name: 'Select Draft', exact: true }).getAttribute('aria-pressed'),
    'true',
  )
  await root.getByRole('button', { name: 'Fit', exact: true }).tap()
  await root.getByLabel('Zoom level').filter({ hasText: '100%' }).waitFor()
  assert.equal(await scale(root), 100)
  await page.screenshot({ path: path.join(out, 'mobile.png') })
  await root.getByRole('button', { name: 'Close', exact: true }).tap()
  checks.push('390px touch viewport: tap selection, CDP pinch, fit/close; no physical-device claim')
}

const inert = (text: string) => text.replaceAll(/<\/(script|style)/giu, '<\\/$1')

async function appFrame(page: Page) {
  const runtime = path.resolve(import.meta.dirname, '../../../packages/app/dist/runtime')
  const core = readFileSync(path.join(runtime, 'core.js'), 'utf8')
  const diagrams = readFileSync(path.join(runtime, 'diagrams.js'), 'utf8')
  const css = readFileSync(path.join(runtime, 'ui.css'), 'utf8')
  await page.setContent(
    '<iframe title="App fixture" sandbox="allow-scripts" style="width:600px;height:650px"></iframe>',
  )
  const source = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:"><style>${inert(css)}</style><div id="root"></div><script>${inert(core)}</script><script>${inert(diagrams)}</script><script>
    const React = globalThis.__goblinRequire('react');
    const { createRoot } = globalThis.__goblinRequire('react-dom/client');
    const { Diagram } = globalThis.__goblinRequire('@goblin/kit/diagram');
    createRoot(document.getElementById('root')).render(React.createElement(Diagram, {source:'graph LR\\n A --> B',fallback:'fallback'}));
  </script>`
  await page.locator('iframe').evaluate((frame, html) => {
    if (!(frame instanceof HTMLIFrameElement)) throw new Error('app fixture iframe missing')
    frame.srcdoc = html
  }, source)
  const frame = page.frameLocator('iframe')
  await frame.getByRole('button', { name: 'Explore diagram' }).click()
  await frame.getByRole('button', { name: 'Select A', exact: true }).click()
  assert((await frame.getByRole('status', { name: 'Diagram selection' }).innerText()).includes('A selected'))
  assert.equal(await page.locator('dialog').count(), 0)
  await frame.getByRole('button', { name: 'Close', exact: true }).click()
  checks.push('built app core/diagrams/ui.css in opaque sandbox: selection and dialog stay within frame')
}

async function main() {
  mkdirSync(out, { recursive: true, mode: 0o700 })
  const server = await createServer({ configFile: path.join(import.meta.dirname, 'browser/vite.config.ts') })
  await server.listen()
  const origin = server.resolvedUrls?.local[0]
  if (origin === undefined) throw new Error('fixture URL missing')
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  try {
    const context = await browser.newContext()
    await context.route('**/*', (route) => {
      if (!route.request().url().startsWith(origin)) {
        requests.push(route.request().url())
        return route.abort()
      }
      return route.continue()
    })
    const page = await context.newPage()
    page.setDefaultTimeout(10000)
    page.setDefaultNavigationTimeout(30000)
    page.on('pageerror', (error) => errors.push(error.message))
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`${origin}diagram.html`)
    await desktop(page)
    const touch = await browser.newPage({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      reducedMotion: 'reduce',
    })
    touch.setDefaultTimeout(10000)
    touch.setDefaultNavigationTimeout(30000)
    touch.on('pageerror', (error) => errors.push(error.message))
    await touch.route('**/*', (route) => {
      if (route.request().url().startsWith(origin)) return route.continue()
      requests.push(route.request().url())
      return route.abort()
    })
    await touch.goto(`${origin}diagram.html`)
    await mobile(touch)
    await appFrame(page)
    assert.deepEqual(requests, [])
    assert.deepEqual(errors, [])
  } finally {
    writeFileSync(
      path.join(out, 'receipt.json'),
      `${JSON.stringify({ evidence: 'local Chromium source chat and built app sandbox', checks, errors, externalRequests: requests }, null, 2)}\n`,
      { mode: 0o600 },
    )
    await browser.close()
    await server.close()
  }
  console.log(JSON.stringify({ checks, errors, externalRequests: requests, out }))
}
await main()
