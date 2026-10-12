import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { attemptSync } from '../http/errors.ts'
import { Onboarding } from '../onboarding/service.ts'
import { OnboardingStore } from '../onboarding/store.ts'
import { Db } from '../runtime/db.ts'

/** First-run Start's record (ADR 0048), over the agent's database. */
export const OnboardingLive = Layer.effect(
  Onboarding,
  Effect.gen(function* () {
    const store = new OnboardingStore(yield* Db)
    return Onboarding.of({
      read: Effect.sync(() => store.get()),
      change: Effect.fn('Onboarding.change')(function* (change, now) {
        return yield* attemptSync(() => store.apply(change, now))
      }),
    })
  }),
)
