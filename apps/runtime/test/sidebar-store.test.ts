import { EMPTY_SIDEBAR, MAX_PINS, type SidebarPins } from '@goblin/contracts'
import { describe, expect, it } from 'vitest'
import { editedSidebar, withoutServer, withoutView } from '../src/sidebar/store.ts'

const wallet = { kind: 'server', connectionId: 'wallet' } as const
const board = { kind: 'view', appId: '7', title: 'Trip board' } as const

describe('sidebar pins (ADR 0053, unit)', () => {
  it('stores the servers it adopts first, then applies the edit, a revision on', () => {
    const next = editedSidebar(EMPTY_SIDEBAR, {
      expectedRevision: 0,
      adopt: ['wallet'],
      op: { kind: 'pin', pin: board },
    })
    expect(next).toEqual({ revision: 1, pins: [wallet, board], seen: ['wallet'] })
  })

  it('remembers a server it unpins, so the sidebar never pins it on its own again', () => {
    const next = editedSidebar(EMPTY_SIDEBAR, {
      expectedRevision: 0,
      adopt: ['wallet'],
      op: { kind: 'unpin', target: wallet },
    })
    expect(next.pins).toEqual([])
    expect(next.seen).toEqual(['wallet'])
    const again = editedSidebar(next, { expectedRevision: 1, adopt: ['wallet'], op: { kind: 'pin', pin: board } })
    expect(again.pins).toEqual([board])
  })

  it('moves a pin to an index of the list it is in, and pinning what is pinned moves it', () => {
    const start: SidebarPins = { revision: 2, pins: [wallet, board], seen: ['wallet'] }
    expect(editedSidebar(start, { expectedRevision: 2, op: { kind: 'move', target: board, index: 0 } }).pins).toEqual([
      board,
      wallet,
    ])
    expect(editedSidebar(start, { expectedRevision: 2, op: { kind: 'pin', pin: wallet } }).pins).toEqual([
      board,
      wallet,
    ])
  })

  it(`refuses a pin past ${MAX_PINS}`, () => {
    const full: SidebarPins = {
      revision: 0,
      pins: Array.from({ length: MAX_PINS }, (_, index) => ({ kind: 'server', connectionId: `s${index}` }) as const),
      seen: [],
    }
    expect(() => editedSidebar(full, { expectedRevision: 0, op: { kind: 'pin', pin: board } })).toThrow()
  })

  it('takes a removed server’s pin and forgets it, and a deleted App’s view; nothing when neither was there', () => {
    const start: SidebarPins = { revision: 4, pins: [wallet, board], seen: ['wallet'] }
    expect(withoutServer(start, 'wallet')).toEqual({ revision: 5, pins: [board], seen: [] })
    expect(withoutView(start, '7')).toEqual({ revision: 5, pins: [wallet], seen: ['wallet'] })
    expect(withoutServer(start, 'other')).toBeUndefined()
    expect(withoutView(start, '8')).toBeUndefined()
  })
})
