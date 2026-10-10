/** Chat Markdown in local Chromium: real source components, no account, network or model. */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync, writeSync } from 'node:fs'
import path from 'node:path'
import { chromium, type Page } from 'playwright-core'
import { createServer } from 'vite'
import { CODE } from './browser/markdown-text.ts'

/** The file descriptor this script's result line goes to (`process` is `any` here: @cloudflare/workers-types). */
const STDOUT = 1
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

const out = path.resolve(import.meta.dirname, '../../../.local/goblin-acceptance', `markdown-${Date.now()}`)
const checks: string[] = []
const errors: string[] = []

/** A reply that settles keeps its blocks: the table scrolled sideways is the same element, still scrolled. */
async function settling(page: Page) {
  const reply = page.getByLabel('Streaming reply')
  const scroller = reply.locator('.typeset-scroll')
  // A mark the element keeps only if it is not replaced.
  await scroller.evaluate((element) => {
    element.scrollLeft = 120
    element.dataset['kept'] = 'yes'
  })
  await page.getByRole('button', { name: 'Finish stream' }).click()
  await reply.getByText('after').waitFor()
  const kept = await scroller.evaluate((element) => ({
    same: element.dataset['kept'] === 'yes',
    left: element.scrollLeft,
  }))
  assert.deepEqual(kept, { same: true, left: 120 }, 'a settled reply keeps its table and its scroll')
  checks.push('a reply that settles keeps its blocks mounted (table element and scroll position)')
}

/** An image is fetched only when the owner asks, and then without a referrer. */
async function image(page: Page, fetched: { url: string; referer: string | undefined }[]) {
  const section = page.getByLabel('Reply with an image')
  const button = section.getByRole('button', { name: 'Load image quarterly chart from images.example' })
  await button.waitFor()
  assert.equal(await section.locator('img').count(), 0)
  assert.equal(fetched.length, 0, 'nothing is fetched before the owner asks')
  await button.click()
  const img = section.locator('img')
  await img.waitFor()
  await img.evaluate((element) => (element instanceof HTMLImageElement ? element.decode() : undefined))
  assert.equal(await img.getAttribute('referrerpolicy'), 'no-referrer')
  assert.equal(fetched.length, 1)
  assert.equal(fetched[0]?.referer, undefined, 'the image request carries no referrer')
  checks.push('an image loads only on request, once, with no referrer')
}

/** Code highlights once Shiki loads, and its copy button copies exactly the code. */
async function code(page: Page, label: string) {
  const block = page.getByLabel('Reply with code').locator('.code-block')
  await block.waitFor()
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.code-block span[style]')].some((span) =>
      /--code-light:\s*#/u.test(span.getAttribute('style') ?? ''),
    ),
  )
  await block.hover()
  await block.getByRole('button', { name: 'Copy code' }).click()
  await block.getByRole('button', { name: 'Copied' }).waitFor()
  const copied = await page.evaluate(() => navigator.clipboard.readText())
  assert.equal(copied, CODE)
  await block.screenshot({ path: path.join(out, `code-${label}.png`) })
  await page.evaluate(() => document.documentElement.classList.add('dark'))
  await block.screenshot({ path: path.join(out, `code-${label}-dark.png`) })
  await page.evaluate(() => document.documentElement.classList.remove('dark'))
  checks.push('code highlights once Shiki loads, and Copy copies exactly the code (light and dark captured)')
}

/** A table copies as CSV or Markdown, and downloads as CSV, from what is on screen. */
async function table(page: Page) {
  const block = page.getByLabel('Streaming reply').locator('.table-block')
  const menu = async (item: string) => {
    await block.hover()
    await block.getByRole('button', { name: 'Table actions' }).click()
    await page.getByRole('menuitem', { name: item }).click()
  }
  await menu('Copy as CSV')
  const csv = await page.evaluate(() => navigator.clipboard.readText())
  assert(csv.startsWith('Plan,Monthly,Requests,Backups,Support,Region,Notes'), csv)
  assert(csv.includes('Starter,$5,10M,none,community,one,fine for a hobby project and nothing more'), csv)
  await menu('Copy as Markdown')
  assert((await page.evaluate(() => navigator.clipboard.readText())).startsWith('| Plan | Monthly |'))
  const download = page.waitForEvent('download')
  await menu('Download CSV')
  const saved = await download
  assert.equal(saved.suggestedFilename(), 'table.csv')
  const file = await saved.path()
  assert.equal(readFileSync(file, 'utf8'), csv)
  checks.push('a table copies as CSV and Markdown, and downloads the same CSV')
}

