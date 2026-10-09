import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as ErrorReporter from 'effect/ErrorReporter'
import type { Severity } from 'effect/LogLevel'
import * as Predicate from 'effect/Predicate'
import * as References from 'effect/References'
import { expectedFailure as expectedCode } from '../telemetry/safety.ts'
import { type LineLevel, writeFiberLine } from './logger.ts'

/** The log annotation that names where a failure was reported: `conversations.send`, `mcp.refresh`. */
const WHERE = 'goblin.where'
const MAX_FRAMES = 12
const MAX_FRAME = 300
const TAG = /^[A-Za-z][A-Za-z0-9_]{0,39}$/u
const CLASS = /^[A-Za-z]{1,40}$/u

/**
 * A failure's type for logs and telemetry: its `_tag`, else its class name (an Error's `name`), else `Error`. Never its
 * message or fields.
 */
export function safeErrorType(error: unknown): string {
  if (!Predicate.isObject(error)) return 'Error'
  if ('_tag' in error && Predicate.isString(error._tag) && TAG.test(error._tag)) return error._tag
  const name = classNameOf(error)
  return Predicate.isString(name) && CLASS.test(name) ? name : 'Error'
}

const classNameOf = (error: object): unknown => {
  if (error instanceof Error) return error.name
  const prototype: unknown = Object.getPrototypeOf(error)
  return Predicate.isObject(prototype) && 'constructor' in prototype && Predicate.isFunction(prototype.constructor)
    ? prototype.constructor.name
    : undefined
}

/**
 * The `at …` lines of a pretty error's stack. The first part of a stack is `name: message`, and a message can span
 * lines that look like frames, so that whole header is cut off first; a stack that does not start with it yields none.
 */
export function framesOf(error: Error): string[] {
  const stack = error.stack ?? ''
  const header = [`${error.name}: ${error.message}`, error.name].find(
    (candidate) => stack === candidate || stack.startsWith(`${candidate}\n`),
  )
  if (header === undefined) return []
  return stack
    .slice(header.length)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('at '))
    .slice(0, MAX_FRAMES)
    .map((line) => line.slice(0, MAX_FRAME))
}

const LEVELS: Readonly<Record<Severity, LineLevel>> = {
  Fatal: 'error',
  Error: 'error',
  Warn: 'warn',
  Info: 'info',
  Debug: 'info',
  Trace: 'info',
}

/**
 * The typed failures an owner request ends with in the normal course (the AppError tags of
 * packages/contracts/src/api/errors.ts, all but `Internal`): a 404, 409 or 402 is an answer, not a fault. HttpApi
 * reports every handler failure, so the reporter skips these when they arrive as a failure. `Internal`, any other
 * failure and any defect, even one of these thrown, are reported. Update it with AppError.
 */
export const EXPECTED_ERROR_TAGS: ReadonlySet<string> = new Set([
  'Unauthenticated',
  'Forbidden',
  'GrantDenied',
  'NotFound',
  'Conflict',
  'InvalidInput',
  'PayloadTooLarge',
  'ResidentInactive',
  'BudgetExhausted',
  'SubscriptionRequired',
  'NeedsAuthorization',
  'UpstreamMcp',
])

/** `type` is an expected typed failure, and the cause failed with it rather than dying of it. */
const answered = (cause: Cause.Cause<unknown>, type: string): boolean =>
  EXPECTED_ERROR_TAGS.has(type) &&
  cause.reasons.some((reason) => Cause.isFailReason(reason) && safeErrorType(reason.error) === type)

/**
 * Logs each reported failure as one `failure` line: where, its type, its stack locations and a severity. An expected
 * typed failure (`EXPECTED_ERROR_TAGS`) is not logged. An error that declares a severity (`expectedFailure`) keeps it;
 * an expected owner decision (budget, grant, authorization) that died is `Info`; anything else is `Error`.
 * Interruptions and errors marked to skip are not reported.
 */
export const goblinReporter = ErrorReporter.make(({ cause, error, severity: declared, fiber }) => {
  const type = safeErrorType(error)
  if (answered(cause, type)) return
  const severity: Severity = Object.hasOwn(error, ErrorReporter.severity)
    ? declared
    : expectedCode(type)
      ? 'Info'
      : 'Error'
  writeFiberLine(fiber, LEVELS[severity], {
    event: 'failure',
    where: fiber.getRef(References.CurrentLogAnnotations)[WHERE] ?? 'unknown',
    'error.type': type,
    frames: framesOf(error),
    severity,
  })
})

/** Installs `goblinReporter` as the only reporter. */
export const ReporterLive = ErrorReporter.layer([goblinReporter])

/** Reports any failure of `self` under `where`, then fails as before. */
export const reportFailure =
  (where: string) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    self.pipe(Effect.withErrorReporting, Effect.annotateLogs(WHERE, where))

/**
 * Reports any failure or defect of `self` under `where`, then succeeds with `fallback`: for a legitimate fallback,
 * never to hide a failure. Interruption still interrupts.
 */
export const reportAndRecover =
  <B>(where: string, fallback: B) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A | B, never, R> =>
    self.pipe(
      reportFailure(where),
      Effect.catchCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.succeed(fallback))),
    )

/**
 * Marks `error` as expected where it is made: the reporter logs it at `Info`, or with `skip` not at all. It sets the
 * `ErrorReporter` annotation on the error itself and returns it.
 */
export const expectedFailure = <E extends object>(error: E, how: 'lower' | 'skip' = 'lower'): E =>
  Object.assign(error, how === 'skip' ? { [ErrorReporter.ignore]: true } : { [ErrorReporter.severity]: 'Info' })
