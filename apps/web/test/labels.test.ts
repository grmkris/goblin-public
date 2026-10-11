import { describe, expect, it } from 'vitest'
import {
  eventStatus,
  planStatus,
  residentStatus,
  routineStatus,
  runStatus,
  serverStatus,
  connectionName,
  serverName,
  telegramReport,
} from '../src/lib/labels.ts'

describe('labels', () => {
  it('says a server state in words, never the raw value', () => {
    expect(serverStatus('connected')).toEqual({ text: 'Connected', tone: 'good' })
    expect(serverStatus('needs_auth')).toEqual({ text: 'Needs sign-in', tone: 'attention' })
    expect(serverStatus('disconnected')).toEqual({ text: 'Not connected', tone: 'quiet' })
  })

  it('says an event subscription state in words, and an unknown one as paused', () => {
    expect(eventStatus('active').text).toBe('Receiving')
    expect(eventStatus('terminated')).toEqual({ text: 'Needs reconnecting', tone: 'attention' })
    expect(eventStatus('something_new')).toEqual({ text: 'Paused', tone: 'quiet' })
  })

  it("calls a connection by the owner's label, and its server by its title, then its reported name", () => {
    expect(connectionName({ label: 'Board · Mine' })).toBe('Board · Mine')
    expect(serverName({ title: 'Board', serverName: 'fixture-board' })).toBe('Board')
    expect(serverName({ serverName: 'fixture-board' })).toBe('fixture-board')
    expect(serverName({})).toBeUndefined()
  })

  it('says the plan, the agent standing, a routine and a run in words', () => {
    const paid = {
      active: true,
      source: 'subscription',
      until: 1,
      dailyCredits: 800,
      status: 'active',
      hasCustomer: true,
      cancelAtPeriodEnd: false,
      mode: 'test_mode',
      plan: 'pro',
      priceCents: 1000,
    } as const
    expect(planStatus(paid)).toEqual({ text: 'Active', tone: 'good' })
    expect(planStatus({ ...paid, status: 'past_due' }).tone).toBe('attention')
    expect(planStatus({ ...paid, cancelAtPeriodEnd: true }).text).toBe('Ending')
    expect(planStatus({ ...paid, active: false }).text).toBe('Not subscribed')
    expect(residentStatus('revoked')).toEqual({ text: 'Off', tone: 'quiet' })
    expect(routineStatus({ state: 'proposed', health: null })).toEqual({
      text: 'Waiting for your OK',
      tone: 'attention',
    })
    expect(routineStatus({ state: 'active', health: 'execution_pending' }).text).toBe('Getting ready')
    expect(runStatus('waiting_owner')).toEqual({ text: 'Waiting for you', tone: 'attention' })
    expect(runStatus('failed').tone).toBe('bad')
  })

  it('says where a Telegram report stands, and nothing when none was asked for', () => {
    expect(telegramReport('none')).toBeUndefined()
    expect(telegramReport('accepted')).toBe('Sent to Telegram')
    expect(telegramReport('failed')).toBe('Telegram did not take it')
  })
})
