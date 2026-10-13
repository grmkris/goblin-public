import { describe, expect, it } from '@effect/vitest'
import type { Grant, ServerView } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { afterEach } from 'vitest'
import { OnboardingLive } from '../src/layers/onboarding.ts'
import { profileOf, profileView } from '../src/mcp/first-class.ts'
import { McpConnections, McpGrants, McpServers } from '../src/mcp/service.ts'
import { Entitlements } from '../src/billing/gates.ts'
import type { AccountPlan } from '../src/billing/reconcile.ts'
import { Budget } from '../src/budget.ts'
import { Chats } from '../src/chats/service.ts'
import { changeOnboarding, onboardingContext, onboardingState, onboardingView } from '../src/onboarding/program.ts'
import { Onboarding } from '../src/onboarding/service.ts'
import { AgentInput, type AgentInputs } from '../src/runtime/input.ts'
import { stub } from './http/api/fixture.ts'
import { OnboardingStore } from '../src/onboarding/store.ts'
import { chatDatabase, durable, sqliteDb } from './chats-sqlite.ts'

const WALLET = 'https://wallet.goblin.surf/mcp'
const MERCATOR = 'https://mercator.sh/mcp/auth'
const PAY_FROM = { address: `0x${'b'.repeat(40)}`, chain: 'tempo', token: 'USDC.e', held: '4.93' }
/** The wallet's own setup page, back to Start's wallet step on this goblin (`APP_URL` below). */
const SETUP_URL = 'https://wallet.goblin.surf/setup?return=https%3A%2F%2Fgoblin.test%2Fstart%2Fwallet'
const FUNDS_URL = 'https://wallet.goblin.surf/add-funds?return=https%3A%2F%2Fgoblin.test%2Fstart%2Fwallet'
const GAPS = ['create the agent wallet', 'sign the spending allowance']

/** A first-class server as the owner's list shows it. */
const server = (connectionId: string, endpoint: string, status: ServerView['status']): ServerView => ({
  connectionId,
  label: connectionId,
  endpoint,
  status,
  live: status === 'connected',
  source: 'config',
  profile: profileView(profileOf(endpoint) ?? expect.fail(`no profile for ${endpoint}`)),
})

const tool = (connectionId: string, name: string): Grant => ({ connectionId, capability: 'tool', name })

const closes: (() => void)[] = []
afterEach(() => {
  for (const close of closes.splice(0)) close()
})

/** What the wallet's status tool answers, and whether the account has goblin Pro (ADR 0054). */
type Wallet = {
  readonly dollars?: string
  readonly setup?: readonly string[]
  readonly payFrom?: typeof PAY_FROM
  readonly pro?: boolean
}

/**
 * Start over real SQLite, with the owner's servers, grants and the wallet's own status answer; `reads` counts the
 * wallet's status reads.
 */
const start = (
  servers: readonly ServerView[],
  grants: readonly Grant[],
  { dollars = '0', setup, payFrom = PAY_FROM, pro = false }: Wallet = {},
) => {
  const { db, close } = chatDatabase()
  closes.push(close)
  const reads: string[] = []
  const answer = {
    status: { paid: 'ready', funding: 'ready', tokens: [], stablecoinUsd: dollars },
    payFrom,
    ...(setup === undefined ? {} : { setup }),
  }
  const layer = OnboardingLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        sqliteDb(db),
        stub(McpServers, { list: () => Effect.succeed(servers) }),
        stub(McpGrants, { list: () => Effect.succeed(grants) }),
        stub(McpConnections, {
          server: (connectionId) =>
            // SAFETY: the status read takes only the server's endpoint, to find its profile.
            Effect.succeed({
              connectionId,
              endpoint: servers.find((each) => each.connectionId === connectionId)?.endpoint ?? '',
            } as never),
          callTool: (_connectionId, name) =>
            Effect.sync(() => {
              reads.push(name)
              return { content: [], structuredContent: answer }
            }),
        }),
        // SAFETY: Start reads only whether the plan is active.
        stub(Entitlements, {
          state: () => Effect.succeed({ source: pro ? 'wallet' : 'none', active: pro } as AccountPlan),
        }),
        // SAFETY: Start reads only the app's address from the instance input.
        Layer.succeed(AgentInput, { env: { APP_URL: 'https://goblin.test' } } as AgentInputs),
        // Main is session `s1`; the day's allowance is none until the wallet holds the free plan's dollars.
        // SAFETY: the setup note reads only main's chat id and its session from the directory.
        stub(Chats, { primary: '1', session: (chat: string) => Effect.succeed(chat === '1' ? 's1' : 's2') } as never),
        stub(Budget, {
          today: () => Effect.succeed({ used: 0, limit: Number(dollars) >= 5 ? 200 : 0, resetsAt: 0 }),
        }),
      ),
    ),
  )
  return { layer, reads, db }
}

