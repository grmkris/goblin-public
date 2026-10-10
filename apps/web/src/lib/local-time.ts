import { pad } from './format.ts'

/**
 * A `datetime-local` value (wall time in this browser's zone) as the ISO instant with its UTC offset a reminder needs,
 * or nothing when it is not a time.
 */
export function localInstant(value: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(value)) return undefined
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return undefined
  const offset = -date.getTimezoneOffset()
  const sign = offset < 0 ? '-' : '+'
  return `${value}:00${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
}

/** An instant as a `datetime-local` value in this browser's zone, or empty when it is not one. */
export function localInput(instant: string): string {
  const date = new Date(instant)
  if (Number.isNaN(date.getTime())) return ''
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return `${day}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}
