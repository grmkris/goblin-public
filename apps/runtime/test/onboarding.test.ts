import { describe, expect, it } from '@effect/vitest'
import type { Grant, ServerView } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { afterEach } from 'vitest'
import { OnboardingLive } from '../src/layers/onboarding.ts'
import { profileOf, profileView } from '../src/mcp/first-class.ts'
import { McpConnections, McpGrants, McpServers } from '../src/mcp/service.ts'
import { Budget } from '../src/budget.ts'
import { Chats } from '../src/chats/service.ts'
import { changeOnboarding, onboardingContext, onboardingState, onboardingView } from '../src/onboarding/program.ts'
import { AgentInput, type AgentInputs } from '../src/runtime/input.ts'
import { stub } from './http/api/fixture.ts'
import { OnboardingStore } from '../src/onboarding/store.ts'
import { chatDatabase, durable, sqliteDb } from './chats-sqlite.ts'

const WALLET = 'https://wallet.goblin.surf/mcp'
const MERCATOR = 'https://mercator.sh/mcp/auth'
const PAY_FROM = { address: `0x${'b'.repeat(40)}`, chain: 'tempo', token: 'USDC.e', held: '4.93' }

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

/** Start over real SQLite, with the owner's servers, grants and the wallet's own status answer (dollars held). */
const start = (servers: readonly ServerView[], grants: readonly Grant[], dollars = '0') => {
  const { db, close } = chatDatabase()
  closes.push(close)
  const answer = {
    status: { paid: 'ready', funding: 'ready', tokens: [], stablecoinUsd: dollars },
    payFrom: PAY_FROM,
  }
  return OnboardingLive.pipe(
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
          callTool: () => Effect.succeed({ content: [], structuredContent: answer }),
        }),
        // SAFETY: Start reads only the stage's free-plan dollars from the instance input.
        Layer.succeed(AgentInput, { env: { FREE_WALLET_USD: '5' } } as AgentInputs),
        // Main is session `s1`; the day's allowance is none until the wallet holds the free plan's dollars.
        // SAFETY: the setup note reads only main's chat id and its session from the directory.
        stub(Chats, { primary: '1', session: (chat: string) => Effect.succeed(chat === '1' ? 's1' : 's2') } as never),
        stub(Budget, {
          today: () => Effect.succeed({ used: 0, limit: Number(dollars) >= 5 ? 200 : 0, resetsAt: 0 }),
        }),
      ),
    ),
  )
}

const everything = [server('wallet', WALLET, 'connected'), server('mercator', MERCATOR, 'connected')]
const allowed = [
  tool('wallet', 'wallet_status'),
  tool('wallet', 'pay_challenge'),
  tool('mercator', 'get_connection_status'),
]

describe('first-run Start (ADR 0048)', () => {
  it.effect('is open, every step to do, for an account with nothing connected', () =>
    Effect.gen(function* () {
      const view = yield* onboardingView
      expect(view.status).toBe('open')
      expect(view.steps.map((step) => step.id)).toEqual(['wallet', 'funds', 'pay', 'mercator', 'more', 'goblin'])
      expect(view.steps.every((step) => !step.done)).toBe(true)
      expect(view.wallet).toEqual({
        connectionId: 'wallet',
        connected: false,
        allowed: false,
        needs: '5',
        funded: false,
      })
      expect((yield* onboardingState).status).toBe('open')
    }).pipe(Effect.provide(start([server('wallet', WALLET, 'needs_auth')], []))),
  )

  it.effect('is done, untouched, for an account whose funded wallet and Mercator are in', () =>
    Effect.gen(function* () {
      const view = yield* onboardingView
      expect(view.status).toBe('done')
      expect(view.wallet).toMatchObject({ allowed: true, payFrom: PAY_FROM, dollars: '6.5', funded: true })
      expect(view.steps.filter((step) => step.done).map((step) => step.id)).toEqual(['wallet', 'funds', 'mercator'])
      expect((yield* onboardingState).status).toBe('done')
    }).pipe(Effect.provide(start(everything, allowed, '6.5'))),
  )

  it.effect('stays open while the wallet holds less than the free plan asks, or its tools are not allowed', () =>
    Effect.gen(function* () {
      const view = yield* onboardingView
      expect(view.wallet).toMatchObject({ allowed: true, dollars: '3', funded: false })
      expect(view.status).toBe('open')
    }).pipe(Effect.provide(start(everything, allowed, '3'))),
  )

  it.effect("keeps the owner's word over what it would derive, each step once, and the first kickoff", () =>
    Effect.gen(function* () {
      yield* changeOnboarding({ step: 'pay' })
      yield* changeOnboarding({ step: 'pay' })
      const skipped = yield* changeOnboarding({ status: 'skipped', step: 'more' })
      expect(skipped.status).toBe('skipped')
      expect(skipped.steps.filter((step) => step.done).map((step) => step.id)).toEqual(['pay', 'more'])
      expect((yield* onboardingState).status).toBe('skipped')
      const finished = yield* changeOnboarding({ status: 'done', step: 'goblin', kickoff: true })
      expect(finished).toMatchObject({ status: 'done', kickoff: true })
    }).pipe(Effect.provide(start([], []))),
  )

  it('remembers where a sign-in Start began comes back to, once, and not after half an hour', () => {
    const { db, close } = chatDatabase()
    closes.push(close)
    const store = new OnboardingStore(durable(db))
    store.noteConnect('wallet', { step: 'wallet', recommend: true }, 1000)
    store.noteConnect('wallet', { step: 'funds', recommend: false }, 1100)
    expect(store.takeConnect('wallet', 1200)).toEqual({ step: 'funds', recommend: false })
    expect(store.takeConnect('wallet', 1200)).toBeUndefined()
    store.noteConnect('mercator', { step: 'mercator', recommend: true }, 1000)
    expect(store.takeConnect('mercator', 1000 + 31 * 60)).toBeUndefined()
  })

  it.effect('tells goblin in main only what setup misses, one line each, and nothing once it is all there', () =>
    Effect.gen(function* () {
      const missing = yield* onboardingContext('s1')
      expect(missing).toContain('The Goblin Wallet is not funded')
      expect(missing).not.toContain('Mercator is not connected')
      expect(missing).not.toContain('ask_user')
      expect(yield* onboardingContext('s2')).toBeUndefined()
    }).pipe(Effect.provide(start(everything, allowed, '3'))),
  )

  it.effect('asks goblin to propose Topics and Personas right after the kickoff, even with nothing missing', () =>
    Effect.gen(function* () {
      expect(yield* onboardingContext('s1')).toBeUndefined()
      yield* changeOnboarding({ status: 'done', step: 'goblin', kickoff: true })
      const kickoff = yield* onboardingContext('s1')
      expect(kickoff).toContain('ask_user')
      expect(kickoff).not.toContain('Setup still missing')
    }).pipe(Effect.provide(start(everything, allowed, '6.5'))),
  )
})
