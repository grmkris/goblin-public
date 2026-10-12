import { describe, expect, it } from 'vitest'
import type { ServerProfile, ToolView } from '@goblin/contracts'
import { recommendedApplied } from '../src/components/first-class.tsx'

const profile: ServerProfile = {
  id: 'mercator',
  title: 'Mercator',
  description: 'Search and outside work.',
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
