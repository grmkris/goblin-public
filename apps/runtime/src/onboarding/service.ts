import type { OnboardingChange } from '@goblin/contracts'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type { AppError } from '../http/errors.ts'
import type { OnboardingRecord, StartedConnect } from './store.ts'

/** What the owner did with first-run Start (ADR 0048), kept by the agent. */
export class Onboarding extends Context.Service<
  Onboarding,
  {
    /** The stored record; none until the owner acted on Start. */
    readonly read: Effect.Effect<OnboardingRecord | undefined>
    /** Applies the owner's change at `now` (epoch seconds). */
    readonly change: (change: OnboardingChange, now: number) => Effect.Effect<OnboardingRecord, AppError>
    /** Notes a sign-in Start sent the owner to, to come back to its step. */
    readonly noteConnect: (connectionId: string, started: StartedConnect, now: number) => Effect.Effect<void, AppError>
    /** Takes that note when the sign-in comes back; none for a sign-in Start did not begin. */
    readonly takeConnect: (connectionId: string, now: number) => Effect.Effect<StartedConnect | undefined, AppError>
  }
>()('goblin/onboarding/Onboarding') {}
