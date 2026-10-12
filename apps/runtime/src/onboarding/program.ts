import type {
  Grant,
  OnboardingState,
  OnboardingStep,
  OnboardingView,
  ServerView,
  WalletStatus,
} from '@goblin/contracts'
import { ONBOARDING_STEPS, type OnboardingChange, type OnboardingConnect } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { Entitlements } from '../billing/gates.ts'
import { Budget } from '../budget.ts'
import { Chats } from '../chats/service.ts'
import { epochSeconds } from '../clock.ts'
import { freeWalletUsd, stablecoinDollars } from '../layers/budget.ts'
import { profileOf, walletSetupUrl } from '../mcp/first-class.ts'
import { allowRecommended, serverStatus } from '../mcp/first-class-owner.ts'
import { McpGrants, McpServers } from '../mcp/service.ts'
import { reportAndRecover } from '../observability/report.ts'
import { AgentInput } from '../runtime/input.ts'
import { Onboarding } from './service.ts'
import type { OnboardingRecord } from './store.ts'

// First-run Start (ADR 0048): every step's state, read from what the agent already knows (its connections and grants,
// the wallet's own status) plus the little the owner tells it (the welcome, services, the kickoff). The wallet's setup and
// funds are the wallet's own: Start reads what it says is left and sends the owner to its setup page.

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

/**
 * The wallet's setup page for a signed-in wallet connection, back to Start's wallet step (`walletSetupUrl`); none before
 * it is connected, when the wallet would not know goblin's address to return to.
 */
const setupUrlOf = (wallet: Found, appUrl: string): string | undefined =>
  wallet.connected && wallet.server !== undefined
    ? walletSetupUrl(wallet.server.endpoint, new URL('/start/wallet', appUrl).href)
    : undefined

/** The wallet's state: its status (none until allowed and read), what it holds, set up to pay, and funded. */
type Wallet = {
  readonly status: WalletStatus | null
  readonly dollars: number | undefined
  readonly ready: boolean
  readonly funded: boolean
}

/**
 * Ready once its status reads with no setup left and an address goblin pays from; funded once ready and holding what
 * the plan asks (`needs` on the free plan, anything at all on another, which asks `0`).
 */
const walletState = (found: Found, status: WalletStatus | null, needs: number): Wallet => {
  const dollars = status === null ? undefined : stablecoinDollars(status)
  const ready = found.allowed && status !== null && status.setup === undefined && status.payFrom !== undefined
  const funded = ready && dollars !== undefined && (needs > 0 ? dollars >= needs : dollars > 0)
  return { status, dollars, ready, funded }
}

/** Each step's state, in Start's order: the wallet's from the wallet, the others from what the owner did. */
const stepsOf = (record: OnboardingRecord | undefined, wallet: Wallet) => {
  const went = (step: OnboardingStep) => record?.steps.includes(step) === true
  const done: Record<OnboardingStep, boolean> = {
    welcome: went('welcome'),
    wallet: wallet.funded,
    services: went('services'),
    goblin: record?.kickoffAt !== undefined || went('goblin'),
  }
  return ONBOARDING_STEPS.map((id) => ({ id, done: done[id] }))
}

/** The wallet as Start shows it: its connection, whether it is set up, what it still needs, holds and is asked to. */
const walletOf = (found: Found, wallet: Wallet, needs: number, setupUrl: string | undefined) => ({
  ...server(found),
  ready: wallet.ready,
  gaps: wallet.status?.setup ?? [],
  ...(setupUrl === undefined ? {} : { setupUrl }),
  ...(wallet.status?.payFrom === undefined ? {} : { payFrom: wallet.status.payFrom }),
  ...(wallet.dollars === undefined ? {} : { dollars: shown(wallet.dollars) }),
  needs: shown(needs),
  funded: wallet.funded,
})

/** The wallet's status as the owner, once its status tool is allowed; none otherwise or when it cannot be read. */
const walletStatus = (wallet: Found) =>
  wallet.allowed && wallet.server !== undefined
    ? // expected: an unreadable status leaves the wallet step open, and Start says it could not read it
      serverStatus(wallet.server.connectionId).pipe(Effect.orElseSucceed(() => null))
    : Effect.succeed(null)

/**
 * Keeps Start `done` once it is found complete, so the gate's later reads ask no server and Start never stands before
 * the chats of a set-up account again. A failure to keep it is reported; the next read finds it complete again.
 */
const keepDone = Effect.gen(function* () {
  const now = yield* epochSeconds
  yield* Onboarding.use((onboarding) => onboarding.change({ status: 'done' }, now))
}).pipe(reportAndRecover('onboarding.keepDone', undefined))

/**
 * Start's whole state. Until the owner finishes or skips it, Start is derived: open until the wallet is set up and
 * funded (Mercator is optional), and kept done the first time it is found so.
 */
export const onboardingView = Effect.gen(function* () {
  const { env } = yield* AgentInput
  const record = yield* Onboarding.use((onboarding) => onboarding.read)
  const servers = yield* McpServers.use((owner) => owner.list())
  const grants = yield* McpGrants.use((owner) => owner.list())
  const walletFound = find(servers, grants, 'wallet')
  const mercator = find(servers, grants, 'mercator')
  // Only the free plan asks the wallet to hold a sum (ADR 0047); any other plan is funded by anything it holds.
  const plan = yield* Entitlements.use((plans) => plans.state()).pipe(Effect.option)
  const free = Option.isNone(plan) || plan.value.source === 'free'
  const needs = free ? freeWalletUsd(env.FREE_WALLET_USD) : 0
  const wallet = walletState(walletFound, yield* walletStatus(walletFound), needs)
  if (record?.status === undefined && wallet.funded) yield* keepDone
  const others = servers.filter(
    (each) => each.status === 'connected' && each.profile?.id !== 'wallet' && each.profile?.id !== 'mercator',
  )
  const view: OnboardingView = {
    status: record?.status ?? (wallet.funded ? 'done' : 'open'),
    steps: stepsOf(record, wallet),
    wallet: walletOf(walletFound, wallet, needs, setupUrlOf(walletFound, env.APP_URL)),
    mercator: server(mercator),
    connected: others.length,
    kickoff: record?.kickoffAt !== undefined,
  }
  return view
})

