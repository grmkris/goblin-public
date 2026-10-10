/**
 * Local browser acceptance of a Topic's setup editor (ADR 0040) against real source components: the drawer from the
 * right on a desktop and from the bottom on a phone, in light and dark, Everything to Only these, a tool switched off,
 * and Save as the owner API's compare-and-set. No account or model call is made; the owner API is routed here.
 */
import assert from 'node:assert/strict'
import { mkdirSync, writeSync } from 'node:fs'
import path from 'node:path'
import { createServer } from 'vite'
import { type Browser, type BrowserContextOptions, chromium } from 'playwright-core'

const STDOUT = 1
const out = path.resolve(import.meta.dirname, '../../../.local/goblin-acceptance', `setup-${Date.now()}`)
mkdirSync(out, { recursive: true, mode: 0o700 })

const CATALOG = {
  servers: [
    {
      serverId: 'notes',
      label: 'Notes',
      status: 'connected',
      tools: [
        { name: 'read', title: 'Read a note' },
        { name: 'write', title: 'Write a note' },
      ],
    },
    { serverId: 'mail', label: 'Mail', status: 'connected', tools: [{ name: 'send' }] },
  ],
  libraries: [
    {
      serverId: 'myskills',
      label: 'MySkills',
      available: true,
      skills: Array.from({ length: 10 }, (_, index) => ({
        name: `skill-${String(index)}`,
        uri: `skill://v1/skill-${String(index)}/SKILL.md`,
        description: `What skill ${String(index)} does, in a line.`,
      })),
    },
  ],
  apps: [{ name: 'tracker', title: 'Tracker' }],
}

const errors: string[] = []
const saves: unknown[] = []

async function drive(browser: Browser, origin: string, label: string, options: BrowserContextOptions) {
  const page = await browser.newPage(options)
  page.on('pageerror', (error) => errors.push(`${label}: ${error.message}`))
  await page.route('**/api/setup/catalog', (route) => route.fulfill({ json: CATALOG }))
  await page.route('**/api/topics/2/setup', (route) => {
    // SAFETY: the page sends the owner API's TopicSetupEdit, and the editor only ever sends a whole setup.
    const body = route.request().postDataJSON() as { readonly set: unknown; readonly expectedRevision: number }
    saves.push(body)
    return route.fulfill({
      json: {
        topic: {
          id: 2,
          name: 'Work',
          conversation: '20',
          searchExcluded: false,
          revision: 4,
          setup: body.set,
          createdBy: 'owner',
          createdAt: 1,
        },
        routines: [{ id: 'r_1', title: 'Morning brief', outside: [{ serverId: 'notes', name: 'write' }] }],
      },
    })
  })
  await page.goto(`${origin}setup.html`)
  const drawer = page.getByRole('dialog', { name: 'MCP servers & skills' })
  await drawer.waitFor()
  await page.getByRole('tab', { name: 'Everything' }).first().waitFor()
  await page.screenshot({ path: path.join(out, `${label}-everything.png`) })
  await page.getByRole('tab', { name: 'Only these' }).first().click()
  await page.getByRole('button', { name: 'Notes: show what it has' }).click()
  await page.getByRole('switch', { name: 'Write a note' }).or(page.getByLabel('Write a note')).first().click()
  await page.getByText('1 of 2 tools').waitFor()
  await page.screenshot({ path: path.join(out, `${label}-only-these.png`) })
  const rows = await page
    .locator('.switch-row')
    .evaluateAll((items) => items.map((item) => item.getBoundingClientRect().height))
  if (options.hasTouch === true)
    assert(
      rows.every((height) => height >= 44),
      `${label}: rows ${rows.join(',')}`,
    )
  const width = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  assert(width <= 0, `${label}: scrolls sideways by ${String(width)}px`)
  await page.getByRole('button', { name: 'Save' }).click()
  await page.getByText('Morning brief').waitFor()
  await page.screenshot({ path: path.join(out, `${label}-saved.png`) })
  await page.close()
}

const server = await createServer({ configFile: path.join(import.meta.dirname, 'browser/vite.config.ts') })
await server.listen()
const origin = server.resolvedUrls?.local[0]
assert(origin, 'missing browser fixture origin')
const browser = await chromium.launch()
try {
  for (const scheme of ['light', 'dark'] as const) {
    await drive(browser, origin, `desktop-${scheme}`, { viewport: { width: 1280, height: 800 }, colorScheme: scheme })
    await drive(browser, origin, `phone-${scheme}`, {
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      colorScheme: scheme,
    })
  }
  assert.deepEqual(errors, [])
  assert.equal(saves.length, 4)
  assert.deepEqual(saves[0], {
    set: {
      mcpServers: [
        { serverId: 'mail', tools: 'all' },
        { serverId: 'notes', tools: ['read'] },
      ],
      skills: 'all',
      apps: 'all',
      subagents: true,
    },
    expectedRevision: 3,
  })
  writeSync(STDOUT, `${JSON.stringify({ ok: true, out, saves: saves.length })}\n`)
} finally {
  await browser.close()
  await server.close()
}
