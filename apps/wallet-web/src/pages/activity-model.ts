// Activity as a wallet lists it: operations grouped by the local day they started on (Today, Yesterday, then dates),
// newest first, and each row's time in the form its group makes clear.
import type { Operation } from '@goblin/wallet/contract'

export interface DayGroup {
  /** The local calendar day, `YYYY-MM-DD`. */
  readonly key: string
  readonly label: string
  readonly operations: readonly Operation[]
}

const pad = (value: number): string => String(value).padStart(2, '0')

/** The local calendar day of a moment, so "Today" is the owner's today, not UTC's. */
const dayKey = (at: Date): string => `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`

/** "Mon, 6 Oct", with the year when it is not this year. */
const dateLabel = (at: Date, now: Date): string =>
  at.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  })

/** A day's heading: Today, Yesterday, or its date. */
export function dayLabel(iso: string, now: number = Date.now()): string {
  const at = new Date(iso)
  const today = new Date(now)
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  if (dayKey(at) === dayKey(today)) return 'Today'
  if (dayKey(at) === dayKey(yesterday)) return 'Yesterday'
  return dateLabel(at, today)
}

/** Operations grouped by the day they started, newest day and newest operation first. */
export function groupByDay(operations: readonly Operation[], now: number = Date.now()): readonly DayGroup[] {
  const sorted = operations.toSorted((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  const groups: { key: string; label: string; operations: Operation[] }[] = []
  for (const operation of sorted) {
    const key = dayKey(new Date(operation.createdAt))
    const last = groups.at(-1)
    if (last?.key === key) last.operations.push(operation)
    else groups.push({ key, label: dayLabel(operation.createdAt, now), operations: [operation] })
  }
  return groups
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE

const clock = (at: Date): string => at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

/**
 * When a row happened. Within the hour it reads "just now" or "5 min ago". Under a day heading the time of day is
 * enough; in a list without headings (Home) an older row says its day too.
 */
export function rowTime(iso: string, { dated = false, now = Date.now() } = {}): string {
  const at = new Date(iso)
  const diff = now - at.getTime()
  if (Number.isNaN(diff)) return iso
  if (diff < MINUTE) return 'just now'
  if (diff < HOUR) return `${Math.round(diff / MINUTE)} min ago`
  const day = dayLabel(iso, now)
  return !dated || day === 'Today' ? clock(at) : `${day}, ${clock(at)}`
}