const everything = [server('wallet', WALLET, 'connected'), server('mercator', MERCATOR, 'connected')]
const allowed = [
  tool('wallet', 'wallet_status'),
  tool('wallet', 'pay_challenge'),
  tool('mercator', 'get_connection_status'),
]
const walletOnly = [server('wallet', WALLET, 'connected'), server('mercator', MERCATOR, 'needs_auth')]
const walletAllowed = allowed.filter((grant) => grant.connectionId === 'wallet')

const kept = Onboarding.use((onboarding) => onboarding.read)
const done = (view: { readonly steps: readonly { readonly id: string; readonly done: boolean }[] }) =>
  view.steps.filter((step) => step.done).map((step) => step.id)

describe('first-run Start (ADR 0048)', () => {
  it.effect('is open on its welcome, every step to do, for an account with nothing connected', () =>
    Effect.gen(function* () {
      const view = yield* onboardingView
      expect(view.status).toBe('open')
      expect(view.steps.map((step) => step.id)).toEqual(['welcome', 'wallet', 'services', 'goblin'])
      expect(view.steps.every((step) => !step.done)).toBe(true)
      expect(view.wallet).toEqual({
        connectionId: 'wallet',
        connected: false,
        allowed: false,
        ready: false,
        gaps: [],
        needs: '0',
        funded: false,
      })
      expect(yield* onboardingState).toEqual({ status: 'open', step: 'welcome' })
      expect(yield* kept).toBeUndefined()
    }).pipe(Effect.provide(start([server('wallet', WALLET, 'needs_auth')], []).layer)),
  )

  it.effect(
    "is not ready while the wallet lists setup, whatever it holds, and offers the wallet's own setup page",
    () =>
      Effect.gen(function* () {
        const view = yield* onboardingView
        expect(view.wallet).toMatchObject({
          allowed: true,
          ready: false,
          gaps: GAPS,
          setupUrl: SETUP_URL,
          fundsUrl: FUNDS_URL,
          dollars: '20',
          funded: false,
        })
        expect(view.status).toBe('open')
        // Going through the welcome moves the gate on to the wallet, and leaves Start derived.
        yield* changeOnboarding({ step: 'welcome' })
        expect(yield* onboardingState).toEqual({ status: 'open', step: 'wallet' })
        expect((yield* kept)?.status).toBeUndefined()
      }).pipe(Effect.provide(start(everything, allowed, { dollars: '20', setup: GAPS }).layer)),
  )

  it.effect('is not ready without an address to pay from, and reads nothing before the status tool is allowed', () => {
    const { layer, reads } = start(everything, [], { dollars: '20' })
    return Effect.gen(function* () {
      const view = yield* onboardingView
      expect(view.wallet).toMatchObject({ connected: true, allowed: false, ready: false, setupUrl: SETUP_URL })
      expect(reads).toEqual([])
    }).pipe(Effect.provide(layer))
  })

  it.effect(
    'is done, untouched, once the wallet is set up and funded and Pro is on, without Mercator, and keeps that',
    () => {
      const { layer, reads } = start(walletOnly, walletAllowed, { dollars: '6.5', pro: true })
      return Effect.gen(function* () {
        const view = yield* onboardingView
        expect(view.status).toBe('done')
        expect(view.wallet).toMatchObject({ ready: true, gaps: [], payFrom: PAY_FROM, dollars: '6.5', funded: true })
        expect(view.mercator).toMatchObject({ connected: false, allowed: false })
        expect(done(view)).toEqual(['wallet'])
        expect((yield* kept)?.status).toBe('done')
        // Kept, the gate's answer asks no server.
        const before = reads.length
        expect(yield* onboardingState).toEqual({ status: 'done' })
        expect(reads).toHaveLength(before)
      }).pipe(Effect.provide(layer))
    },
  )

  it.effect("stays open while a ready, funded wallet has no Pro: choosing it is where the wallet's step ends", () =>
    Effect.gen(function* () {
      const view = yield* onboardingView
      expect(view.wallet).toMatchObject({ ready: true, dollars: '3', funded: true })
      expect(view.status).toBe('open')
      expect(done(view)).toEqual([])
      expect((yield* kept)?.status).toBeUndefined()
    }).pipe(Effect.provide(start(everything, allowed, { dollars: '3' }).layer)),
  )

  it.effect('counts any dollars as funded: the wallet holds no set sum, Pro is what goblin needs', () =>
    Effect.gen(function* () {
      const view = yield* onboardingView
      expect(view.wallet).toMatchObject({ needs: '0', ready: true, funded: true })
      expect(view.status).toBe('done')
    }).pipe(Effect.provide(start(everything, allowed, { dollars: '0.5', pro: true }).layer)),
  )

  it.effect("keeps the owner's word over what it would derive, each step once, and the first kickoff", () =>
    Effect.gen(function* () {
      yield* changeOnboarding({ step: 'welcome' })
      yield* changeOnboarding({ step: 'welcome' })
      const skipped = yield* changeOnboarding({ status: 'skipped', step: 'services' })
      expect(skipped.status).toBe('skipped')
      expect(done(skipped)).toEqual(['welcome', 'services'])
      expect(yield* onboardingState).toEqual({ status: 'skipped' })
      // A step alone keeps the kept status; `open` forgets it, and Start is derived again.
      expect((yield* changeOnboarding({ step: 'goblin' })).status).toBe('skipped')
      expect((yield* changeOnboarding({ status: 'open' })).status).toBe('open')
      expect(yield* onboardingState).toEqual({ status: 'open', step: 'wallet' })
      const finished = yield* changeOnboarding({ status: 'done', step: 'goblin', kickoff: true })
      expect(finished).toMatchObject({ status: 'done', kickoff: true })
    }).pipe(Effect.provide(start([], []).layer)),
  )

  it.effect('never pins Start open when the owner goes through a step: it is done as soon as the wallet is', () =>
    Effect.gen(function* () {
      const view = yield* changeOnboarding({ step: 'welcome' })
      expect(view.status).toBe('done')
      expect((yield* kept)?.status).toBe('done')
    }).pipe(Effect.provide(start(walletOnly, walletAllowed, { dollars: '6.5', pro: true }).layer)),
  )

  it('reads an older Start\'s row: the steps it no longer has are dropped, and its "open" is derived', () => {
    const { db, sqlite, close } = chatDatabase()
    closes.push(close)
    const store = new OnboardingStore(durable(db))
    sqlite.exec(
      `INSERT INTO app_onboarding (id, status, steps, updated_at) VALUES (1, 'open', '["wallet","funds","pay","mercator","more","goblin","goblin"]', 1000)`,
    )
    expect(store.get()).toEqual({ status: undefined, steps: ['wallet', 'goblin'], kickoffAt: undefined })
    sqlite.exec(`UPDATE app_onboarding SET steps = 'not json' WHERE id = 1`)
    expect(store.get()?.steps).toEqual([])
  })

  it('remembers where a sign-in Start began comes back to, once, and not after an hour', () => {
    const { db, close } = chatDatabase()
    closes.push(close)
    const store = new OnboardingStore(durable(db))
    store.noteConnect('wallet', { step: 'wallet', recommend: true }, 1000)
    store.noteConnect('wallet', { step: 'services', recommend: false }, 1100)
    expect(store.takeConnect('wallet', 1200)).toEqual({ step: 'services', recommend: false })
    expect(store.takeConnect('wallet', 1200)).toBeUndefined()
    store.noteConnect('mercator', { step: 'services', recommend: true }, 1000)
    expect(store.takeConnect('mercator', 1000 + 59 * 60)).toEqual({ step: 'services', recommend: true })
    store.noteConnect('mercator', { step: 'services', recommend: true }, 1000)
    expect(store.takeConnect('mercator', 1000 + 61 * 60)).toBeUndefined()
  })

  it.effect('tells goblin in main only that it pays from the wallet, where to set it up, and what is missing', () =>
    Effect.gen(function* () {
      const missing = yield* onboardingContext('s1')
      expect(missing).toContain('You pay for your own model calls and paid services')
      expect(missing).toContain('The Goblin Wallet is not set up or not funded')
      expect(missing).toContain(SETUP_URL)
      expect(missing).toContain('Mercator (optional) is not connected')
      expect(missing).not.toContain('ask_user')
      expect(yield* onboardingContext('s2')).toBeUndefined()
    }).pipe(Effect.provide(start(walletOnly, walletAllowed, { dollars: '3' }).layer)),
  )

  it.effect('says the wallet is missing before it is connected, with no setup page to send the owner to', () => {
    const { layer, reads } = start([server('wallet', WALLET, 'needs_auth')], [])
    return Effect.gen(function* () {
      const note = yield* onboardingContext('s1')
      expect(note).toContain('The Goblin Wallet is not connected')
      expect(note).not.toContain('/setup')
      expect(note).not.toContain('You pay for your own')
      expect(reads).toEqual([])
    }).pipe(Effect.provide(layer))
  })

  it.effect('asks goblin to propose Topics and Personas right after the kickoff, even with nothing missing', () =>
    Effect.gen(function* () {
      // All set: only that goblin pays from the wallet, and Mercator's balance is goblin's to top up (ADR 0049).
      const settled = yield* onboardingContext('s1')
      expect(settled).toContain('never ask the owner to fund Mercator')
      expect(settled).not.toContain('Not set up yet')
      expect(settled).not.toContain('ask_user')
      yield* changeOnboarding({ status: 'done', step: 'goblin', kickoff: true })
      const kickoff = yield* onboardingContext('s1')
      expect(kickoff).toContain('ask_user')
      expect(kickoff).not.toContain('Not set up yet')
    }).pipe(Effect.provide(start(everything, allowed, { dollars: '6.5' }).layer)),
  )
})
