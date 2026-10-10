import { describe, expect, it } from 'vitest'
import type { ConversationActivity, ConversationView } from '@goblin/contracts'
import { isBusy, subagentLabel, subagentState, workingUnder } from '../src/lib/subagent-state.ts'

const view = (id: string, extra: Partial<ConversationView> = {}): ConversationView => ({
  id,
  kind: 'subagent',
  parent: '1',
  keepOpen: false,
  replies: 1,
  createdAt: Number(id),
  ...extra,
})
const at = (id: string, state: ConversationActivity['state'], since = 0): ConversationActivity => ({ id, state, since })

describe('where a subagent is', () => {
  it('reads its work from the activity, and its closing before anything else', () => {
    expect(subagentState(view('2'), at('2', 'working', 500))).toEqual({ kind: 'working', since: 500 })
    expect(subagentState(view('2'), at('2', 'waiting'))).toEqual({ kind: 'waiting' })
    expect(subagentState(view('2', { closedAt: 9, closedBy: 'done' }), at('2', 'working'))).toEqual({
      kind: 'closed',
      by: 'done',
    })
    expect(subagentState(view('2', { closedAt: 9, closedBy: 'owner' }), undefined)).toEqual({
      kind: 'closed',
      by: 'owner',
    })
  })
  it('is reported once it answered, idle before that, and stopped only as the page last saw it', () => {
    expect(subagentState(view('2', { lastReplyAt: 70 }), undefined)).toEqual({ kind: 'reported', at: 70 })
    expect(subagentState(view('2'), undefined)).toEqual({ kind: 'idle' })
    expect(subagentState(view('2'), undefined, true)).toEqual({ kind: 'stopped' })
    expect(subagentState(view('2'), at('2', 'working', 5), true)).toEqual({ kind: 'working', since: 5 })
  })
  it('says it in words, with how long ago it reported', () => {
    expect(subagentLabel({ kind: 'reported', at: 1_000 }, 1_180)).toBe('reported 3 minutes ago')
    expect(subagentLabel({ kind: 'closed', by: 'done' }, 0)).toBe('closed after its report')
    expect(subagentLabel({ kind: 'closed', by: 'owner' }, 0)).toBe('closed by you')
    expect(subagentLabel({ kind: 'waiting' }, 0)).toBe('waiting on its subagents')
  })
  it('can be stopped while it or anything under it works', () => {
    expect(isBusy({ kind: 'working', since: 0 }, 0)).toBe(true)
    expect(isBusy({ kind: 'reported', at: 0 }, 1)).toBe(true)
    expect(isBusy({ kind: 'reported', at: 0 }, 0)).toBe(false)
  })
})

describe('work under a subagent', () => {
  it('counts the active subagents below it at any depth, and stops on a cycle', () => {
    const views = [
      view('2'),
      view('3', { parent: '2' }),
      view('4', { parent: '3' }),
      view('5', { parent: '2' }),
      view('6', { parent: '2', kind: 'thread' }),
      view('7', { parent: '7' }),
    ]
    const activity = { '3': at('3', 'waiting'), '4': at('4', 'working', 1), '6': at('6', 'working', 1) }
    expect(workingUnder('2', views, activity)).toBe(2)
    expect(workingUnder('7', views, activity)).toBe(0)
  })
})
