/**
 * Local browser acceptance of the MCP 2026 owner cards (ADR 0042) against real source components, at desktop and phone
 * widths in light and dark: a URL request on the connection's own host and one elsewhere (flagged), Done while the
 * server still waits and Done once it answers, and the step-up card's sign-in link. No account or model call is made;
 * the owner API is routed here.
 */
import assert from 'node:assert/strict'
import { mkdirSync, writeSync } from 'node:fs'
import path from 'node:path'
import { createServer } from 'vite'
import { type Browser, type BrowserContextOptions, chromium } from 'playwright-core'

const STDOUT = 1
const out = path.resolve(import.meta.dirname, '../../../.local/goblin-acceptance', `holds-${Date.now()}`)
mkdirSync(out, { recursive: true, mode: 0o700 })

const WORKER = {
  connectionId: 'sq-worker',
  label: 'Sidequest · Worker',
  endpoint: 'https://dev.sidequest.exchange/mcp',
  status: 'connected',
  live: true,
  source: 'added',
  eventHealth: [],
}
const OWN = 'https://dev.sidequest.exchange/approve/op_1?token=one-time-token-that-is-long-enough-to-wrap-on-a-phone'
const ELSEWHERE = 'https://approvals.example.org/op_2'
const AUTHORIZE = 'https://dev.sidequest.exchange/oauth/authorize?scope=sidequest%3Aread+sidequest%3Awork'

/** The URL request `id` as the owner API answers it, in `state`. */
const view = (id: string, state: string) => {
  const own = id.endsWith('c1')
  return {
    id,
    connectionId: 'sq-worker',
    name: own ? 'create_agent' : 'request_role',
    message: own ? 'Approve the new agent "Worker".\nIt can quote jobs.' : 'Allow the work role.',
    url: own ? OWN : ELSEWHERE,
    host: own ? 'dev.sidequest.exchange' : 'approvals.example.org',
    ownHost: own,
    conversation: '41',
    state,
    expiresAt: 4_102_444_800_000,
  }
}

/** Mercator, first-class (ADR 0043), and a paid job held on it, with the wallet its status tool reports. */
const MERCATOR = {
  connectionId: 'mercator',
  label: 'Mercator',
  endpoint: 'https://mercator.sh/mcp/auth',
  status: 'connected',
  live: true,
  source: 'config',
  eventHealth: [],
  profile: {
    id: 'mercator',
    title: 'Mercator',
    description: 'Search the web and get outside work done.',
    recommended: { run: ['search_services'], ask: ['create_job'] },
    spend: { tool: 'create_job', argument: 'approved_total', currency: 'USD' },
    app: { tool: 'open_mercator' },
    status: true,
  },
}
const JOB = {
  id: 'mcp:41:c4',
  connectionId: 'mercator',
  name: 'create_job',
  arguments: {
    approved_total: '1.25',
    idempotency_key: 'job-1',
    plan: {
      nodes: [
        { id: 'news', serviceId: 'exa-search' },
        { id: 'brief', serviceId: 'summarize', dependsOn: ['news'] },
      ],
    },
  },
  conversation: '41',
  state: 'pending',
  expiresAt: 4_102_444_800_000,
}
const WALLET = {
  kind: 'wallet',
  paid: 'ready',
  funding: 'ready',
  tokens: [{ symbol: 'USDC.e', balance: '12.5', remaining: '4.75' }],
  periodEndsAt: '2026-10-17T00:00:00Z',
}

const errors: string[] = []

