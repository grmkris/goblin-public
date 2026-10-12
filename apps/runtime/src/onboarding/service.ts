import type { OnboardingChange } from '@goblin/contracts'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type { AppError } from '../http/errors.ts'
import type { OnboardingRecord } from './store.ts'

/** What the owner did with first-run Start (ADR 0048), kept by the agent. */
export class Onboarding extends Context.Service<
  Onboarding,
  {
    /** The stored record; none until the owner acted on Start. */
    readonly read: Effect.Effect<OnboardingRecord | undefined>
    /** Applies the owner's change at `now` (epoch seconds). */
    readonly change: (change: OnboardingChange, now: number) => Effect.Effect<OnboardingRecord, AppError>
  }
>()('goblin/onboarding/Onboarding') {}
