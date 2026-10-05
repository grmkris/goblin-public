import type { RoutineDefinition } from '@purrable/contracts'
import { InvalidInput } from '../http/errors.ts'

const MINUTE = 60_000
const DAY = 86_400_000
type Local = { year: number; month: number; day: number; hour: number; minute: number }
type Cron = {
  minutes: number[]
  hours: number[]
  days: number[]
  months: number[]
  weekdays: number[]
  dayAny: boolean
  weekAny: boolean
}

export function timezoneValid(zone: string): void {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone }).format(0)
  } catch {
    throw new InvalidInput({ reason: 'invalid timezone' })
  }
}

const formatter = (zone: string) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
const localAt = (format: Intl.DateTimeFormat, at: number): Local => {
  const parts = Object.fromEntries(format.formatToParts(at).map((part) => [part.type, Number(part.value)]))
  return {
    year: parts.year ?? 0,
    month: parts.month ?? 0,
    day: parts.day ?? 0,
    hour: parts.hour ?? 0,
    minute: parts.minute ?? 0,
  }
}
const localMillis = (local: Local) => Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute)

/** Five numeric cron fields: lists, ranges and steps; no seconds, macros or executable predicates. */
function rangeValues(item: string, min: number, max: number): number[] {
  const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/u.exec(item)
  if (match === null) throw new InvalidInput({ reason: 'invalid cron field' })
  const range = match[1] ?? ''
  const step = Number(match[2] ?? 1)
  const [startRaw, endRaw] = range.split('-')
  const start = range === '*' ? min : Number(startRaw)
  const fallback = match[2] === undefined ? start : max
  const end = range === '*' ? max : Number(endRaw ?? fallback)
  if (start < min || end > max || start > end || step < 1 || step > max + 1)
    throw new InvalidInput({ reason: 'cron field out of range' })
  const values: number[] = []
  for (let value = start; value <= end; value += step) values.push(value)
  return values
}
function field(raw: string, min: number, max: number): number[] {
  return [...new Set(raw.split(',').flatMap((item) => rangeValues(item, min, max)))].toSorted((a, b) => a - b)
}

export function parseCron(expression: string): Cron {
  const [minute, hour, day, month, weekday, extra] = expression.trim().split(/\s+/u)
  if (weekday === undefined || extra !== undefined) throw new InvalidInput({ reason: 'cron needs five fields' })
  const cron = {
    minutes: field(minute ?? '', 0, 59),
    hours: field(hour ?? '', 0, 23),
    days: field(day ?? '', 1, 31),
    months: field(month ?? '', 1, 12),
    weekdays: field(weekday, 0, 6),
    dayAny: day === '*',
    weekAny: weekday === '*',
  }
  const slots = cron.hours.flatMap((h) => cron.minutes.map((m) => h * 60 + m))
  const gaps = slots.map((slot, index) => (slots[index + 1] ?? (slots[0] ?? 0) + 1440) - slot)
  if (gaps.some((gap) => gap < 15)) throw new InvalidInput({ reason: 'cron interval must be at least 15 minutes' })
  return cron
}

const dayMatches = (cron: Cron, date: Date) => {
  const day = cron.days.includes(date.getUTCDate())
  const week = cron.weekdays.includes(date.getUTCDay())
  return cron.months.includes(date.getUTCMonth() + 1) && (cron.dayAny ? week : cron.weekAny ? day : day || week)
}

function nextOnDay(
  cron: Cron,
  day: number,
  offsets: ReadonlySet<number>,
  format: Intl.DateTimeFormat,
  after: number,
): number | undefined {
  const slots = cron.hours.flatMap((hour) => cron.minutes.map((minute) => day + hour * 3_600_000 + minute * MINUTE))
  for (const local of slots) {
    const candidates = [...offsets]
      .map((offset) => local - offset)
      .filter((candidate) => localMillis(localAt(format, candidate)) === local)
    if (candidates.length === 0) continue
    const candidate = Math.min(...candidates)
    if (candidate > after) return candidate
  }
  return undefined
}

/** DST gaps have no candidate; autumn repeats select only the earlier instant. Bounded to two years. */
export function nextCron(expression: string, zone: string, after: number): number {
  timezoneValid(zone)
  const cron = parseCron(expression)
  const format = formatter(zone)
  const start = localAt(format, after)
  const midnight = Date.UTC(start.year, start.month - 1, start.day)
  for (let index = 0; index < 732; index += 1) {
    const day = midnight + index * DAY
    const date = new Date(day)
    if (!dayMatches(cron, date)) continue
    const offsets = new Set(
      [-36, -12, 12, 36].map((h) => {
        const sample = day + h * 3_600_000
        return localMillis(localAt(format, sample)) - sample
      }),
    )
    const candidate = nextOnDay(cron, day, offsets, format, after)
    if (candidate !== undefined) return candidate
  }
  throw new InvalidInput({ reason: 'cron has no occurrence within two years' })
}

export function nextFire(definition: RoutineDefinition, after: number): number | null {
  timezoneValid(definition.timezone)
  switch (definition.trigger.kind) {
    case 'event':
      return null
    case 'cron':
      return nextCron(definition.trigger.expression, definition.timezone, after)
    case 'once': {
      const raw = definition.trigger.at
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(raw))
        throw new InvalidInput({ reason: 'reminder needs an ISO instant with an explicit UTC offset' })
      const calendar = raw.replace(/(?:Z|[+-]\d{2}:\d{2})$/u, '')
      const local = new Date(`${calendar}Z`)
      const normalized = local.toJSON()
      if (normalized === null || normalized.slice(0, 16) !== calendar.slice(0, 16))
        throw new InvalidInput({ reason: 'invalid reminder calendar date' })
      const at = Date.parse(raw)
      if (!Number.isFinite(at) || at <= after || at > after + 732 * DAY)
        throw new InvalidInput({ reason: 'reminder must be in the future within two years' })
      return at
    }
  }
}
