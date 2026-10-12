/**
 * Local browser acceptance of a connection's Events (ADR 0041, amended 2026-10-12) against real source components, at
 * desktop and phone widths in light and dark: the open offer, the picker with the server's titles, groups and rate, the
 * recommended event picked already, an event the Telegram channel takes, a filter the server requires asked for in
 * Advanced, a hand-over to a Persona, and both events set up in one step (each proposed, then confirmed). No account
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
  eventHealth: [
    {
      subscriptionId: 'sub-telegram',
      name: 'sidequest.worker.messages',
      granted: true,
      status: 'active',
      refreshBefore: null,
      lastReceiptAt: null,
      telegram: true,
    },
  ],
}
const STREAMS = [
  {
    name: 'sidequest.worker.requests',
    description: 'A hirer asks you for a quote.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', title: 'Agent', description: 'Your worker agent.' },
        kind: { type: ['string', 'null'], enum: ['quote', 'pick', null] },
      },
      required: ['agentId'],
    },
    subscribable: true,
    title: 'Quote requests',
    summary: 'A hirer asks you for a quote',
    group: 'Jobs',
    recommended: true,
    tellMe: true,
    rate: 'often',
  },
  {
    name: 'sidequest.inbox',
    description: 'Messages for you.',
    inputSchema: { type: 'object', properties: { where: { type: 'object' } } },
    subscribable: true,
  },
  {
    name: 'sidequest.worker.messages',
    inputSchema: { type: 'object' },
    subscribable: true,
    title: 'Messages',
    group: 'Jobs',
    recommended: true,
    tellMe: true,
  },
]

const errors: string[] = []
const proposals: unknown[] = []
const confirmed: string[] = []

/** A routine as the owner API answers it: the definition sent, in its Topic, in `state`. */
const routineOf = (id: string, body: { readonly topic: number; readonly definition: unknown }, state: string) => ({
  id,
  revision: 1,
  state,
  definition: body.definition,
  confirmedAt: state === 'proposed' ? null : 1,
  nextFireAt: null,
  lastFireAt: null,
  missedCount: 0,
  suppressedCount: 0,
  health: null,
  createdAt: 1,
  updatedAt: 1,
  topic: body.topic,
  outsideSetup: [],
})

async function drive(browser: Browser, origin: string, label: string, options: BrowserContextOptions) {
  const page = await browser.newPage(options)
  const routines = new Map<string, { readonly topic: number; readonly definition: unknown }>()
  page.on('pageerror', (error) => errors.push(`${label}: ${error.message}`))
  await page.route('**/api/mcp/servers', (route) => route.fulfill({ json: [WORKER] }))
  await page.route('**/api/mcp/sq-worker/events', (route) => route.fulfill({ json: STREAMS }))
  await page.route('**/api/routines/settings', (route) =>
    route.fulfill({ json: { timezone: 'Europe/Tallinn', maxActive: 20, maxRunning: 2 } }),
  )
  await page.route('**/api/routines/*/confirm', (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2) ?? ''
    const body = routines.get(id)
    confirmed.push(id)
    return body === undefined ? route.fulfill({ status: 404 }) : route.fulfill({ json: routineOf(id, body, 'active') })
  })
  await page.route('**/api/routines', (route) => {
    if (route.request().method() !== 'POST')
      return route.fulfill({
        json: { routines: [...routines].map(([id, body]) => routineOf(id, body, 'active')) },
      })
    // SAFETY: the picker sends the owner API's RoutineProposal.
    const body = route.request().postDataJSON() as { readonly topic: number; readonly definition: unknown }
    const id = `rt_${String(routines.size + 1)}`
    routines.set(id, { topic: body.topic, definition: body.definition })
    proposals.push({ topic: body.topic, definition: body.definition })
    return route.fulfill({ status: 201, json: routineOf(id, body, 'proposed') })
  })
  await page.goto(`${origin}events.html`)
  await page.getByText('Sidequest · Worker sends events').waitFor()
  await page.getByText('Quote requests').first().waitFor()
  await page.getByText('Already arrives through Telegram.').waitFor()
  assert(await page.getByRole('checkbox', { name: /Quote requests/u }).isChecked(), `${label}: not picked already`)
  assert(!(await page.getByRole('checkbox', { name: /Sidequest inbox/u }).isChecked()), `${label}: inbox picked`)
  await page.getByText('You’ll see:').first().waitFor()
  await page.screenshot({ path: path.join(out, `${label}-picker.png`), fullPage: true })
  await page.getByRole('button', { name: 'Set up 1 event' }).click()
  await page.getByText('Quote requests: Agent is needed: the server asks for it.').waitFor()
  await page.getByLabel('Agent').fill('w-1')
  await page.getByLabel('Where “Quote requests” goes').selectOption({ label: '@Worker acts on it' })
  await page.getByLabel('Instructions (optional)').fill('Quote the request if it fits.')
  await page.getByRole('checkbox', { name: /Sidequest inbox/u }).check()
  await page.screenshot({ path: path.join(out, `${label}-advanced.png`), fullPage: true })
  const width = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  assert(width <= 0, `${label}: scrolls sideways by ${String(width)}px`)
  await page.getByRole('button', { name: 'Set up 2 events' }).click()
  await page.getByText('→ @Worker').waitFor()
  await page.getByText('→ #Personal').waitFor()
  await page.screenshot({ path: path.join(out, `${label}-set-up.png`), fullPage: true })
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
  assert.equal(proposals.length, 8)
  assert.equal(confirmed.length, 8)
  assert.deepEqual(proposals.slice(0, 2), [
    {
      topic: 1,
      definition: {
        title: 'Quote requests from Sidequest · Worker',
        timezone: 'Europe/Tallinn',
        trigger: {
          kind: 'event',
          connectionId: 'sq-worker',
          name: 'sidequest.worker.requests',
          arguments: { agentId: 'w-1' },
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
    },
    {
      topic: 1,
      definition: {
        title: 'Sidequest inbox from Sidequest · Worker',
        timezone: 'Europe/Tallinn',
        trigger: { kind: 'event', connectionId: 'sq-worker', name: 'sidequest.inbox', arguments: {} },
        tellMe: { on: true, telegram: false },
        handTo: { kind: 'none' },
      },
    },
  ])
  writeSync(STDOUT, `${JSON.stringify({ ok: true, out, proposals: proposals.length })}\n`)
} finally {
  await browser.close()
  await server.close()
}
