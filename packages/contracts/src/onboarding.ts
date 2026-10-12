import * as Schema from 'effect/Schema'

/**
 * First-run Start (ADR 0048): `open` until the owner finishes or skips it, or derived when they never touched it
 * (open while the wallet or Mercator is missing, done otherwise).
 */
export const OnboardingStatus = Schema.Literals(['open', 'done', 'skipped'])
export type OnboardingStatus = typeof OnboardingStatus.Type

/** Start's steps, in order: the wallet, its funds, how goblin pays, Mercator, more services, and what goblin is for. */
export const ONBOARDING_STEPS = ['wallet', 'funds', 'pay', 'mercator', 'more', 'goblin'] as const
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

/** Where goblin pays from, and what the free plan asks it to hold. */
const OnboardingWallet = Schema.Struct({
  ...OnboardingServer.fields,
  payFrom: Schema.optional(Schema.Struct({ address: Short, chain: Short, token: Short, held: Schema.optional(Short) })),
  /** The stablecoin dollars the wallet holds on every chain it reads; absent until its status can be read. */
  dollars: Schema.optional(Short),
  /** The dollars the free plan asks the wallet to hold (`GOBLIN_FREE_WALLET_USD`); `0` asks for none. */
  needs: Short,
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

/** `GET /api/onboarding/status`: whether Start still stands before the chats, read without asking any server. */
export const OnboardingState = Schema.Struct({ status: OnboardingStatus })
export type OnboardingState = typeof OnboardingState.Type

/** `PUT /api/onboarding`: finish, skip or reopen Start, mark a step the owner went through, or record the kickoff. */
export const OnboardingChange = Schema.Struct({
  status: Schema.optional(OnboardingStatus),
  step: Schema.optional(OnboardingStep),
  kickoff: Schema.optional(Schema.Literal(true)),
})
export type OnboardingChange = typeof OnboardingChange.Type