async function drive(browser: Browser, origin: string, label: string, options: BrowserContextOptions) {
  const page = await browser.newPage(options)
  page.on('pageerror', (error) => errors.push(`${label}: ${error.message}`))
  const answers: string[] = []
  await page.route('**/api/mcp/servers', (route) => route.fulfill({ json: [WORKER, MERCATOR] }))
  await page.route('**/api/mcp/url-requests/*', (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1) ?? '')
    if (route.request().method() !== 'POST') return route.fulfill({ json: view(id, 'pending') })
    // SAFETY: the card sends the owner API's UrlRequestAnswer.
    const { action } = route.request().postDataJSON() as { readonly action: string }
    answers.push(`${id}:${action}`)
    // The server still waits the first time Done is pressed, and answers the second.
    const state = action === 'decline' ? 'declined' : answers.length === 1 ? 'pending' : 'completed'
    return route.fulfill({ json: view(id, state) })
  })
  await page.route('**/api/mcp/sq-worker/step-up', (route) => route.fulfill({ json: { authorizationUrl: AUTHORIZE } }))
  // A paid Mercator job held for the owner (ADR 0044): the card reads the call, the wallet and the spending rule.
  const decisions: unknown[] = []
  await page.route('**/api/mcp/approvals/*', (route) => {
    if (route.request().method() === 'POST') {
      decisions.push(route.request().postDataJSON())
      return route.fulfill({ json: { ...JOB, state: 'approved' } })
    }
    return route.fulfill({ json: JOB })
  })
  await page.route('**/api/mcp/mercator/status', (route) => route.fulfill({ json: WALLET }))
  await page.route('**/api/mcp/mercator/spending', (route) =>
    route.fulfill({ json: { tool: 'create_job', spentToday: '0' } }),
  )
  await page.goto(`${origin}holds.html`)
  await page.getByText('Approve the new agent "Worker".').waitFor()
  await page.getByText('This link goes to approvals.example.org').waitFor()
  // The server's words are framed as its claim, and the card says how long the request waits.
  await page.getByText('Sidequest · Worker says:').first().waitFor()
  await page
    .getByText(/^Open until /u)
    .first()
    .waitFor()
  // The Open action is a real link styled as a button, so its role reads as a button.
  const open = page.locator('a', { hasText: /^Open$/u }).first()
  assert.equal(await open.getAttribute('href'), OWN)
  assert.equal(await open.getAttribute('target'), '_blank')
  assert.equal(await open.getAttribute('rel'), 'noopener noreferrer')
  // The paid job: its price first, the services it runs, the wallet; approving can raise the rule in one go.
  await page.getByText('$1.25').waitFor()
  await page.getByText('exa-search → summarize').waitFor()
  await page.getByText(/Wallet: 12\.5 USDC\.e, 4\.75 left until/u).waitFor()
  await page.screenshot({ path: path.join(out, `${label}-cards.png`), fullPage: true })
  const width = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  assert(width <= 0, `${label}: scrolls sideways by ${String(width)}px`)
  // Open leads until the owner has opened the link; then Done does. The tab it opens goes nowhere here.
  await page.context().route('https://dev.sidequest.exchange/**', (route) => route.abort())
  const leads = async () => (await open.getAttribute('class'))?.includes('bg-primary') === true
  assert(await leads(), `${label}: Open does not lead before the link is opened`)
  await open.click()
  assert(!(await leads()), `${label}: Open still leads after the link was opened`)
  await page.getByRole('button', { name: 'Done, continue' }).first().click()
  await page.getByText('Sidequest · Worker is still waiting.').waitFor()
  await page.getByRole('button', { name: 'Done, continue' }).first().click()
  await page.getByText('Approve the new agent "Worker".').waitFor({ state: 'detached' })
  await page.getByRole('button', { name: 'Cancel' }).first().click()
  await page.getByText('Allow the work role.').waitFor({ state: 'detached' })
  assert.deepEqual(answers, ['mcp-url:41:c1:accept', 'mcp-url:41:c1:accept', 'mcp-url:41:c2:decline'])
  await page.getByRole('button', { name: 'Approve, and up to' }).click()
  await page.getByText('Approved. Sending the call…').waitFor()
  assert.deepEqual(decisions, [{ allowed: true, runUpTo: '5' }])
  await page.getByText('It asks for: sidequest:read sidequest:work').waitFor()
  // Continue waits for a sign-in to start: nothing has changed for the agent before it.
  assert(await page.getByRole('button', { name: 'Continue' }).isDisabled())
  await page.getByRole('button', { name: 'Sign in again' }).click()
  const signIn = page.locator('a', { hasText: 'Open sign-in' })
  assert.equal(await signIn.getAttribute('href'), AUTHORIZE)
  assert.equal(await signIn.getAttribute('target'), '_blank')
  await page.screenshot({ path: path.join(out, `${label}-step-up.png`), fullPage: true })
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByText('Signed in again with more access to Sidequest · Worker. Continue.').waitFor()
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
  writeSync(STDOUT, `${JSON.stringify({ ok: true, out })}\n`)
} finally {
  await browser.close()
  await server.close()
}
