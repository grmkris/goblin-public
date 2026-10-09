import type { FlowEvent } from '@goblin/contracts/telemetry'
import type { PiHarness, PiReceipt } from 'agents/harness/pi'
import * as Cause from 'effect/Cause'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Option from 'effect/Option'
import { type Applied, useModel } from '../agent-model.ts'
import { Budget } from '../budget.ts'
import { type AppError, toAppError } from '../http/errors.ts'
import { Models } from '../models.ts'
import { FlowEvents } from '../observability/flows.ts'
import { KeyedLock } from '../observability/lock.ts'
import { safeErrorType } from '../observability/report.ts'
import { failedFlow } from '../organize/flows.ts'
import { type PiFailure, PiSessions } from '../pi/sessions.ts'
import type { RoutineController } from '../routines/controller.ts'
import { Db } from '../runtime/db.ts'
import { AgentInput } from '../runtime/input.ts'
import { type ChatDirectory, ChatReads, SessionId } from './directory.ts'
import { epochSeconds, instanceCall } from './instance.ts'
import {
  type ReceiptChange,
  type ReceiptInput,
  admitReceipt,
  advanceReceipt,
  receiptIn,
  relatedReceipts,
} from './receipts.ts'
import { type Admission, type Admitted, ChatOperations, type PassiveWrite, type Submit } from './service.ts'

/**
 * The one chat directory of the agent, whose per-chat lock its Promise callers (the mover, the registry's own writes,
 * the Topic ports) still take: admission holds it inside `KeyedLock`'s until they move onto `ChatOperations`.
 */
export type AdmissionLocks = { readonly locks: ChatDirectory }

/** A synchronous read or write of the receipts, its throw a typed `AppError` (`NotFound` for an unknown chat). */
const sql = <A>(run: () => A) => Effect.try({ try: run, catch: toAppError })

/** A Pi call's failure as the programs take one: Pi's own error through `toAppError`. */
const piFailure = (failure: PiFailure) => Effect.fail(toAppError(failure.cause))

/**
 * Holds `chat`'s lock on the legacy directory, which its Promise callers (the mover, the registry's own passive writes)
 * still take: admission holds it inside `KeyedLock`'s, so they and the Effect callers stay one at a time per chat. It
 * is held from when its turn comes until the returned release runs. It goes once those callers take `ChatOperations`.
 */
const legacyLock = (chats: ChatDirectory, chat: string) =>
  Effect.callback<() => void>((resume) => {
    chats
      .withChat(chat, () => new Promise<void>((release) => resume(Effect.succeed(() => release()))))
      // expected: the lock's own run never rejects, so neither does its promise.
      .catch(() => undefined)
  })

/** Each chat's admission lock: `KeyedLock`'s, with the legacy directory's inside it. */
const chatLock =
  (locks: KeyedLock['Service'], chats: ChatDirectory) =>
  <A, E, R>(chat: string, effect: Effect.Effect<A, E, R>) =>
    locks
      .withLock(`chat:${chat}`)(
        Effect.acquireUseRelease(
          legacyLock(chats, chat),
          () => effect,
          (release) => Effect.sync(release),
        ),
      )
      .pipe(Effect.withSpan('ChatOperations.withChat'))

/** The receipts in the agent's SQLite (chats/receipts.ts), each read or write with the Clock's time. */
const receiptsOf = (db: Db['Service'], chats: ChatReads) => ({
  record: Effect.fn('ChatOperations.record')(function* (chat: string, operationId: string, receipt: ReceiptInput) {
    const now = yield* epochSeconds
    const admitted = yield* sql(() =>
      admitReceipt(db, { chat, operationId, receipt, session: () => chats.session(chat), now }),
    )
    return { session: SessionId(admitted.session), existing: admitted.existing } satisfies Admitted
  }),
  operation: Effect.fn('ChatOperations.operation')(function* (chat: string, operationId: string) {
    const found = Option.fromNullishOr(yield* sql(() => receiptIn(db, chat, operationId)))
    return Option.map(found, (receipt) => SessionId(receipt.session))
  }),
  receipt: Effect.fn('ChatOperations.receipt')(function* (chat: string, operationId: string) {
    return Option.fromNullishOr(yield* sql(() => receiptIn(db, chat, operationId)))
  }),
  related: Effect.fn('ChatOperations.related')(function* (operationId: string) {
    return yield* sql(() => relatedReceipts(db, operationId))
  }),
  advance: Effect.fn('ChatOperations.advance')(function* (
    chat: string,
    operationId: string,
    change: Omit<ReceiptChange, 'now'>,
  ) {
    const now = yield* epochSeconds
    yield* sql(() => advanceReceipt(db, chat, operationId, { ...change, now }))
  }),
})

type Receipts = ReturnType<typeof receiptsOf>
type Lock = ReturnType<typeof chatLock>

