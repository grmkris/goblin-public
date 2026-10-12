import type { Me } from '@goblin/wallet/contract'
import { describe, expect, it } from 'vitest'
import {
  confirmationsText,
  DEFAULT_CHOICE,
  hourlyCap,
  isDays,
  limitsSentence,
  readySentence,
  screenOf,
  spendingItems,
  stepOf,
} from './model.ts'

const limits = { perCall: '5', perHour: '20', perWeek: '50', expiresAt: '2026-10-19T00:00:00Z', version: 1 }

describe('screenOf', () => {
  it('follows the server: the agent wallet, funds, spending, done', () => {
    expect(screenOf('agent', false)).toBe('agent')
    expect(screenOf('fund', false)).toBe('fund')
    expect(screenOf('upgrade', false)).toBe('spending')
    expect(screenOf('allowance', false)).toBe('spending')
    expect(screenOf('done', false)).toBe('done')
  })
  it('keeps the funding screen once USDC lands, until the owner continues', () => {
    expect(screenOf('upgrade', true)).toBe('fund')
    // Past the upgrade there is nothing left to fund for.
    expect(screenOf('allowance', true)).toBe('spending')
    expect(screenOf('done', true)).toBe('done')
  })
  it('numbers only the owner’s own tasks', () => {
    expect([stepOf('agent'), stepOf('fund'), stepOf('spending'), stepOf('done')]).toEqual([undefined, 1, 2, undefined])
  })
})

const states = (input: Parameters<typeof spendingItems>[0]) => spendingItems(input).map((item) => item.state)

describe('spendingItems', () => {
  const idle = { upgraded: false, allowed: false, phase: 'idle', failed: false } as const
  it('shows what the server says is done, whatever this page knows', () => {
    expect(states(idle)).toEqual(['todo', 'todo', 'todo'])
    expect(states({ ...idle, upgraded: true })).toEqual(['done', 'done', 'todo'])
    expect(states({ ...idle, upgraded: true, allowed: true })).toEqual(['done', 'done', 'done'])
  })
  it('follows each confirmation as it is asked for', () => {
    expect(states({ ...idle, phase: 'authorize' })).toEqual(['active', 'todo', 'todo'])
    expect(states({ ...idle, phase: 'confirm' })).toEqual(['done', 'active', 'todo'])
    expect(states({ ...idle, phase: 'allowance' })).toEqual(['done', 'done', 'active'])
  })
  it('marks the confirmation that did not finish', () => {
    expect(states({ ...idle, phase: 'confirm', failed: true })).toEqual(['done', 'failed', 'todo'])
    expect(states({ ...idle, upgraded: true, phase: 'allowance', failed: true })).toEqual(['done', 'done', 'failed'])
  })
  it('names the three confirmations', () => {
    expect(spendingItems(idle).map((item) => item.label)).toEqual([
      'Upgrade your account',
      'Confirm the upgrade',
      'Set your allowance',
    ])
  })
})

describe('the limits in words', () => {
  it('says the allowance and the wallet’s own limits as people say them', () => {
    expect(limitsSentence(DEFAULT_CHOICE, limits)).toBe(
      'Your agent may spend up to $20 an hour, $5 per payment and $50 a week, for 7 days.',
    )
    expect(limitsSentence({ perHour: '2.5', days: 1 }, undefined)).toBe(
      'Your agent may spend up to $2.50 an hour, $5 per payment and $50 a week, for 1 day.',
    )
  })
  it('counts the confirmations left', () => {
    expect(confirmationsText(false)).toBe("You'll confirm three times.")
    expect(confirmationsText(true)).toBe("You'll confirm once.")
  })
  it('takes 1 to 30 whole days', () => {
    expect(['1', '7', '30'].every(isDays)).toBe(true)
    expect(['0', '31', '1.5', '', '-1', '07'].some(isDays)).toBe(false)
  })
  it('names the wallet’s own hourly limit when it is lower than the allowance', () => {
    expect(hourlyCap({ perHour: '30', days: 7 }, limits)).toBe('$20')
    expect(hourlyCap({ perHour: '20', days: 7 }, limits)).toBeUndefined()
    expect(hourlyCap({ perHour: 'x', days: 7 }, limits)).toBeUndefined()
    expect(hourlyCap({ perHour: '30', days: 7 }, undefined)).toBeUndefined()
  })
  it('says what the agent can spend once ready', () => {
    const me: Me = {
      userId: 'u',
      owner: '0x4f1B7c0a2D9e3b86A5c1E7f09d4B2a6C8e3F5a17',
      chains: [
        {
          chain: 'base',
          upgraded: true,
          allowance: { perHour: '20', expiresAt: '2026-10-19T00:00:00Z', delegationHash: '0xab' },
        },
      ],
    }
    expect(readySentence(me)).toBe('Your agent can spend up to $20 an hour from your USDC on Base.')
    expect(readySentence({ ...me, chains: [] })).toBe('Your agent can spend within the limits you set.')
  })
})
