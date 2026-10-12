import { describe, expect, it } from 'vitest'
import { checkLimits } from './limit-draft.ts'

describe('checkLimits', () => {
  it('accepts the defaults', () => {
    expect(checkLimits({ perCall: '5', perHour: '20', perWeek: '50' })).toEqual([])
  })
  it('rejects non-amounts and zero', () => {
    expect(checkLimits({ perCall: '', perHour: '20', perWeek: '50' })).toHaveLength(1)
    expect(checkLimits({ perCall: '5', perHour: '0', perWeek: '1e3' })).toHaveLength(2)
  })
  it('keeps call <= hour <= week', () => {
    expect(checkLimits({ perCall: '25', perHour: '20', perWeek: '50' })[0]?.field).toBe('perCall')
    expect(checkLimits({ perCall: '5', perHour: '60', perWeek: '50' })[0]?.field).toBe('perHour')
  })
})