/** Math sets in KaTeX, with its fonts, once loaded; a single `$` stays a dollar sign. */
async function math(page: Page, label: string) {
  const section = page.getByLabel('Reply with math')
  await section.locator('.katex-display').waitFor()
  assert.equal(await section.locator('.katex').count(), 2, 'inline and display math')
  assert((await section.innerText()).includes('costs $5 or $10'), 'prices stay prices')
  const font = await section
    .locator('.katex')
    .first()
    .evaluate((element) => getComputedStyle(element).fontFamily)
  assert(font.includes('KaTeX'), font)
  await section.screenshot({ path: path.join(out, `math-${label}.png`) })
  checks.push('math sets in KaTeX with its fonts once loaded; a single $ stays a dollar sign')
}

/** A link asks first, showing where it goes; Cancel opens nothing, Open opens one tab there. */
async function link(page: Page) {
  const anchor = page.getByLabel('Reply with a link').getByRole('link', { name: 'the official guide' })
  assert.equal(await anchor.getAttribute('href'), 'https://phish.example/login?next=bank')
  const dialog = page.getByRole('dialog', { name: 'Open this link?' })
  const popups: string[] = []
  page.context().on('page', (opened) => popups.push(opened.url()))
  await anchor.click()
  await dialog.waitFor()
  assert((await dialog.innerText()).includes('phish.example'))
  assert((await dialog.innerText()).includes('https://phish.example/login?next=bank'))
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await dialog.waitFor({ state: 'hidden' })
  await anchor.click({ button: 'middle' })
  await dialog.waitFor()
  const popup = page.context().waitForEvent('page')
  await dialog.getByRole('button', { name: 'Open' }).click()
  const opened = await popup
  await opened.waitForLoadState('domcontentloaded')
  assert.equal(opened.url(), 'https://phish.example/login?next=bank')
  assert.equal(await opened.evaluate(() => window.opener), null, 'the opened tab cannot reach back')
  await opened.close()
  assert.equal(popups.length, 1, 'only Open opened a tab')
  checks.push('a link asks before it opens (click and middle click), shows its address, opens once without an opener')
}

const server = await createServer({ configFile: path.join(import.meta.dirname, 'browser/vite.config.ts') })
await server.listen()
const origin = server.resolvedUrls?.local[0]
if (!origin) throw new Error('markdown_fixture_origin_missing')
const browser = await chromium.launch({ headless: true })
try {
  for (const width of [1280, 390]) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      reducedMotion: 'reduce',
      acceptDownloads: true,
    })
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin })
    const page = await context.newPage()
    page.on('pageerror', (error) => errors.push(error.message))
    const fetched: { url: string; referer: string | undefined }[] = []
    await page
      .context()
      .route('https://phish.example/**', (route) => route.fulfill({ body: 'phish', contentType: 'text/html' }))
    await page.route('https://images.example/**', async (route) => {
      fetched.push({ url: route.request().url(), referer: (await route.request().allHeaders())['referer'] })
      await route.fulfill({ body: PIXEL, contentType: 'image/png' })
    })
    await page.goto(`${origin}markdown.html`)
    await settling(page)
    await code(page, String(width))
    await table(page)
    await math(page, String(width))
    await link(page)
    await image(page, fetched)
    await context.close()
  }
  assert.deepEqual(errors, [])
} finally {
  mkdirSync(out, { recursive: true, mode: 0o700 })
  writeFileSync(
    path.join(out, 'receipt.json'),
    JSON.stringify({ evidence: 'local Chromium, source fixture', checks, errors }, null, 2),
  )
  await browser.close()
  await server.close()
}
writeSync(STDOUT, `${JSON.stringify({ checks, errors, out })}\n`)
