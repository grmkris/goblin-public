import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { expectedFailure } from '../observability/report.ts'
import type { Packet } from './wire.ts'

/** The Workers AI binding as decisions use it (ADR 0031): Clef only. The platform's `Ai` and test fakes satisfy it. */
export interface DecisionsBinding {
  readonly run: (
    model: '@cf/cloudflare/clef',
    input: {
      readonly model: 'clef'
      readonly state: string
      readonly questions: Readonly<
        Record<
          string,
          {
            readonly type: 'noul' | 'choice' | 'score'
            readonly instructions: string
            readonly criteria?: Readonly<Record<string, string>> | readonly string[]
          }
        >
      >
    },
  ) => Promise<unknown>
}

/**
 * A Clef call that gave no answer: no binding (`unavailable`), the platform refused or failed it (`provider`), it took
 * longer than five seconds (`timeout`), or its answer did not decode (`format`). Never fatal to anything.
 */
export class ClefError extends Schema.TaggedError<ClefError>()('ClefError', {
  reason: Schema.Literals(['unavailable', 'provider', 'timeout', 'format']),
}) {}

/** A failed Clef call, marked expected where it is made: no binding is not reported at all, anything else at `Info`. */
export const clefFailed = (reason: ClefError['reason']): ClefError =>
  expectedFailure(new ClefError({ reason }), reason === 'unavailable' ? 'skip' : 'lower')

/** How long one Clef call may take. */
const TIMEOUT = '5 seconds'

/**
 * Clef, Cloudflare's typed-decision model, through the Workers AI binding (ADR 0031): no REST credential is in the
 * Worker. `available` is false when the stage binds no `AI` (prod, the native test stacks), and then decisions run
 * nothing at all.
 */
export class Clef extends Context.Service<
  Clef,
  {
    readonly available: boolean
    /** Clef's raw answer to a packet's questions about its state. */
    readonly evaluate: (packet: Packet) => Effect.Effect<unknown, ClefError>
  }
>()('goblin/decisions/Clef') {}

/** Clef over `binding`, or an unavailable Clef when there is none. */
export const workersClef = (binding: DecisionsBinding | undefined): Clef['Service'] =>
  Clef.of({
    available: binding !== undefined,
    evaluate: (data) =>
      binding === undefined
        ? Effect.fail(clefFailed('unavailable'))
        : Effect.tryPromise({
            try: () =>
              binding.run('@cf/cloudflare/clef', {
                model: 'clef',
                state: data.state,
                questions: Object.fromEntries(
                  Object.entries(data.questions).map(([id, question]) => [
                    id,
                    {
                      type: question.type,
                      instructions: question.instructions,
                      ...(question.type === 'noul' ? {} : { criteria: question.criteria }),
                    },
                  ]),
                ),
              }),
            catch: () => clefFailed('provider'),
          }).pipe(Effect.timeoutOrElse({ duration: TIMEOUT, orElse: () => Effect.fail(clefFailed('timeout')) })),
  })
