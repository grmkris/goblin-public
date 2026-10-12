import type { Grant, OnboardingStep, OnboardingView, ServerView, WalletStatus } from '@goblin/contracts'
import { ONBOARDING_STEPS, type OnboardingChange, type OnboardingConnect } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import { epochSeconds } from '../clock.ts'
import { freeWalletUsd, stablecoinDollars } from '../layers/budget.ts'
import { profileOf } from '../mcp/first-class.ts'
import { allowRecommended, serverStatus } from '../mcp/first-class-owner.ts'
import { McpGrants, McpServers } from '../mcp/service.ts'
import { reportAndRecover } from '../observability/report.ts'
import { AgentInput } from '../runtime/input.ts'
import { Onboarding } from './service.ts'
import type { OnboardingRecord } from './store.ts'

// First-run Start (ADR 0048): every step's state, read from what the agent already knows (its connections and grants,
// the wallet's own status) plus the little the owner tells it (how goblin pays, more services, the kickoff).

type Found = { readonly server: ServerView | undefined; readonly connected: boolean; readonly allowed: boolean }

/** The tools Start needs a first-class server to run: its status tool, and the wallet's payment tool. */
const essentials = (endpoint: string): readonly string[] => {
  const profile = profileOf(endpoint)
  return [profile?.statusTool?.name, profile?.payment?.tool].filter((name): name is string => name !== undefined)
}

/** The owner's connection to first-class server `id`: a signed-in one first, else any (the stage's configured one). */
const find = (servers: readonly ServerView[], grants: readonly Grant[], id: string): Found => {
  const all = servers.filter((server) => server.profile?.id === id)
  const server = all.find((each) => each.status === 'connected') ?? all[0]
  if (server?.status !== 'connected') return { server, connected: false, allowed: false }
  const granted = (name: string) =>
    grants.some(
      (grant) => grant.connectionId === server.connectionId && grant.capability === 'tool' && grant.name === name,
    )
  return { server, connected: true, allowed: essentials(server.endpoint).every(granted) }
}

const server = ({ server: found, connected, allowed }: Found) => ({
  ...(found === undefined ? {} : { connectionId: found.connectionId }),
  connected,
  allowed,
})

/** Dollars as Start shows them: `0`, `4.93`. */
const shown = (dollars: number): string => String(Math.round(dollars * 100) / 100)

type Funds = { readonly status: WalletStatus | null; readonly dollars: number | undefined; readonly funded: boolean }

/** What the wallet holds against what the free plan asks of it (`0` asks only for something). */
const fundsOf = (status: WalletStatus | null, needs: number): Funds => {
  const dollars = status === null ? undefined : stablecoinDollars(status)
  return { status, dollars, funded: dollars !== undefined && (needs > 0 ? dollars >= needs : dollars > 0) }
}

/** Each step's state, in Start's order. */
const stepsOf = (record: OnboardingRecord | undefined, wallet: Found, mercator: Found, funds: Funds) => {
  const went = (step: OnboardingStep) => record?.steps.includes(step) === true
  const done: Record<OnboardingStep, boolean> = {
    wallet: wallet.allowed,
    funds: funds.funded,
    pay: went('pay'),
    mercator: mercator.allowed,
    more: went('more'),
    goblin: record?.kickoffAt !== undefined || went('goblin'),
  }
  return ONBOARDING_STEPS.map((id) => ({ id, done: done[id] }))
}

/** The wallet as Start shows it: its connection, where it pays from, what it holds and what it needs. */
const walletOf = (wallet: Found, funds: Funds, needs: number) => ({
  ...server(wallet),
  ...(funds.status?.payFrom === undefined ? {} : { payFrom: funds.status.payFrom }),
  ...(funds.dollars === undefined ? {} : { dollars: shown(funds.dollars) }),
  needs: shown(needs),
  funded: funds.funded,
})

/** The wallet's status as the owner, once its status tool is allowed; none otherwise or when it cannot be read. */
const walletStatus = (wallet: Found) =>
  wallet.allowed && wallet.server !== undefined
    ? // expected: an unreadable status leaves the funds step open, and Start says it could not read it
      serverStatus(wallet.server.connectionId).pipe(Effect.orElseSucceed(() => null))
    : Effect.succeed(null)

/**
 * Start's whole state. Untouched by the owner, Start is open until the wallet is funded and Mercator is in; after
 * that it is what the owner made it.
 */
export const onboardingView = Effect.gen(function* () {
  const { env } = yield* AgentInput
  const record = yield* Onboarding.use((onboarding) => onboarding.read)
  const servers = yield* McpServers.use((owner) => owner.list())
  const grants = yield* McpGrants.use((owner) => owner.list())
  const wallet = find(servers, grants, 'wallet')
  const mercator = find(servers, grants, 'mercator')
  const needs = freeWalletUsd(env.FREE_WALLET_USD)
  const funds = fundsOf(yield* walletStatus(wallet), needs)
  const complete = wallet.allowed && funds.funded && mercator.allowed
  const others = servers.filter(
    (each) => each.status === 'connected' && each.profile?.id !== 'wallet' && each.profile?.id !== 'mercator',
  )
  const view: OnboardingView = {
    status: record?.status ?? (complete ? 'done' : 'open'),
    steps: stepsOf(record, wallet, mercator, funds),
    wallet: walletOf(wallet, funds, needs),
    mercator: server(mercator),
    connected: others.length,
    kickoff: record?.kickoffAt !== undefined,
  }
  return view
})

/** Whether Start stands before the chats: the owner's own word, else the view's derived status. */
export const onboardingState = Effect.gen(function* () {
  const record = yield* Onboarding.use((onboarding) => onboarding.read)
  if (record !== undefined) return { status: record.status }
  return { status: (yield* onboardingView).status }
})

/** The owner finishes, skips or reopens Start, goes through a step, or sends the kickoff; answered with the view. */
export const changeOnboarding = (change: OnboardingChange) =>
  Effect.gen(function* () {
    const now = yield* epochSeconds
    yield* Onboarding.use((onboarding) => onboarding.change(change, now))
    return yield* onboardingView
  })

/**
 * After a sign-in Start began comes back: the server's recommended tools allowed if the owner left that ticked, and
 * the step to return to. None for a sign-in Start did not begin, which comes back to Connections as before.
 */
export const connectedFromStart = (connectionId: string) =>
  Effect.gen(function* () {
    const now = yield* epochSeconds
    const started = yield* Onboarding.use((onboarding) => onboarding.takeConnect(connectionId, now))
    if (started === undefined) return undefined
    if (started.recommend)
      yield* allowRecommended(connectionId).pipe(reportAndRecover('onboarding.allowRecommended', undefined))
    return started.step
  })

/** Start signs the owner in to a server and notes where to bring them back; connected at once, it is done now. */
export const startConnect = (request: OnboardingConnect) =>
  Effect.gen(function* () {
    const now = yield* epochSeconds
    const { connectionId, step, recommend } = request
    yield* Onboarding.use((onboarding) => onboarding.noteConnect(connectionId, { step, recommend }, now))
    const started = yield* McpServers.use((servers) => servers.beginConnect(connectionId))
    if (started.authorizationUrl === undefined) yield* connectedFromStart(connectionId)
    return started
  })
