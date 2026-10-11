import type { RoutineView } from '@goblin/contracts'
import { describe, expect, it } from 'vitest'
import { reviewed } from '../src/components/parts/routine-proposal.tsx'

const ROUTINE: RoutineView = {
  id: 'rt_daily',
  revision: 2,
  state: 'proposed',
  definition: {
    title: 'Daily',
    timezone: 'UTC',
    trigger: { kind: 'cron', expression: '0 8 * * *' },
    tellMe: { on: false, telegram: false },
    handTo: {
      kind: 'goblin',
      instruction: 'Summarize the day.',
      allowedTools: [],
      budget: { tokensPerRun: 25_000, tokensPerDay: 50_000, runtimeSeconds: 900 },
    },
  },
  confirmedAt: null,
  nextFireAt: null,
  lastFireAt: null,
  missedCount: 0,
  suppressedCount: 0,
  health: null,
  createdAt: 1,
  updatedAt: 1,
}

describe("a routine proposal's review", () => {
  it('shows nothing before the routines are read', () => {
    expect(reviewed(undefined, 'rt_daily', 2)).toEqual({ routine: undefined, note: '' })
  })

  it('shows the routine as it is now, and says when it changed since the proposal', () => {
    expect(reviewed([ROUTINE], 'rt_daily', 2)).toEqual({ routine: ROUTINE, note: '' })
    expect(reviewed([ROUTINE], 'rt_daily', 1).note).toBe('The routine has changed. Review its current revision below.')
  })

  it('says when the routine is gone', () => {
    expect(reviewed([], 'rt_daily', 2)).toEqual({
      routine: undefined,
      note: 'This routine has been archived or removed.',
    })
  })
})
