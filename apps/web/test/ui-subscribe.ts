/**
 * Local browser look at goblin Pro (ADR 0054, amended 2026-10-13) against its real source components, at phone and
 * desktop widths: `/subscribe` with the day pass and monthly (no plan, on a day pass, a day pass that could not pay),
 * Settings' plan card in each state, and the composer's no-plan card. No account, wallet or payment is touched; the
 * owner API is routed here. It checks the links each screen offers, that Subscribe asks for the chosen way to pay, and
 * that no screen scrolls sideways, and keeps screenshots.
 */
import assert from 'node:assert/strict'
import { mkdirSync, writeSync } from 'node:fs'
import path from 'node:path'
import { createServer } from 'vite'
import { type Browser, type BrowserContextOptions, type Page, chromium } from 'playwright-core'

const STDOUT = 1
const out = path.resolve(import.meta.dirname, '../../../.local/goblin-acceptance', `subscribe-${Date.now()}`)
mkdirSync(out, { recursive: true, mode: 0o700 })

const WALLET = 'https://wallet.goblin.surf'
const SUB = `sub_${'5a'.repeat(16)}`
// Today's paid day ends later than any run takes, whatever the clock says.
const END_OF_TODAY = Date.now() + 3_600_000
const CATALOG = [
  { id: 'day', amountUsd: '1.00', periodDays: 1, dailyCredits: 800 },
  { id: 'month', amountUsd: '15.00', periodDays: 30, dailyCredits: 800 },
]
const NONE = {
  active: false,
  source: 'none',
  until: null,
  dailyCredits: 0,
  status: 'none',
  hasCustomer: false,
  cancelAtPeriodEnd: false,
  mode: null,
  plan: null,
  catalog: CATALOG,
  walletPay: true,
}
const wallet = (change: Record<string, unknown>) => ({
  subscription: SUB,
  billing: 'day',
  status: 'active',
  amountUsd: '1.00',
  periodDays: 1,
  paidThrough: null,
  nextPaymentAt: null,
  graceUntil: null,
  manageUrl: `${WALLET}/limits`,
  ...change,
})
const onPro = (change: Record<string, unknown>) => ({
  ...NONE,
  active: true,
  source: 'wallet',
  plan: 'pro',
  dailyCredits: 800,
  wallet: wallet(change),
})
const DAY = onPro({ paidThrough: END_OF_TODAY })
const MONTH = onPro({
  billing: 'month',
  amountUsd: '15.00',
  periodDays: 30,
  paidThrough: Date.now() + 20 * 86_400_000,
  nextPaymentAt: Date.now() + 20 * 86_400_000,
})
const UNPAID = { ...NONE, wallet: wallet({ status: 'lapsed' }) }

/** Each screen: where the page opens, the plan, what the wallet holds, and what the page must offer. */
const SCREENS = [
  { name: 'subscribe-none', at: '/subscribe', plan: NONE, held: '3.2', text: ['$3.20', 'Covers 3 days of use.'] },
  { name: 'subscribe-day', at: '/subscribe', plan: DAY, held: '152.6', text: ['Your plan', 'Switch to monthly'] },
  { name: 'subscribe-unpaid', at: '/subscribe', plan: UNPAID, held: '0.4', text: ['Add $14.60 to your wallet first.'] },
  { name: 'settings-none', at: '/settings', plan: NONE, held: undefined, text: ['Not subscribed', 'Pick a plan'] },
  { name: 'settings-day', at: '/settings', plan: DAY, held: undefined, text: ['Today is paid.', 'Switch to monthly'] },
  { name: 'settings-month', at: '/settings', plan: MONTH, held: undefined, text: ['Paid through'] },
  { name: 'settings-unpaid', at: '/settings', plan: UNPAID, held: undefined, text: ['Payment due', 'Add funds'] },
  { name: 'composer-none', at: '/c/7', plan: NONE, held: undefined, text: ['goblin answers with Pro'] },
  { name: 'composer-unpaid', at: '/c/7', plan: UNPAID, held: undefined, text: ['Add funds', 'Pick a plan'] },
] as const

const errors: string[] = []