/** The gate's answer from a view: its status and, while Start is open, the first step still to do. */
const stateOf = (view: OnboardingView): OnboardingState => {
  const step = view.status === 'open' ? view.steps.find((each) => !each.done)?.id : undefined
  return step === undefined ? { status: view.status } : { status: view.status, step }
}

/**
 * Whether Start stands before the chats, and where it picks up. A kept status (finished, skipped, or found complete)
 * is read locally; a derived one reads the view, which asks the wallet only once its status tool is allowed.
 */
export const onboardingState = Effect.gen(function* () {
  const record = yield* Onboarding.use((onboarding) => onboarding.read)
  if (record?.status !== undefined) return { status: record.status } satisfies OnboardingState
  return stateOf(yield* onboardingView)
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

/** How long after the kickoff goblin is reminded to propose Topics and Personas (seconds). */
const KICKOFF_WINDOW = 20 * 60

/** What the agent should know about setup, from the facts below; nothing when there is nothing to say. */
type SetupFacts = {
  readonly walletAllowed: boolean
  readonly unfunded: boolean
  /** The wallet's own setup page (`walletSetupUrl`), once it is connected. */
  readonly setupUrl: string | undefined
  readonly mercatorAllowed: boolean
  readonly kickoff: boolean
}

const KICKOFF_ASK =
  'The owner just finished setup and said in their first message what they want goblin for. If you have not yet, propose 2 to 4 Topics and at most 2 Personas that fit it, in one ask_user question (kind "multi", each option one Topic or Persona with a one-line why). Create only the ones they choose, with topic_create and persona_create.'

/** Where the owner manages the wallet, as the note names it: its setup page when known. */
const inWallet = (setupUrl: string | undefined): string =>
  setupUrl === undefined ? 'in the Goblin Wallet itself' : `in the Goblin Wallet itself, at ${setupUrl}`

/**
 * The setup note's lines: that goblin pays for itself from the wallet, who keeps Mercator funded, the pieces not set up
 * yet (Mercator marked optional), and the kickoff's ask.
 */
export const setupNote = ({
  walletAllowed,
  unfunded,
  setupUrl,
  mercatorAllowed,
  kickoff,
}: SetupFacts): string | undefined => {
  const gaps = [
    ...(walletAllowed
      ? []
      : ['- The Goblin Wallet is not connected or its tools are not allowed, so you cannot pay for anything.']),
    ...(walletAllowed && unfunded
      ? [
          `- The Goblin Wallet is not set up or not funded, so the free plan has no Credits; the owner finishes it ${inWallet(setupUrl)}.`,
        ]
      : []),
    ...(mercatorAllowed ? [] : ['- Mercator (optional) is not connected: no web search and no outside jobs.']),
  ]
  const lines = [
    // goblin pays its own way through the wallet; its setup and funds are the wallet's, never a transfer to goblin.
    ...(walletAllowed
      ? [
          `You pay for your own model calls and paid services from the owner's Goblin Wallet, within the limits they set there. Its setup and its funds are managed ${inWallet(setupUrl)}: when it is short, point the owner there.`,
        ]
      : []),
    // Mercator's own balance is goblin's to keep topped up from the wallet (ADR 0049), never the owner's chore.
    ...(mercatorAllowed && walletAllowed
      ? [
          "Mercator's balance is topped up from the Goblin Wallet before a job that needs it; never ask the owner to fund Mercator by hand.",
        ]
      : []),
    ...(gaps.length === 0
      ? []
      : [
          'Not set up yet (the owner does it at /start, "Set up goblin"):',
          ...gaps,
          'Only when the owner asks for something that needs a missing piece, say which one in one line and point to Set up goblin. Do not bring it up otherwise.',
        ]),
    ...(kickoff ? [KICKOFF_ASK] : []),
  ]
  return lines.length === 0 ? undefined : lines.join('\n')
}

/**
 * What goblin's context block says about setup, in main only (`setupNote`). Read from what the agent knows locally
 * (its connections, grants and configuration) and the budget's own kept reading of the wallet, so it costs no call to
 * any server.
 */
export const onboardingContext = (session: string) =>
  Effect.gen(function* () {
    const chats = yield* Chats
    if ((yield* chats.session(chats.primary)) !== session) return undefined
    const { env } = yield* AgentInput
    const now = yield* epochSeconds
    const record = yield* Onboarding.use((onboarding) => onboarding.read)
    const servers = yield* McpServers.use((owner) => owner.list())
    const grants = yield* McpGrants.use((owner) => owner.list())
    const today = yield* Budget.use((budget) => budget.today(now))
    const wallet = find(servers, grants, 'wallet')
    return setupNote({
      walletAllowed: wallet.allowed,
      unfunded: today.limit === 0,
      setupUrl: setupUrlOf(wallet, env.APP_URL),
      mercatorAllowed: find(servers, grants, 'mercator').allowed,
      kickoff: record?.kickoffAt !== undefined && now - record.kickoffAt < KICKOFF_WINDOW,
    })
  })
