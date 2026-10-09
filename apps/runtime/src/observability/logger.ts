import type { RunAttributes } from '@goblin/contracts/telemetry'
import * as Clock from 'effect/Clock'
import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import type * as Fiber from 'effect/Fiber'
import * as Logger from 'effect/Logger'
import type { LogLevel } from 'effect/LogLevel'
import * as Predicate from 'effect/Predicate'
import * as References from 'effect/References'
import { sanitizeAttributes } from '../telemetry/safety.ts'

/**
 * goblin's one log writer (ADR 0024): every line is one JSON object of allowlisted identifiers, codes, counts and
 * timings, never content. Lines come from three places, all filtered the same way: `GoblinLogger` for `Effect.log*`,
 * `logEvent` for named events inside Effect, and `writeLine` for synchronous sinks outside it. This is the runtime's
 * only console writer.
 */

/** What a line is about. Closed: an area that writes a new kind of line adds it here, in alphabetical order. */
const LOG_EVENTS = ['client_error', 'failure', 'flow', 'http.failure', 'job', 'rpc', 'skill-learner', 'wake'] as const
export type LogEvent = (typeof LOG_EVENTS)[number]

/** A line's level; the console method follows it (`info` is `console.log`). */
export type LineLevel = 'info' | 'warn' | 'error'

/** Fields offered to a line: only `LOG_KEYS` with values of their shape, and run attributes, survive. */
export type LogFields = Readonly<Record<string, unknown>>

type Value = string | number | boolean | readonly string[]
type Check = (value: unknown) => value is Value

const TOKEN = /^[\w.:/$@{}-]+$/u
const CLASS_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/u
const ERROR_TYPE = /^[A-Za-z][A-Za-z0-9_]{0,39}(?::[a-z-]{1,40})?$/u
/** A stack location (`at f (file.js:1:2)` or `file.js:1:2`): one line ending in line and column. */
const FRAME = /^[^\n\r]{0,280}:\d{1,7}:\d{1,7}\)?$/u
const MAX_FRAMES = 12

const token =
  (max: number): Check =>
  (value): value is string =>
    Predicate.isString(value) && value.length <= max && TOKEN.test(value) && !value.includes('://')
const matching =
  (pattern: RegExp): Check =>
  (value): value is string =>
    Predicate.isString(value) && pattern.test(value)
const oneOf =
  (values: readonly string[]): Check =>
  (value): value is string =>
    Predicate.isString(value) && values.includes(value)
const amount = (value: unknown): value is number => Predicate.isNumber(value) && Number.isFinite(value) && value >= 0
const frames = (value: unknown): value is readonly string[] =>
  Array.isArray(value) &&
  value.length <= MAX_FRAMES &&
  value.every((frame) => Predicate.isString(frame) && FRAME.test(frame))
const status = (value: unknown): value is number | string =>
  (Predicate.isNumber(value) && Number.isInteger(value)) || token(40)(value)

/** Each key a line may carry, with the shape its value must have. Anything else goes through `sanitizeAttributes`. */
const FIELDS: Readonly<Record<string, Check>> = {
  event: oneOf(LOG_EVENTS),
  where: token(80),
  'goblin.where': token(80),
  'goblin.rpc': token(80),
  'goblin.operation': token(200),
  operation: token(200),
  request: token(64),
  ref: token(64),
  agent: token(64),
  conversation: token(40),
  task: token(80),
  id: token(200),
  route: token(120),
  method: matching(/^[A-Z]{3,7}$/u),
  status,
  code: token(64),
  name: matching(CLASS_NAME),
  build: token(40),
  kind: token(60),
  severity: oneOf(['Fatal', 'Error', 'Warn', 'Info', 'Debug', 'Trace']),
  'error.type': matching(ERROR_TYPE),
  frames,
  ms: amount,
  count: amount,
}

/** The keys a line may carry besides run attributes. */
export const LOG_KEYS: readonly string[] = Object.keys(FIELDS)

const scalar = (value: unknown): value is string | number | boolean =>
  Predicate.isString(value) || Predicate.isNumber(value) || Predicate.isBoolean(value)

/** The fields a line keeps: allowlisted keys of the right shape, then run attributes through their own allowlist. */
function keep(fields: LogFields): Record<string, Value> {
  const kept: Record<string, Value> = {}
  const attributes: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(fields)) {
    const check = FIELDS[key]
    if (check === undefined) {
      if (scalar(value)) attributes[key] = value
    } else if (check(value)) {
      kept[key] = value
    }
  }
  const safe: RunAttributes = sanitizeAttributes(attributes)
  return { ...safe, ...kept }
}

const SPAN = /^[\w.:-]{1,60}$/u

const spansOf = (spans: ReadonlyArray<readonly [string, number]>, now: number): Record<string, number> =>
  Object.fromEntries(spans.flatMap(([label, start]) => (SPAN.test(label) ? [[label, now - start]] : [])))

const write = (console: Console.Console, level: LineLevel, line: Record<string, unknown>): void => {
  const text = JSON.stringify({ level, ...line })
  if (level === 'error') console.error(text)
  else if (level === 'warn') console.warn(text)
  else console.log(text)
}

/**
 * One line through `fiber`'s console: its log annotations and spans, then `fields` (which win), all filtered. For
 * code that holds a fiber outside `Effect`, such as an error reporter.
 */
export function writeFiberLine(fiber: Fiber.Fiber<unknown, unknown>, level: LineLevel, fields: LogFields): void {
  const spans = spansOf(fiber.getRef(References.CurrentLogSpans), fiber.getRef(Clock.Clock).currentTimeMillisUnsafe())
  const line = keep({ ...fiber.getRef(References.CurrentLogAnnotations), ...fields })
  write(fiber.getRef(Console.Console), level, Object.keys(spans).length === 0 ? line : { ...line, spans })
}

/** One line from synchronous code with no fiber (a Pi commit listener, a run sink), through the global console. */
export function writeLine(level: LineLevel, fields: LogFields): void {
  write(console, level, keep(fields))
}

const levelOf = (level: LogLevel): LineLevel => {
  if (level === 'Fatal' || level === 'Error') return 'error'
  return level === 'Warn' ? 'warn' : 'info'
}

/**
 * The Effect logger: a line from the fiber's annotations and spans only. It never reads `message` or `cause`, which
 * may hold content; a failure is logged by the reporter (report.ts), which keeps only its stack locations.
 */
export const GoblinLogger = Logger.make<unknown, void>((options) => {
  writeFiberLine(options.fiber, levelOf(options.logLevel), {})
})

/** Installs `GoblinLogger` alone, deliberately replacing Effect's default and tracer loggers. */
export const LoggerLive = Logger.layer([GoblinLogger])

/** A named event line at `level`, with the current annotations; the same filter applies to `fields`. */
export const logEvent = (level: LineLevel, event: LogEvent, fields: LogFields = {}): Effect.Effect<void> =>
  Effect.withFiber((fiber) => {
    writeFiberLine(fiber, level, { ...fields, event })
    return Effect.void
  })
