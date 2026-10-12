import { describe, expect, it } from 'vitest'
import type { ServerProfile, ToolView } from '@goblin/contracts'
import {
  compactAmount,
  recommendedApplied,
  recommendedList,
  topUpOf,
  walletSummary,
} from '../src/components/first-class.tsx'
import { purposeGroups } from '../src/components/tool-grants.tsx'

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

describe('what Review recommended access lists', () => {
  it('names exactly the recommended tools the server lists now, by title, in each policy', () => {
    const listed = [
      { ...tool('search_services', false), title: 'Search services' },
      tool('quote_plan', false),
      { ...tool('create_job', false), title: 'Create a job' },
      tool('unrelated', false),
    ]
    // list_jobs is recommended but not offered now, so it is not promised.
    expect(recommendedList(profile, listed)).toEqual({ run: ['Search services', 'quote_plan'], ask: ['Create a job'] })
  })
})

describe('how Connections groups the tools outside an App', () => {
  it("sorts by the server's own read-only claim and leaves App tools to their App", () => {
    const groups = purposeGroups([
      { ...tool('read', false), readOnlyHint: true },
      tool('write', false),
      { ...tool('view', false), appResource: 'ui://x/view' },
    ])
    expect(groups.map(({ title, members }) => [title, members.map((each) => each.name)])).toEqual([
      ['The server says these only read', ['read']],
      ['These may change things or spend', ['write']],
    ])
  })
})

describe("the wallet's one line on its card", () => {
  it('shows amounts at a glance, never rounding a positive amount to zero', () => {
    expect(compactAmount('0.006375759235598615')).toBe('0.006375')
    expect(compactAmount('10.155533')).toBe('10.15')
    expect(compactAmount('5')).toBe('5')
    expect(compactAmount('0')).toBe('0')
  })
  it('says what is left once when every token shares it, and per token otherwise', () => {
    const shared = {
      ...wallet('ready'),
      tokens: [
        { symbol: 'ETH', balance: '0.006375759235598615', remaining: '5' },
        { symbol: 'USDC', balance: '0.50039', remaining: '5' },
      ],
    }
    expect(walletSummary(shared, 'Mon, Oct 12')).toBe('0.006375 ETH · 0.5003 USDC; 5 left until Mon, Oct 12')
    const apart = { ...shared, tokens: [shared.tokens[0]!, { ...shared.tokens[1]!, remaining: '2.5' }] }
    expect(walletSummary(apart, undefined)).toBe('0.006375 ETH, 5 left · 0.5003 USDC, 2.5 left')
    expect(walletSummary({ ...shared, tokens: [] }, undefined)).toBe('no balance read')
  })
})
