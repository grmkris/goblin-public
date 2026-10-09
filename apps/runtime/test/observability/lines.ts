import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { TestConsole } from 'effect/testing'

/** One line a test console received: the method that wrote it and the parsed JSON. */
export type Line = { readonly method: 'log' | 'warn' | 'error'; readonly line: Readonly<Record<string, unknown>> }

const parse = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))

/** Runs `self` with a console that keeps every line written to it, parsed, in order. */
export const withLines = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const lines: Line[] = []
    const record =
      (method: Line['method']) =>
      (...args: ReadonlyArray<unknown>): void => {
        lines.push({ method, line: parse(args[0]) })
      }
    const base = yield* TestConsole.make
    const console: Console.Console = { ...base, log: record('log'), warn: record('warn'), error: record('error') }
    const value = yield* self.pipe(Effect.provideService(Console.Console, console))
    return { value, lines }
  })

/** Lets detached fibers run until `done` holds, at most `rounds` scheduler turns. */
export const eventually = (done: () => boolean, rounds = 100): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let round = 0; round < rounds && !done(); round += 1) yield* Effect.yieldNow
  })
