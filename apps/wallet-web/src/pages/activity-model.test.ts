import type { Operation } from '@goblin/wallet/contract'
import { describe, expect, it } from 'vitest'
import { OPERATIONS } from '../api/fixtures.ts'
import { dayLabel, groupByDay, rowTime } from './activity-model.ts'

// Noon local time, so an hour either way stays on the same day in every time zone the tests run in.
const NOW = new Date(2026, 9, 12, 12, 0).getTime()
const at = (days: number, hours = 0): string => new Date(2026, 9, 12 - days, 12 - hours).toISOString()
const template = OPERATIONS[1]!
const opAt = (id: string, createdAt: string): Operation => ({ ...template, id, createdAt, updatedAt: createdAt })

describe('dayLabel', () => {
  it('says Today and Yesterday, then the date', () => {
    expect(dayLabel(at(0, 3), NOW)).toBe('Today')
    expect(dayLabel(at(1), NOW)).toBe('Yesterday')
    expect(dayLabel(at(5), NOW)).toBe(
      new Date(at(5)).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }),
    )
  })

  it('adds the year to a day from another year', () => {
    expect(dayLabel(new Date(2025, 11, 30, 12).toISOString(), NOW)).toContain('2025')
  })
})

describe('groupByDay', () => {
  it('groups by local day, newest day and newest row first', () => {
    const groups = groupByDay(
      [opAt('older', at(3)), opAt('today-1', at(0, 5)), opAt('yesterday', at(1)), opAt('today-2', at(0, 1))],
      NOW,
    )
    expect(groups.map((group) => group.label)).toEqual(['Today', 'Yesterday', dayLabel(at(3), NOW)])
    expect(groups[0]?.operations.map((operation) => operation.id)).toEqual(['today-2', 'today-1'])
  })

  it('is empty for no operations', () => {
    expect(groupByDay([], NOW)).toEqual([])
  })
})

describe('rowTime', () => {
  it('reads relative within the hour and as a time of day after', () => {
    expect(rowTime(new Date(NOW - 20_000).toISOString(), { now: NOW })).toBe('just now')
    expect(rowTime(new Date(NOW - 5 * 60_000).toISOString(), { now: NOW })).toBe('5 min ago')
    const earlier = at(0, 3)
    const time = new Date(earlier).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    expect(rowTime(earlier, { now: NOW })).toBe(time)
    expect(rowTime(earlier, { now: NOW, dated: true })).toBe(time)
  })

  it('names the day of an older row where no heading does', () => {
    expect(rowTime(at(1), { now: NOW, dated: true })).toMatch(/^Yesterday, /u)
    expect(rowTime(at(1), { now: NOW })).not.toMatch(/Yesterday/u)
  })
})
