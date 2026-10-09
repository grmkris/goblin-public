import type { Conversation, EntryDraft, EntryRecord, Submission, UserInput } from '@earendil-works/pi-durable'
import type { PiOperationResult, PiReceipt, PiSubmitOptions } from 'agents/harness/pi'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { NotFound } from '../http/errors.ts'
import { AgentInput } from '../runtime/input.ts'
import { BACKGROUND, conversationId } from './context.ts'

const PiOperation = Schema.Literals(['submit', 'write', 'wait', 'abort', 'conversation', 'messages', 'busy'])

/**
 * A Pi call failed. `operation` names the call and is safe to log; `cause` is Pi's own error, kept for the reporter's
 * frames and never logged (ADR 0024).
 */
export class PiFailure extends Schema.TaggedError<PiFailure>()('PiFailure', {
  operation: PiOperation,
  cause: Schema.Defect(),
}) {}

/** A passive entry for a conversation: its model sees it at its next turn and no run starts. */
type PassiveWrite = { readonly requestId: string; readonly entry: EntryDraft }

/**
 * The Pi operations the runtime uses, over the agent's PiHarness, as Effects. Every call names its session, so none
 * falls back to Pi's root. Only `wait` takes the fiber's signal, so an interruption ends the wait; the others are
 * admissions or reads Pi answers at once, and cutting an admission short would leave unknown whether Pi took it.
 */
export class PiSessions extends Context.Service<
  PiSessions,
  {
    /** Durably submits input to `session`; resolves before the model runs. */
    readonly submit: (
      session: string,
      input: UserInput,
      options?: Omit<PiSubmitOptions, 'session'>,
    ) => Effect.Effect<PiReceipt, PiFailure>
    /** Admits a passive write into `session`'s conversation; `NotFound` when Pi has no such conversation. */
    readonly write: (session: string, write: PassiveWrite) => Effect.Effect<Submission, PiFailure | NotFound>
    /** Waits until Pi settles `operationId` in `session`; interrupting the fiber stops only the wait. */
    readonly wait: (session: string, operationId: string) => Effect.Effect<PiOperationResult, PiFailure>
    /** Stops one operation of `session`, or, without one, everything running there. */
    readonly abort: (session: string, operationId?: string) => Effect.Effect<boolean, PiFailure>
    /** The session's Pi conversation, if Pi has it. */
    readonly conversation: (session: string) => Effect.Effect<Option.Option<Conversation>, PiFailure>
    /** The session's active transcript, as Pi's entries. */
    readonly messages: (session: string) => Effect.Effect<EntryRecord[], PiFailure>
    readonly busy: (session: string) => Effect.Effect<boolean, PiFailure>
  }
>()('goblin/pi/PiSessions') {
  static readonly layer = Layer.effect(
    PiSessions,
    Effect.gen(function* () {
      const { harness } = yield* AgentInput
      const call = <A>(operation: typeof PiOperation.Type, run: (signal: AbortSignal) => PromiseLike<A>) =>
        Effect.tryPromise({ try: run, catch: (cause) => new PiFailure({ operation, cause }) })
      const conversation = Effect.fn('PiSessions.conversation')(function* (session: string) {
        const found = yield* call('conversation', async () =>
          (await harness.pi()).conversation(conversationId(session), BACKGROUND),
        )
        return Option.fromNullishOr(found)
      })
      return PiSessions.of({
        submit: Effect.fn('PiSessions.submit')(function* (
          session: string,
          input: UserInput,
          options: Omit<PiSubmitOptions, 'session'> = {},
        ) {
          return yield* call('submit', () => harness.submit(input, { ...options, session }))
        }),
        write: Effect.fn('PiSessions.write')(function* (session: string, write: PassiveWrite) {
          const found = yield* conversation(session)
          if (Option.isNone(found)) return yield* new NotFound({ what: 'conversation' })
          return yield* call('write', () => found.value.submit({ type: 'write', ...write }, BACKGROUND))
        }),
        wait: Effect.fn('PiSessions.wait')(function* (session: string, operationId: string) {
          return yield* call('wait', (signal) => harness.wait(operationId, { session, signal }))
        }),
        abort: Effect.fn('PiSessions.abort')(function* (session: string, operationId?: string) {
          return yield* call('abort', () =>
            harness.abort({ session, ...(operationId === undefined ? {} : { operationId }) }),
          )
        }),
        conversation,
        messages: Effect.fn('PiSessions.messages')(function* (session: string) {
          return yield* call('messages', () => harness.messages({ session }))
        }),
        busy: Effect.fn('PiSessions.busy')(function* (session: string) {
          return yield* call('busy', () => harness.session(session).busy())
        }),
      })
    }),
  )
}
