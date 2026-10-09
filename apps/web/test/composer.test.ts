import { describe, expect, it } from 'vitest'
import { canSend, composerTrigger, pickerItems, selectionFailure, withoutTrigger } from '../src/lib/composer.ts'
import { InvalidInput } from '@goblin/contracts/api'

const skill = {
  selection: { kind: 'skill' as const, serverId: 'myskills', uri: 'skill://one/SKILL.md' },
  label: 'review',
  description: 'Review code',
}
const connection = {
  selection: { kind: 'connection' as const, serverId: 'myplan' },
  label: 'MyPlan',
  description: 'Connection hint',
}

describe('composer selection semantics', () => {
  it('opens only for a slash or at token at the caret', () => {
    expect(composerTrigger('/rev', 4)).toMatchObject({ prefix: '/', query: 'rev' })
    expect(composerTrigger('email@example.com', 17)).toBeUndefined()
    expect(composerTrigger('path/@literal', 13)).toBeUndefined()
  })
  it('filters slash to skills and at to all references', () => {
    expect(pickerItems({ prefix: '/', query: '', start: 0, end: 1 }, [skill, connection], [])).toEqual([
      expect.objectContaining({ kind: 'command', label: 'help' }),
      expect.objectContaining({ kind: 'command', label: 'new-thread' }),
      expect.objectContaining({ kind: 'command', label: 'stop' }),
      expect.objectContaining({ kind: 'reference', label: 'review' }),
    ])
    expect(pickerItems({ prefix: '@', query: '', start: 0, end: 1 }, [skill, connection], [])).toHaveLength(2)
  })
  it('removes only the selected token and permits skill-only sends', () => {
    const trigger = composerTrigger('please /review', 14)
    expect(trigger).toBeDefined()
    if (trigger === undefined) throw new Error('missing trigger')
    expect(withoutTrigger('please /review', trigger)).toBe('please ')
    expect(canSend('', [skill])).toBe(true)
    expect(canSend('', [])).toBe(false)
  })
  it('maps a server selection failure to its chip', () => {
    expect(
      selectionFailure(new InvalidInput({ reason: 'composer:skill:myskills:skill://one/SKILL.md' }), [skill.selection]),
    ).toBe('skill:myskills:skill://one/SKILL.md')
  })
})
