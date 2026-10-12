import * as Schema from 'effect/Schema'
import { SetupGaps } from './mcp.ts'

/**
 * First-run Start (ADR 0048): `done` or `skipped` once the owner said so (or Start was found complete, which is kept),
 * `open` while it is derived and the wallet is not yet set up and funded.
 */
export const OnboardingStatus = Schema.Literals(['open', 'done', 'skipped'])
export type OnboardingStatus = typeof OnboardingStatus.Type

/**
 * Start's steps, in order: what goblin is, the Goblin Wallet (set up and funded in the wallet itself), how goblin
 * reaches outside services (Mercator first, optional), and what goblin is for.
 */
export const ONBOARDING_STEPS = ['welcome', 'wallet', 'services', 'goblin'] as const
export const OnboardingStep = Schema.Literals(ONBOARDING_STEPS)
export type OnboardingStep = typeof OnboardingStep.Type

const Short = Schema.String.check(Schema.isMaxLength(64))

/** A first-class server Start asks for: its connection, whether it is signed in, and whether its essentials run. */
const OnboardingServer = Schema.Struct({
  connectionId: Schema.optional(Short),
  connected: Schema.Boolean,
  /** Its status tool (and, for the wallet, its payment tool) is allowed, so goblin can read and pay through it. */
  allowed: Schema.Boolean,
})

/** The Goblin Wallet as Start shows it: whether it is set up to pay, what it still needs, and what it holds. */
const OnboardingWallet = Schema.Struct({
  ...OnboardingServer.fields,
  /**
   * Set up in the wallet: connected and allowed, its status read, no setup left on the wallet's own list, and an address
   * goblin pays from.
   */
  ready: Schema.Boolean,
  /**
   * What the wallet says is still to set up there, in its own words ("create the agent wallet"): the server's claim,
   * shown as plain text only. Empty when nothing is left or the status could not be read.
   */
  gaps: SetupGaps,
  /**
   * The wallet's own setup page (`<wallet origin>/setup?return=…`), which brings the owner back to Start's wallet step:
   * built from the connection's configured endpoint, never from what the server says. Absent until it is connected.
   */
  setupUrl: Schema.optional(Schema.String),
  /** The wallet's Add funds page, built the same way and back to the same step, for a wallet set up but short. */
  fundsUrl: Schema.optional(Schema.String),
  payFrom: Schema.optional(Schema.Struct({ address: Short, chain: Short, token: Short, held: Schema.optional(Short) })),
  /** The stablecoin dollars the wallet holds on every chain it reads; absent until its status can be read. */
  dollars: Schema.optional(Short),
  /** The dollars the free plan asks the wallet to hold (`GOBLIN_FREE_WALLET_USD`); `0` asks for none. */
  needs: Short,
  /** Ready, and holding what the plan asks: `needs` on the free plan, anything at all on another. */
  funded: Schema.Boolean,
})

/** `GET /api/onboarding`: Start's whole state, read live from the servers it asks for. */
export const OnboardingView = Schema.Struct({
  status: OnboardingStatus,
  steps: Schema.Array(Schema.Struct({ id: OnboardingStep, done: Schema.Boolean })),
  wallet: OnboardingWallet,
  mercator: OnboardingServer,
  /** Connected servers other than the wallet and Mercator. */
  connected: Schema.Number,
  kickoff: Schema.Boolean,
})
export type OnboardingView = typeof OnboardingView.Type

/**
 * `GET /api/onboarding/status`: whether Start stands before the chats and, while it does, the first step still to do.
 * Kept answers (done, skipped) are read without asking any server.
 */
export const OnboardingState = Schema.Struct({ status: OnboardingStatus, step: Schema.optional(OnboardingStep) })
export type OnboardingState = typeof OnboardingState.Type

/**
 * `PUT /api/onboarding`: finish or skip Start (`open` forgets that, so it is derived again), mark a step the owner went
 * through, or record the kickoff. Only `status` changes the status: going through a step leaves it as it was.
 */
export const OnboardingChange = Schema.Struct({
  status: Schema.optional(OnboardingStatus),
  step: Schema.optional(OnboardingStep),
  kickoff: Schema.optional(Schema.Literal(true)),
})
export type OnboardingChange = typeof OnboardingChange.Type

/**
 * `POST /api/onboarding/connect`: Start signs the owner in to `connectionId` and brings them back to `step`; with
 * `recommend`, the server's recommended tools are allowed once it is connected (the owner unticks it to choose later).
 */
export const OnboardingConnect = Schema.Struct({
  connectionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  step: OnboardingStep,
  recommend: Schema.Boolean,
})
export type OnboardingConnect = typeof OnboardingConnect.Type
