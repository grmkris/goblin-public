import { describe, expect, it } from 'vitest'
import type { ServerProfile, ToolView } from '@goblin/contracts'
import { recommendedApplied, topUpOf } from '../src/components/first-class.tsx'

const profile: ServerProfile = {
  id: 'mercator',
  title: 'Mercator',
  description: 'Search and outside work.',
  offer: 'so goblin can search the web',
  recommended: { run: ['search_services', 'quote_plan', 'list_jobs'], ask: ['create_job'] },
  status: true,
}

/** A tool as Connections lists it, allowed or not, asking first or not. */
const tool = (name: string, granted: boolean, askFirst = false): ToolView => ({
  name,
  granted,
  askFirst,
  modelVisible: true,
})

describe('whether a first-class server still offers Allow recommended', () => {
  it('is applied once every listed free tool is allowed and the paid one asks first; an unlisted tool does not count', () => {
    const allowed = [tool('search_services', true), tool('quote_plan', true), tool('create_job', true, true)]
    expect(recommendedApplied(profile, allowed)).toBe(true)
    expect(recommendedApplied(profile, [...allowed.slice(0, 2), tool('create_job', true)])).toBe(false)
    expect(recommendedApplied(profile, [tool('search_services', false), ...allowed.slice(1)])).toBe(false)
  })
})

/** A wallet as its status line reads, needing funds or not. */
const wallet = (funding: 'ready' | 'blocked') => ({
  kind: 'wallet' as const,
  paid: 'ready' as const,
  funding,
  tokens: [],
})

describe('where the owner adds funds', () => {
  const funded = { ...profile, topUp: { url: 'https://mercator.sh/account' } }

  it("offers the profile's link only while the wallet needs funds, and only an https one", () => {
    expect(topUpOf(funded, wallet('blocked'))).toBe('https://mercator.sh/account')
    expect(topUpOf(funded, wallet('ready'))).toBeUndefined()
    expect(topUpOf(profile, wallet('blocked'))).toBeUndefined()
    expect(topUpOf({ ...profile, topUp: { url: 'javascript:alert(1)' } }, wallet('blocked'))).toBeUndefined()
  })
})
