import { Conflict } from '@goblin/contracts/api'
import { describe, expect, it } from 'vitest'
import { withRef } from '../src/lib/refusal.ts'

describe("the page's own refusal copy", () => {
  it('ends with the reference the agent stamped, shortened as messageOf shortens it', () => {
    const failure = new Conflict({ reason: 'topic_name_taken', ref: '7f3a9c12e4b5a6d7-AMS' })
    expect(withRef('A topic already has that name.', failure)).toBe('A topic already has that name. · ref 7f3a9c12')
  })
  it('stays as it is when the failure has no reference', () => {
    expect(withRef('Already undone.', new Conflict({ reason: 'undone' }))).toBe('Already undone.')
    expect(withRef('Connection failed', new TypeError('Failed to fetch'))).toBe('Connection failed')
  })
})
