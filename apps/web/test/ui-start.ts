/**
 * Local browser look at first-run Start (ADR 0048) against its real source components, at phone and desktop widths:
 * the splash, the welcome, the wallet's three states (connect, setup left, ready), services and the kickoff. No account
 * or model call is made; the owner API is routed here. It checks that no screen scrolls sideways and keeps screenshots.
 */
import assert from 'node:assert/strict'
import { mkdirSync, writeSync } from 'node:fs'
import path from 'node:path'
import { createServer } from 'vite'
import { type Browser, type BrowserContextOptions, chromium } from 'playwright-core'

const STDOUT = 1
const out = path.resolve(import.meta.dirname, '../../../.local/goblin-acceptance', `start-${Date.now()}`)
mkdirSync(out, { recursive: true, mode: 0o700 })

const PROFILE = (id: string, title: string) => ({
  id,
  title,
  description: `${title}.`,
  offer: `so goblin can use ${title}`,
  recommended: { run: ['status', 'search', 'quote'], ask: ['pay'] },
  status: true,
})
const server = (connectionId: string, title: string, status: string) => ({
  connectionId,
  label: title,
  endpoint: connectionId === 'wallet' ? 'https://wallet.goblin.surf/mcp' : 'https://mercator.sh/mcp/auth',
  status,
  live: status === 'connected',
  source: 'config',
  profile: PROFILE(connectionId, title),
})
/** No plan yet: the wallet step ends with goblin Pro's two ways to pay, the day pass first (ADR 0054). */
const PLAN = {
  active: false,
  source: 'none',
  until: null,
  dailyCredits: 0,
  status: 'none',
  hasCustomer: false,
  cancelAtPeriodEnd: false,
  mode: null,
  plan: null,
  catalog: [
    { id: 'day', amountUsd: '1.00', periodDays: 1, dailyCredits: 800 },
    { id: 'month', amountUsd: '15.00', periodDays: 30, dailyCredits: 800 },
  ],
}
const SETUP_URL = 'https://wallet.goblin.surf/setup?return=https%3A%2F%2Fgoblin.surf%2Fstart%2Fwallet'
const FUNDS_URL = 'https://wallet.goblin.surf/add-funds?return=https%3A%2F%2Fgoblin.surf%2Fstart%2Fwallet'
const steps = (done: readonly string[]) =>
  ['welcome', 'wallet', 'services', 'goblin'].map((id) => ({ id, done: done.includes(id) }))
const wallet = (change: Record<string, unknown>) => ({
  connectionId: 'wallet',
  connected: true,
  allowed: true,
  ready: false,
  gaps: [],
  setupUrl: SETUP_URL,
  fundsUrl: FUNDS_URL,
  needs: '0',
  funded: false,
  ...change,
})
const view = (walletState: Record<string, unknown>, done: readonly string[], mercator = false) => ({
  status: 'open',
  steps: steps(done),
  wallet: wallet(walletState),
  mercator: { connectionId: 'mercator', connected: mercator, allowed: mercator },
  connected: 0,
  kickoff: false,
})

/** Each screen: where the page opens, Start's view, and whether the wallet is signed in. */
const SCREENS = [
  { name: 'splash', at: '/splash', view: view({}, []), walletSignedIn: false },
  {
    name: 'welcome',
    at: '/start/welcome',
    view: view({ connected: false, allowed: false }, []),
    walletSignedIn: false,
  },
  {
    name: 'wallet-connect',
    at: '/start/wallet',
    view: view({ connected: false, allowed: false, setupUrl: undefined, fundsUrl: undefined }, ['welcome']),
    walletSignedIn: false,
  },
  {
    name: 'wallet-setup',
    at: '/start/wallet',
    view: view(
      {
        gaps: [
          'create the agent wallet',
          "add USDC to the account on Base (the upgrade's gas is paid in USDC)",
          'upgrade the account on Base',
          'sign the spending allowance',
        ],
        dollars: '0',
      },
      ['welcome'],
    ),
    walletSignedIn: true,
  },
  {
    name: 'wallet-ready',
    at: '/start/wallet',
    view: view(
      {
        ready: true,
        funded: true,
        dollars: '24.5',
        payFrom: { address: `0x${'b'.repeat(40)}`, chain: 'tempo', token: 'USDC.e', held: '4.93' },
      },
      ['welcome', 'wallet'],
    ),
    walletSignedIn: true,
  },
  {
    name: 'services',
    at: '/start/services',
    view: view({ ready: true, funded: true }, ['welcome', 'wallet']),
    walletSignedIn: true,
  },
  {
    name: 'goblin',
    at: '/start/goblin',
    view: view({ ready: true, funded: true }, ['welcome', 'wallet', 'services'], true),
    walletSignedIn: true,
  },
] as const

