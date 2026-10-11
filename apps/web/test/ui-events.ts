/**
 * Local browser acceptance of a connection's Events (ADR 0041) against real source components, at desktop and phone
 * widths in light and dark: the open offer, Set up on a stream, its filters as a form from the stream's input schema
 * (and JSON for one a flat form cannot hold), Hand to a Persona in another Topic, and the proposal's review. No account
 * or model call is made; the owner API is routed here.
 */
import assert from 'node:assert/strict'
import { mkdirSync, writeSync } from 'node:fs'
import path from 'node:path'
import { createServer } from 'vite'
import { type Browser, type BrowserContextOptions, chromium } from 'playwright-core'

const STDOUT = 1
const out = path.resolve(import.meta.dirname, '../../../.local/goblin-acceptance', `events-${Date.now()}`)
mkdirSync(out, { recursive: true, mode: 0o700 })

const WORKER = {
  connectionId: 'sq-worker',
  label: 'Sidequest · Worker',
  endpoint: 'https://dev.sidequest.exchange/mcp',
  status: 'connected',
  live: true,
  source: 'added',
  events: 'open',
  eventHealth: [],
}
const STREAMS = [
  {
    name: 'sidequest.worker.requests',
    description: 'A hirer asks you for a quote.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', title: 'Agent', description: 'Your worker agent.' },
        kind: { type: 'string', enum: ['quote', 'pick'] },
      },
      required: ['agentId'],
    },
    subscribable: true,
  },
  {
    name: 'sidequest.inbox',
    description: 'Messages for you.',
    inputSchema: { type: 'object', properties: { where: { type: 'object' } } },
    subscribable: true,
  },
]

const errors: string[] = []
const proposals: unknown[] = []

/** The proposal the owner API answers with: the definition sent, in its Topic, waiting for confirmation. */
const proposed = (body: { readonly topic: number; readonly definition: unknown }) => ({
  id: 'rt_1',
  revision: 1,
  state: 'proposed',
  definition: body.definition,
  confirmedAt: null,
  nextFireAt: null,
  lastFireAt: null,
  missedCount: 0,
  suppressedCount: 0,
  health: null,
  createdAt: 1,
  updatedAt: 1,
  topic: body.topic,
  outsideSetup: [],
  persona: { id: 7, name: 'Worker', pinned: 3, current: 3, archived: false },
})

async function drive(browser: Browser, origin: string, label: string, options: BrowserContextOptions) {
  const page = await browser.newPage(options)
  page.on('pageerror', (error) => errors.push(`${label}: ${error.message}`))
  await page.route('**/api/mcp/servers', (route) => route.fulfill({ json: [WORKER] }))
  await page.route('**/api/mcp/grants', (route) =>
    route.fulfill({ json: [{ connectionId: 'sq-worker', capability: 'tool', name: 'quote' }] }),
  )
  await page.route('**/api/mcp/sq-worker/events', (route) => route.fulfill({ json: STREAMS }))
  await page.route('**/api/routines/settings', (route) =>
    route.fulfill({ json: { timezone: 'Europe/Tallinn', maxActive: 20, maxRunning: 2 } }),
  )
  await page.route('**/api/routines/rt_1/runs', (route) => route.fulfill({ json: { runs: [] } }))
  await page.route('**/api/routines', (route) => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: { routines: [] } })
    // SAFETY: the editor sends the owner API's RoutineProposal.
    const body = route.request().postDataJSON() as { readonly topic: number; readonly definition: unknown }
    proposals.push({ topic: body.topic, definition: body.definition })
    return route.fulfill({ status: 201, json: proposed(body) })
  })
  await page.goto(`${origin}events.html`)
  await page.getByText('Sidequest · Worker sends events').waitFor()
  await page.getByText('sidequest.worker.requests').waitFor()
  await page.screenshot({ path: path.join(out, `${label}-offer.png`), fullPage: true })
  await page.getByRole('button', { name: 'Set up' }).nth(1).click()
  await page.getByLabel('Only events matching (optional)').waitFor()
  await page.getByRole('button', { name: 'Cancel' }).click()
  await page.getByRole('button', { name: 'Set up' }).first().click()
  await page.getByLabel('Agent').fill('w-1')
  await page.getByLabel('kind').selectOption('quote')
  await page.getByLabel('Topic').selectOption({ label: '#Sidequest' })
  await page.getByRole('tab', { name: 'A Persona' }).click()
  await page.getByLabel('Persona').selectOption({ label: '@Worker' })
  await page.getByLabel('Instructions').fill('Quote the request if it fits.')
  await page.screenshot({ path: path.join(out, `${label}-editor.png`), fullPage: true })
  const width = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  assert(width <= 0, `${label}: scrolls sideways by ${String(width)}px`)
  await page.getByRole('button', { name: 'Save for review' }).click()
  await page.getByText('@Worker, revision 3').waitFor()
  await page.getByRole('button', { name: 'Confirm' }).waitFor()
  await page.screenshot({ path: path.join(out, `${label}-review.png`), fullPage: true })
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
  assert.equal(proposals.length, 4)
  assert.deepEqual(proposals[0], {
    topic: 2,
    definition: {
      title: 'sidequest.worker.requests · Sidequest · Worker',
      timezone: 'Europe/Tallinn',
      trigger: {
        kind: 'event',
        connectionId: 'sq-worker',
        name: 'sidequest.worker.requests',
        arguments: { agentId: 'w-1', kind: 'quote' },
      },
      tellMe: { on: true, telegram: false },
      handTo: {
        kind: 'persona',
        persona: 7,
        revision: 3,
        instruction: 'Quote the request if it fits.',
        allowedTools: [],
        budget: { tokensPerRun: 25_000, tokensPerDay: 50_000, runtimeSeconds: 900 },
      },
    },
  })
  writeSync(STDOUT, `${JSON.stringify({ ok: true, out, proposals: proposals.length })}\n`)
} finally {
  await browser.close()
  await server.close()
}
