import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { Chats, Conversations } from '../chats/service.ts'
import { NotFound } from '../http/errors.ts'
import { requireRoutineSession } from '../routines/authority.ts'
import { RoutineRuns } from '../routines/service.ts'
import { Setups } from '../setup/service.ts'
import { requireResident } from './service.ts'

// What a held call (ADR 0028), or a URL request (ADR 0042), needs again just before its decided call goes out, and the
// routine run it held that goes on once it is decided.

/** The call a held row stands for: its conversation (when the model or an App made it), connection and tool. */
type HeldTarget = { readonly sessionId: string | null; readonly connectionId: string; readonly name: string }

/**
 * What a held call (or a URL request's retry) needs again just before it goes out: current authority, its open chat
 * and its scope.
 */
export const authority = (row: HeldTarget) =>
  Effect.gen(function* () {
    yield* requireResident
    if (row.sessionId === null) return
    const session = row.sessionId
    const chat = yield* (yield* Chats).chatOf(session)
    if (Option.isNone(chat)) return yield* new NotFound({ what: 'chat' })
    yield* (yield* Conversations).requireActing(chat.value)
    yield* requireRoutineSession(session)
    if (!(yield* (yield* Setups).scope(session)).tool(row.connectionId, row.name))
      return yield* new NotFound({ what: 'tool scope' })
  })

/** A routine run waiting on the owner goes on running once its held call is approved (or its URL request answered). */
export const resumeRoutine = (row: { readonly sessionId: string | null; readonly id: string }) =>
  Effect.gen(function* () {
    if (row.sessionId === null) return
    const session = row.sessionId
    const runs = yield* RoutineRuns
    const record = yield* runs.session(session)
    if (record === undefined || record.state !== 'waiting_owner') return
    yield* runs.resume(session, `mcp-decision-resume:${row.id}`, yield* Clock.currentTimeMillis, 'approved')
  })
