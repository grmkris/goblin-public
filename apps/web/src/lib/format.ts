// How the web writes times, dates and durations for the owner: in their browser's locale and timezone, unless a
// routine names its own zone.

/** Two digits, as machine formats write a month, day, hour or minute ("07"). */
export const pad = (value: number): string => String(value).padStart(2, '0')

/** This browser's IANA timezone ("Europe/Tallinn"). */
export const browserZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone

/** A date as the locale writes it in short ("10/10/2026"); `ms` is epoch milliseconds. */
export const shortDate = (ms: number): string => new Date(ms).toLocaleDateString()

/** A day and month in words ("10 October"); `ms` is epoch milliseconds. */
export const dayAndMonth = (ms: number): string =>
  new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })

const DATE_TIME = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/** A date and time ("Oct 10, 2026, 07:30"), in `timeZone` when given; `ms` is epoch milliseconds. */
export const dateTime = (ms: number, timeZone?: string): string =>
  timeZone === undefined
    ? DATE_TIME.format(ms)
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(ms)

/** Milliseconds as the owner reads them: under a second in ms, else seconds with one decimal, else minutes. */
export function durationText(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  return `${(ms / 60_000).toFixed(1)} min`
}

const RELATIVE = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
/** Each unit and how many seconds it takes before the next one reads better. */
const UNITS: readonly (readonly [Intl.RelativeTimeFormatUnit, number, number])[] = [
  ['minute', 60, 45 * 60],
  ['hour', 3600, 22 * 3600],
  ['day', 86_400, 6 * 86_400],
  ['week', 7 * 86_400, 4 * 7 * 86_400],
  ['month', 30 * 86_400, 11 * 30 * 86_400],
]

/** How long ago `at` was, as people say it: "just now", "2 minutes ago", "yesterday", "3 weeks ago" (both in seconds). */
export function relativeTime(at: number, now: number): string {
  const ago = Math.max(0, now - at)
  if (ago < 45) return 'just now'
  const unit = UNITS.find(([, , below]) => ago < below)
  if (unit === undefined) return RELATIVE.format(-Math.round(ago / (365 * 86_400)), 'year')
  return RELATIVE.format(-Math.max(1, Math.round(ago / unit[1])), unit[0])
}