/** A passive write while `chat`'s lock is held: its receipt, Pi's write into the session it names, then `written`. */
const writeHeld = (receipts: Receipts, pi: PiSessions['Service']) =>
  Effect.fn('ChatOperations.passiveWrite')(function* (chat: string, write: PassiveWrite) {
    const { requestId, entry, origin = 'system', parentOp } = write
    const receipt = { kind: `write:${entry.kind}`, origin, ...(parentOp === undefined ? {} : { parentOp }) } as const
    const { session } = yield* receipts.record(chat, requestId, receipt)
    const submission = yield* pi.write(session, { requestId, entry }).pipe(Effect.catchTag('PiFailure', piFailure))
    yield* receipts.advance(chat, requestId, { state: 'written' })
    return submission
  })

/** Records `admission`'s one flow event once `run` ends: `ok`, `replayed`, or how it failed, with its time. */
const flowed = <A, E, R>(
  flows: FlowEvents['Service'],
  admission: Admission,
  run: Effect.Effect<{ readonly value: A; readonly existing: boolean }, E, R>,
) =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis
    const exit = yield* Effect.exit(run)
    const ms = Math.max(0, (yield* Clock.currentTimeMillis) - started)
    const { chat, operationId, flow } = admission
    const status: Pick<FlowEvent, 'status' | 'errorType'> = Exit.isSuccess(exit)
      ? { status: exit.value.existing ? 'replayed' : 'ok' }
      : failedFlow(Cause.squash(exit.cause))
    yield* flows.record({ ...flow, chat, operationId, ...status, ms })
    if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause)
    return exit.value.value
  })

/** What the one admission sequence reads, captured once when the layer is built. */
type Admitting = {
  readonly withChat: Lock
  readonly receipts: Receipts
  readonly flows: FlowEvents['Service']
  readonly requireOpen: (chat: string) => string
}

/** `ChatOperations.admit`: under the lock, the chat open, the receipt, `then`, the receipt's end; one flow event. */
const admitWith =
  ({ withChat, receipts, flows, requireOpen }: Admitting) =>
  <A, E, R>(admission: Admission, then: (admitted: Admitted) => Effect.Effect<A, E, R>) => {
    const { chat, operationId, receipt } = admission
    const refuse = (error: unknown) =>
      receipts.advance(chat, operationId, { state: 'refused', reason: safeErrorType(error) })
    const admitted = Effect.gen(function* () {
      yield* sql(() => requireOpen(chat))
      const found = yield* receipts.record(chat, operationId, receipt)
      const value = yield* then(found).pipe(Effect.tapError(refuse))
      yield* receipts.advance(chat, operationId, { state: 'submitted' })
      return { value, existing: found.existing }
    })
    return flowed(flows, admission, withChat(chat, admitted)).pipe(Effect.withSpan('ChatOperations.admit'))
  }

/** What an input's hand-on reads: the budget, Pi, the owner's model, and the routine questions waiting for answers. */
type Sending = {
  readonly admit: ReturnType<typeof admitWith>
  readonly budget: Budget['Service']
  readonly models: Models['Service']
  readonly pi: PiSessions['Service']
  readonly harness: PiHarness
  readonly applied: Applied
  readonly routines: RoutineController
}

/** `ChatOperations.send`: the one admission sequence of an input (plan §3). */
const sendWith =
  ({ admit, budget, models, pi, harness, applied, routines }: Sending) =>
  <R = never>(input: Submit<R>): Effect.Effect<PiReceipt, AppError, R> =>
    Effect.gen(function* () {
      yield* budget.require(yield* epochSeconds)
      const { operationId, content, answers, relay } = input
      return yield* admit(input, ({ session }) =>
        Effect.gen(function* () {
          if (answers !== undefined && (yield* instanceCall(() => routines.answer(session, operationId, answers))))
            return { session, operationId, accepted: true } satisfies PiReceipt
          yield* useModel(harness, applied, session).pipe(Effect.provideService(Models, models))
          if (relay !== undefined) return yield* relay(session)
          return yield* pi.submit(session, content, { operationId }).pipe(Effect.catchTag('PiFailure', piFailure))
        }),
      )
    }).pipe(Effect.withSpan('ChatOperations.send'))

/**
 * The chat operations natively: chats and receipts read from the agent's SQLite, the chat's lock in `KeyedLock` (with
 * the legacy directory's inside it), Pi through `PiSessions`, flows through `FlowEvents`.
 */
export const makeChatOperations = ({ locks }: AdmissionLocks) =>
  Effect.gen(function* () {
    const db = yield* Db
    const pi = yield* PiSessions
    const flows = yield* FlowEvents
    const { harness, applied, routines } = yield* AgentInput
    const chats = new ChatReads(db)
    const withChat = chatLock(yield* KeyedLock, locks)
    const receipts = receiptsOf(db, chats)
    const written = writeHeld(receipts, pi)
    const admit = admitWith({ withChat, receipts, flows, requireOpen: (chat) => chats.requireOpen(chat) })
    const sending = { admit, budget: yield* Budget, models: yield* Models, pi, harness, applied, routines }
    return ChatOperations.of({
      ...receipts,
      withChat,
      passiveWrite: (chat, write) => withChat(chat, written(chat, write)),
      admit,
      send: sendWith(sending),
    })
  })
