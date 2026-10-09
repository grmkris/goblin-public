import { ClientErrorReport } from '@goblin/contracts'
import * as Predicate from 'effect/Predicate'
import * as Schema from 'effect/Schema'
import { describeError } from './app-error.ts'

/**
 * Crash reports (ADR 0024): what the browser tells `POST /api/client-errors` about a failure nothing on the page
 * caught. The route template, the error's type, its stack locations, the build and the reference of the answer that
 * failed; never its message, the URL or anything the owner typed.
 */

const MAX_FRAMES = 12
/** At most this many reports leave one page load: a crash loop must not become a flood. */
const MAX_REPORTS = 5
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/u
const ROUTE = /^[\w$./{}()-]{0,120}$/u
const TOKEN = /^[\w.:-]*$/u
/** A stack line's location: a URL or path, a line and a column (`at f (…/index-3f2a.js:1:2)`, `f@…/a.js:1:2`). */
const LOCATION = /((?:[a-z][\w+.-]*:\/\/|\/)[^\s()@]+):(\d{1,7}):(\d{1,7})\)?\s*$/u

const isReport = Schema.is(ClientErrorReport)

/** The error's type as the logs name it: its `_tag`, else its class name, else `Error`. */
const nameOf = (error: unknown): string => {
  if (Predicate.hasProperty(error, '_tag') && Predicate.isString(error._tag) && NAME.test(error._tag)) return error._tag
  return error instanceof Error && NAME.test(error.name) ? error.name : 'Error'
}

/**
 * The stack's locations, each `url:line:col` without query or fragment. Chrome's stack starts with `name: message`,
 * which can span lines that look like frames, so that header is cut off first; Firefox and Safari have none.
 */
export const framesOf = (error: unknown): string[] => {
  if (!(error instanceof Error) || error.stack === undefined) return []
  const header = `${error.name}: ${error.message}`
  const stack = error.stack.startsWith(header) ? error.stack.slice(header.length) : error.stack
  return stack
    .split('\n')
    .flatMap((line) => {
      const [, where = '', row = '', column = ''] = LOCATION.exec(line) ?? []
      const frame = `${where.replace(/[?#].*$/u, '')}:${row}:${column}`
      return where === '' || frame.length > 300 ? [] : [frame]
    })
    .slice(0, MAX_FRAMES)
}

/** The deployed build, when the build named it (`VITE_GOBLIN_BUILD`); `dev` otherwise. */
const BUILD: string = (() => {
  const build: unknown = import.meta.env['VITE_GOBLIN_BUILD']
  return Predicate.isString(build) && build.length <= 40 && TOKEN.test(build) ? build : 'dev'
})()

/** The report of `error` on `route` (a route id such as `/c/$chatId`), or none if nothing of it fits the contract. */
export function crashReport(error: unknown, route: string): ClientErrorReport | undefined {
  // A typed API failure's reference, or an older `ApiFailure`'s (`boundary.ts`).
  const ref =
    describeError(error).ref ??
    (Predicate.hasProperty(error, 'ref') && Predicate.isString(error.ref) ? error.ref : undefined)
  const base = {
    route: ROUTE.test(route) ? route : '__root__',
    name: nameOf(error),
    build: BUILD,
    ...(ref !== undefined && ref.length <= 64 && TOKEN.test(ref) ? { ref } : {}),
  }
  // The whole report is bounded (2 KiB): drop the deepest frames until it fits.
  for (let frames = framesOf(error); ; frames = frames.slice(0, -1)) {
    const report = { ...base, frames }
    if (isReport(report)) return report
    if (frames.length === 0) return undefined
  }
}

/**
 * A reporter that sends each distinct crash once (by type and top frame), at most `MAX_REPORTS` per page load. Only a
 * defect is a crash (`describeError`'s kind `defect`): an answer the API gave (not found, a conflict, no plan) or a
 * cancelled request is not. `send` must not throw: a report that cannot be sent is dropped, never another crash.
 */
export function crashReporter(send: (report: ClientErrorReport) => void): (error: unknown, route: string) => void {
  const seen = new Set<string>()
  return (error, route) => {
    if (describeError(error).kind !== 'defect') return
    const report = crashReport(error, route)
    if (report === undefined || seen.size >= MAX_REPORTS) return
    const key = `${report.name} ${report.frames[0] ?? ''}`
    if (seen.has(key)) return
    seen.add(key)
    send(report)
  }
}

/**
 * Reports what `target` (the window) raises that nothing caught: uncaught errors and unhandled rejections, on the
 * route `routeOf` names now. Returns the removal of both listeners.
 */
export function reportUncaught(
  target: Pick<Window, 'addEventListener' | 'removeEventListener'>,
  report: (error: unknown, route: string) => void,
  routeOf: () => string,
): () => void {
  // A cross-origin script's error says nothing (`event.error` is null): there is nothing to report.
  const onError = (event: ErrorEvent) => {
    if (event.error !== null && event.error !== undefined) report(event.error, routeOf())
  }
  const onRejection = (event: PromiseRejectionEvent) => report(event.reason, routeOf())
  target.addEventListener('error', onError)
  target.addEventListener('unhandledrejection', onRejection)
  return () => {
    target.removeEventListener('error', onError)
    target.removeEventListener('unhandledrejection', onRejection)
  }
}
