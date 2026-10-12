import * as Effect from 'effect/Effect'
import { epochSeconds } from './clock.ts'
import { Chats } from './chats/service.ts'
import { Models } from './models.ts'
import { modelRef } from './pi/model.ts'
import { PiSessions, fromPi } from './pi/sessions.ts'
import { AgentInput } from './runtime/input.ts'

export type Applied = Map<string, string>

/**
 * Puts a session on the user's model before a turn. Pi stores one model per conversation, set when it is created, so
 * a pick (or a new deployment default) reaches existing conversations only this way. Skipped when `applied` says the
 * session is on it already.
 */
export const useModel = (pi: PiSessions['Service'], applied: Applied, session: string) =>
  Effect.gen(function* () {
    const id = yield* (yield* Models).current
    if (applied.get(session) === id) return
    yield* fromPi(pi.setModel(session, modelRef(id)))
    applied.set(session, id)
  })

/** The owner picks a model: main is put on it at once, the others at their next turn. */
export const chooseOwnerModel = (modelId: string) =>
  Effect.gen(function* () {
    const choice = yield* (yield* Models).choose(modelId, yield* epochSeconds)
    const chats = yield* Chats
    const { applied } = yield* AgentInput
    yield* useModel(yield* PiSessions, applied, yield* chats.session(chats.primary))
    return choice
  })