/** The owner API for one screen; a wallet start is answered and kept, so the test can read what it asked for. */
async function routeApi(page: Page, screen: (typeof SCREENS)[number], started: unknown[]) {
  await page.route(`${WALLET}/**`, (route) => route.fulfill({ contentType: 'text/html', body: '<p>wallet</p>' }))
  await page.route('**/api/**', (route) => {
    const { pathname } = new URL(route.request().url())
    if (!pathname.startsWith('/api/')) return route.continue()
    const json = (body: unknown) => route.fulfill({ json: body })
    if (pathname === '/api/auth/get-session')
      return json({ session: { id: 's', userId: 'u' }, user: { id: 'u', email: 'owner@example.com' } })
    if (pathname === '/api/billing/state') return json(screen.plan)
    if (pathname === '/api/billing/wallet/start') {
      started.push(route.request().postDataJSON())
      return json({ signUrl: `${WALLET}/subscribe/${SUB}` })
    }
    if (pathname === '/api/mcp/servers')
      return json([
        {
          connectionId: 'wallet',
          label: 'Goblin Wallet',
          endpoint: `${WALLET}/mcp`,
          status: 'connected',
          live: true,
          source: 'config',
          profile: {
            id: 'wallet',
            title: 'Goblin Wallet',
            description: 'Goblin Wallet.',
            offer: 'so goblin can pay',
            recommended: { run: ['status'], ask: ['pay'] },
            status: true,
          },
        },
      ])
    if (pathname === '/api/mcp/wallet/status')
      return json({
        kind: 'wallet',
        paid: 'ready',
        funding: 'ready',
        tokens: [],
        ...(screen.held === undefined ? {} : { stablecoinUsd: screen.held }),
      })
    return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'not here' } } })
  })
}

/** The checks one screen needs beyond its words: where its links go, and what Subscribe asks for. */
async function checkLinks(page: Page, name: string, origin: string, started: unknown[]) {
  if (name === 'subscribe-unpaid') {
    // A Button rendered as a link keeps the button role; its anchor carries the address.
    const funds = new URL((await page.locator('a', { hasText: 'Add funds' }).getAttribute('href')) ?? '')
    assert.equal(funds.origin + funds.pathname, `${WALLET}/add-funds`)
    const back = new URL(funds.searchParams.get('return') ?? '')
    assert.equal(back.pathname, '/subscribe/success')
    assert.equal(back.searchParams.get('subscription'), SUB)
    assert.equal(back.searchParams.get('return'), '/settings')
  }
  if (name === 'composer-none') {
    const pick = await page.locator('a', { hasText: 'Pick a plan to start' }).getAttribute('href')
    assert.equal(pick, '/subscribe?return=%2Fc%2F7')
  }
  if (name === 'subscribe-none') {
    const subscribe = page.getByRole('button', { name: 'Subscribe with USDC' })
    assert.equal(await subscribe.count(), 2)
    await subscribe.last().click()
    await page.waitForURL(`${WALLET}/**`)
    assert.deepEqual(started, [{ plan: 'month', return: '/settings' }])
    assert(origin.length > 0)
  }
}

async function drive(browser: Browser, origin: string, label: string, options: BrowserContextOptions) {
  for (const screen of SCREENS) {
    const page = await browser.newPage(options)
    page.on('pageerror', (error) => errors.push(`${label} ${screen.name}: ${error.message}`))
    page.on('response', (response) => {
      if (response.status() >= 400)
        errors.push(`${label} ${screen.name}: ${String(response.status())} ${response.url()}`)
    })
    const started: unknown[] = []
    await routeApi(page, screen, started)
    await page.goto(`${origin}subscribe.html?at=${encodeURIComponent(screen.at)}`)
    await page.waitForLoadState('networkidle')
    for (const text of screen.text) await page.getByText(text, { exact: false }).first().waitFor()
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    assert(sideways <= 0, `${label} ${screen.name}: scrolls sideways by ${String(sideways)}px`)
    await page.screenshot({ path: path.join(out, `${label}-${screen.name}.png`), fullPage: true })
    await checkLinks(page, screen.name, origin, started)
    await page.close()
  }
}

const vite = await createServer({ configFile: path.join(import.meta.dirname, 'browser/vite.config.ts') })
await vite.listen()
const origin = vite.resolvedUrls?.local[0]
assert(origin, 'missing browser fixture origin')
const browser = await chromium.launch()
try {
  await drive(browser, origin, 'phone-light', {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
    colorScheme: 'light',
  })
  await drive(browser, origin, 'desktop-dark', { viewport: { width: 1280, height: 900 }, colorScheme: 'dark' })
  assert.deepEqual(errors, [])
  writeSync(STDOUT, `${JSON.stringify({ ok: true, out })}\n`)
} finally {
  await browser.close()
  await vite.close()
}
