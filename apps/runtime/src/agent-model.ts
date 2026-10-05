import type { PiHarness } from 'agents/harness/pi'
import * as Effect from 'effect/Effect'
import { Models, attempt, attemptSync, nowSecondsEffect } from './services.ts'
import { MODEL_PROVIDER } from './pi/model.ts'
export type Applied = Map<string, string>
/**
 * Puts a session on the user's model before a turn. Pi stores one model per conversation, set when it is created, so
 * a pick (or a new deployment default) reaches existing conversations only this way. Skipped when already applied.
 */
export const useModel = (harness: PiHarness, applied: Applied, session: string) =>
  Effect.gen(function* () {
    const id = (yield* Models).current()
    if (applied.get(session) === id) return
    yield* attempt(() => harness.session(session).setModel({ provider: MODEL_PROVIDER, id }))
    applied.set(session, id)
  })

export const chooseOwnerModel = (harness: PiHarness, applied: Applied, modelId: string, session: string) =>
  Effect.gen(function* () {
    const models = yield* Models
    const now = yield* nowSecondsEffect
    const choice = yield* attemptSync(() => models.choose(modelId, now))
    yield* useModel(harness, applied, session)
    return choice
  })
