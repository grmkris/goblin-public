import type { AgentAppJob } from '@goblin/contracts'
import { describe, expect, it } from 'vitest'
import { jobLine, jobTrouble, whenText } from '../src/lib/app-jobs.ts'

const now = new Date(2026, 9, 6, 10, 7).getTime()
const job: AgentAppJob = {
  action: 'refresh',
  every: '1h',
  at: null,
  nextAt: new Date(2026, 9, 6, 11, 0).getTime(),
  lastAt: null,
  status: null,
  failures: 0,
  paused: null,
}

describe('app jobs', () => {
  it('say what runs, how often and when next', () => {
    expect(jobLine(job, now)).toBe(`refresh hourly · next ${whenText(job.nextAt, now)}`)
    expect(whenText(new Date(2026, 9, 7, 6, 30).getTime(), now)).toMatch(/\S+ \S+/u)
    expect(jobTrouble(job)).toBe(false)
  })
  it('say why a schedule needs the owner', () => {
    expect(jobLine({ ...job, status: 'waiting' }, now)).toMatch(/waiting for you$/u)
    expect(jobLine({ ...job, status: 'failed', failures: 2 }, now)).toMatch(/last run failed$/u)
    expect(jobLine({ ...job, paused: 'failures', failures: 10 }, now)).toBe('refresh hourly · paused after 10 failures')
    expect(jobLine({ ...job, paused: 'owner' }, now)).toBe('refresh hourly · paused')
    expect(jobTrouble({ ...job, paused: 'owner' })).toBe(true)
  })
})
