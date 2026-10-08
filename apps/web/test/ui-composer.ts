import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { chromium, type Page } from 'playwright-core'
import { createServer } from 'vite'

const out = path.resolve(import.meta.dirname, '../../../.local/goblin-acceptance', `composer-${Date.now()}`)
const errors: string[] = []
const checks: string[] = []
const skill = {
  selection: { kind: 'skill', serverId: 'lib', uri: 'skill://review/SKILL.md' },
  label: 'review',
  description: 'Review code',
}

async function fixture(page: Page, origin: string, compact = false) {
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/api/conversations/1/composer', (route) =>
    route.fulfill({
      json: {
        options: [
          skill,
          { selection: { kind: 'connection', serverId: 'notes' }, label: 'Notes', description: 'Connection' },
        ],
        unavailable: [],
      },
    }),
  )
  await page.goto(`${origin}/composer.html${compact ? '?compact' : ''}`)
}

async function choose(page: Page, token: string, label: string) {
  const field = page.getByRole('region', { name: 'Source' }).getByRole('textbox', { name: 'Message' })
  await field.fill(token)
  await page.getByRole('option', { name: label }).waitFor()
  await field.press('Tab')
}

async function semantics(page: Page) {
  const field = page.getByRole('textbox', { name: 'Message' })
  await choose(page, '/review', '/review')
  assert.equal(await field.inputValue(), '')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  assert((await page.getByLabel('Sent').innerText()).includes('skill://review/SKILL.md'))
  await field.fill('/unknown @prose')
  await field.press('Escape')
  await field.press('Enter')
  assert((await page.getByLabel('Sent').innerText()).includes('/unknown @prose'))
  await field.fill('/help')
  await field.evaluate((element) =>
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true })),
  )
  assert.equal(await field.inputValue(), '/help')
  await field.press('Escape')
  await field.fill('/stop')
  await page.getByRole('option', { name: '/stop' }).waitFor()
  await field.press('Enter')
  assert.equal(await page.getByLabel('Stops').innerText(), '1')
  checks.push('skill-only, unselected prose, IME, immediate stop')
}

async function failureAndMove(page: Page) {
  await choose(page, '@review', '/review')
  const source = page.getByRole('region', { name: 'Source' })
  const field = source.getByRole('textbox', { name: 'Message' })
  await field.fill('Keep the draft')
  await page.getByRole('button', { name: 'Toggle failure' }).click()
  await source.getByRole('button', { name: 'Send', exact: true }).click()
  await source.locator('[data-failed]').waitFor()
  assert.equal(await field.inputValue(), 'Keep the draft')
  await page.getByRole('button', { name: 'Toggle failure' }).click()
  await page.route('**/api/files?*', (route) =>
    route.fulfill({ json: { entries: [], usedBytes: 0, limitBytes: 536870912 } }),
  )
  await page.route('**/api/files/content?*', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 400))
    await route.fulfill({
      json: {
        path: '/uploads/example.txt',
        name: 'example.txt',
        kind: 'file',
        size: 7,
        mimeType: 'text/plain',
        updatedAt: 1,
      },
    })
  })
  await source
    .locator('input[type="file"]')
    .setInputFiles({ name: 'example.txt', mimeType: 'text/plain', buffer: Buffer.from('example') })
  await field.fill('Keep the draft /new-thread')
  await page.getByRole('option', { name: '/new-thread' }).waitFor()
  await field.press('Enter')
  const moved = page.getByRole('region', { name: 'Moved' })
  assert.equal(await field.inputValue(), '')
  assert.equal(await moved.getByRole('textbox', { name: 'Message' }).inputValue(), 'Keep the draft ')
  assert.equal(await moved.getByRole('button', { name: 'Remove review' }).count(), 1)
  await moved.getByRole('button', { name: 'Send', exact: true }).waitFor({ state: 'visible' })
  await page.waitForFunction(
    () => !document.querySelector('section[aria-label="Moved"] button[type="submit"]')?.hasAttribute('disabled'),
  )
  await moved.getByRole('button', { name: 'Send', exact: true }).click()
  assert((await page.getByLabel('Sent').innerText()).includes('/uploads/example.txt'))
  checks.push('at skills, failed chip retention, new thread transfers prose/chips/in-flight attachment')
}

async function main() {
  mkdirSync(out, { recursive: true, mode: 0o700 })
  const server = await createServer({ configFile: path.join(import.meta.dirname, 'browser/vite.config.ts') })
  await server.listen()
  const origin = server.resolvedUrls?.local[0]
  if (origin === undefined) throw new Error('fixture URL missing')
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await fixture(page, origin)
    await semantics(page)
    await failureAndMove(page)
    await page.screenshot({ path: path.join(out, 'desktop.png') })
    const compact = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true })
    await fixture(compact, origin, true)
    await choose(compact, '/review', '/review')
    await compact.getByRole('button', { name: 'Send', exact: true }).click()
    assert((await compact.getByLabel('Sent').innerText()).includes('skill://review/SKILL.md'))
    checks.push('compact touch composer skill-only send')
    assert.deepEqual(errors, [])
  } finally {
    writeFileSync(
      path.join(out, 'receipt.json'),
      `${JSON.stringify({ evidence: 'local Chromium source component with controlled API', checks, errors }, null, 2)}\n`,
      { mode: 0o600 },
    )
    await browser.close()
    await server.close()
  }
  console.log(JSON.stringify({ checks, errors, out }))
}

await main()
