import { describe, expect, it } from 'vitest'
import { nextCron, nextFire, parseCron } from '../src/routines/time.ts'
import { browserWrite } from '../src/http/csrf.ts'
import type { RoutineDefinition } from '@goblin/contracts'

const at = (iso: string) => Date.parse(iso)
const reminder: RoutineDefinition = {
  title: 'Reminder',
  prompt: 'Remind me.',
  timezone: 'Europe/Berlin',
  notifyTelegram: false,
  allowedTools: [],
  trigger: { kind: 'once', at: '2026-10-06T09:00:00+02:00' },
  budget: { tokensPerRun: 25_000, tokensPerDay: 50_000, runtimeSeconds: 900 },
}
describe('routine dates and schedule policy', () => {
  it('resolves explicit offsets and refuses ambiguous local reminders', () => {
    expect(nextFire(reminder, at('2026-10-05T00:00:00Z'))).toBe(at('2026-10-06T07:00:00Z'))
    expect(() =>
      nextFire({ ...reminder, trigger: { kind: 'once', at: '2026-10-06T09:00:00' } }, at('2026-10-05T00:00:00Z')),
    ).toThrow()
  })
  it('skips the spring DST gap and fires an autumn repeated time only at its earlier instant', () => {
    expect(nextCron('30 2 * * *', 'Europe/Berlin', at('2026-03-28T02:00:00Z'))).toBe(at('2026-03-30T00:30:00Z'))
    expect(nextCron('30 2 * * *', 'Europe/Berlin', at('2026-10-24T02:00:00Z'))).toBe(at('2026-10-25T00:30:00Z'))
    expect(nextCron('30 2 * * *', 'Europe/Berlin', at('2026-10-25T00:30:00Z'))).toBe(at('2026-10-26T01:30:00Z'))
  })
  it('supports ranges, lists and steps with the approved minimum interval', () => {
    expect(nextCron('*/15 9-17 * * 1-5', 'UTC', at('2026-10-05T08:55:00Z'))).toBe(at('2026-10-05T09:00:00Z'))
    expect(() => parseCron('*/14 * * * *')).toThrow()
    expect(() => parseCron('0,5 * * * *')).toThrow()
    expect(() => parseCron('* * * * * *')).toThrow()
  })
  it('fails invalid timezone, impossible cron dates and past reminders visibly', () => {
    expect(() => nextCron('0 9 * * *', 'Mars/Base', at('2026-10-05T00:00:00Z'))).toThrow()
    expect(() => nextCron('0 9 31 2 *', 'UTC', at('2026-10-05T00:00:00Z'))).toThrow()
    expect(() => nextFire(reminder, at('2026-10-07T00:00:00Z'))).toThrow()
    expect(() =>
      nextFire({ ...reminder, trigger: { kind: 'once', at: '2027-02-30T09:00:00Z' } }, at('2026-10-05T00:00:00Z')),
    ).toThrow()
  })
  it('requires exact configured origin and CSRF header on every routine write', () => {
    const url = 'https://goblin.test/api/routines'
    expect(() => browserWrite(new Request(url, { method: 'POST' }), 'https://goblin.test')).toThrow()
    expect(() =>
      browserWrite(
        new Request(url, { method: 'POST', headers: { origin: 'https://foreign.test', 'x-goblin-csrf': '1' } }),
        'https://goblin.test',
      ),
    ).toThrow()
    expect(() =>
      browserWrite(
        new Request(url, { method: 'POST', headers: { origin: 'https://goblin.test', 'x-goblin-csrf': '1' } }),
        'https://goblin.test',
      ),
    ).not.toThrow()
  })
})