const errors: string[] = []

async function drive(browser: Browser, origin: string, label: string, options: BrowserContextOptions) {
  for (const screen of SCREENS) {
    const page = await browser.newPage(options)
    page.on('pageerror', (error) => errors.push(`${label} ${screen.name}: ${error.message}`))
    page.on('response', (response) => {
      if (response.status() >= 400)
        errors.push(`${label} ${screen.name}: ${String(response.status())} ${response.url()}`)
    })
    await page.route('**/api/**', (route) => {
      const { pathname } = new URL(route.request().url())
      // Only the owner API is answered here; the fixture's own modules (`/@fs/…/src/api/…`) load as they are.
      if (!pathname.startsWith('/api/')) return route.continue()
      const json = (body: unknown) => route.fulfill({ json: body })
      if (pathname === '/api/auth/get-session')
        return json({ session: { id: 's', userId: 'u' }, user: { id: 'u', email: 'owner@example.com' } })
      if (pathname === '/api/billing/state') return json(PLAN)
      if (pathname === '/api/onboarding') return json(screen.view)
      if (pathname === '/api/mcp/servers')
        return json([
          server('wallet', 'Goblin Wallet', screen.walletSignedIn ? 'connected' : 'needs_auth'),
          server('mercator', 'Mercator', screen.name === 'goblin' ? 'connected' : 'needs_auth'),
        ])
      if (pathname === '/api/agent/pay')
        return json({ mode: 'credits-then-wallet', route: 'goblin', routes: ['goblin', 'tempo'], walletReady: true })
      if (pathname === '/api/mcp/suggested')
        return json([
          {
            id: 'mysi',
            title: 'mysi',
            description: 'Your my* apps in one connection: notes, browsers, Telegram, email, skills and terminals.',
            endpoint: 'https://mysi.lol/mcp?codemode=off',
            group: 'yours',
            signIn: true,
            added: false,
          },
          {
            id: 'kiwi',
            title: 'Kiwi.com',
            description: 'Flight search across airlines, with prices and a booking link for each option.',
            endpoint: 'https://mcp.kiwi.com',
            group: 'travel',
            signIn: false,
            added: false,
          },
          {
            id: 'excalidraw',
            title: 'Excalidraw',
            description: 'Hand-drawn diagrams your agent sketches, live in the chat.',
            endpoint: 'https://mcp.excalidraw.com/mcp',
            group: 'apps',
            signIn: false,
            added: true,
          },
        ])
      return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'not here' } } })
    })
    await page.goto(`${origin}start.html?at=${encodeURIComponent(screen.at)}`)
    await page.waitForLoadState('networkidle')
    if (screen.name === 'splash') await page.getByRole('status').waitFor()
    else await page.locator('#start-title').waitFor()
    if (screen.name === 'wallet-setup') {
      await page.getByText('Create the agent wallet').waitFor()
      const finish = page.locator('a', { hasText: 'Finish setup in your wallet' })
      assert.equal(await finish.getAttribute('href'), SETUP_URL)
    }
    if (screen.name === 'wallet-ready') {
      await page.getByText('$24.50').waitFor()
      await page.getByRole('button', { name: 'Change' }).click()
      await page.getByText('Credits only').waitFor()
    }
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    assert(sideways <= 0, `${label} ${screen.name}: scrolls sideways by ${String(sideways)}px`)
    await page.screenshot({ path: path.join(out, `${label}-${screen.name}.png`), fullPage: true })
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
    hasTouch: true,
    isMobile: true,
    colorScheme: 'light',
  })
  await drive(browser, origin, 'desktop-dark', { viewport: { width: 1280, height: 800 }, colorScheme: 'dark' })
  assert.deepEqual(errors, [])
  writeSync(STDOUT, `${JSON.stringify({ ok: true, out })}\n`)
} finally {
  await browser.close()
  await vite.close()
}
