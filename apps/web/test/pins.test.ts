import { describe, expect, it } from 'vitest'
import type { AppView, ServerView, SidebarPins } from '@goblin/contracts'
import { appPin, moveOperation, pinnedRows } from '../src/lib/pins.ts'

const server = (connectionId: string, overrides: Partial<ServerView> = {}): ServerView => ({
  connectionId,
  label: connectionId,
  endpoint: `https://${connectionId}.example/mcp`,
  status: 'connected',
  live: true,
  source: 'config',
  entrypoint: 'open',
  ...overrides,
})

const app = (id: string, overrides: Partial<AppView> = {}): AppView => ({
  id,
  conversation: '1',
  title: 'Board',
  createdAt: Number(id),
  source: { kind: 'mcp', callId: `call-${id}`, connectionId: 'plan', tool: 'board', uri: 'ui://plan/board' },
  ...overrides,
})

const pins = (overrides: Partial<SidebarPins> = {}): SidebarPins => ({ revision: 3, pins: [], seen: [], ...overrides })

describe('the sidebar’s pins (ADR 0053)', () => {
  it('shows the stored pins in order, then the servers with their own App it has never pinned, to adopt', () => {
    const stored = pins({
      pins: [
        { kind: 'view', appId: '7', title: 'Trip board' },
        { kind: 'server', connectionId: 'wallet' },
      ],
      seen: ['wallet', 'gone'],
    })
    const rows = pinnedRows(stored, [server('wallet'), server('mercator'), server('gone')], [app('7')])
    expect(rows.shown.map((pin) => (pin.kind === 'server' ? pin.connectionId : pin.appId))).toEqual([
      '7',
      'wallet',
      'mercator',
    ])
    expect(rows.adopt).toEqual(['mercator'])
  })

  it('hides a pin whose server is signed out or whose App is gone, and keeps it stored', () => {
    const stored = pins({
      pins: [
        { kind: 'server', connectionId: 'wallet' },
        { kind: 'view', appId: '9', title: 'Gone' },
      ],
      seen: ['wallet'],
    })
    const rows = pinnedRows(stored, [server('wallet', { status: 'needs_auth' })], [])
    expect(rows.shown).toEqual([])
    expect(rows.adopt).toEqual([])
  })

  it('moves a row to its shown neighbour’s place among the stored pins, past hidden ones', () => {
    const stored = pins({
      pins: [
        { kind: 'server', connectionId: 'a' },
        { kind: 'server', connectionId: 'hidden' },
        { kind: 'server', connectionId: 'b' },
      ],
      seen: ['a', 'hidden', 'b'],
    })
    const rows = pinnedRows(stored, [server('a'), server('b')], [])
    expect(moveOperation(stored, rows, { kind: 'server', connectionId: 'b' }, -1)).toEqual({
      kind: 'move',
      target: { kind: 'server', connectionId: 'b' },
      index: 0,
    })
    expect(moveOperation(stored, rows, { kind: 'server', connectionId: 'a' }, -1)).toBeUndefined()
  })

  it('pins a server’s own App as its server, any other App as its view', () => {
    const own = app('4', {
      source: { kind: 'mcp', callId: 'x', connectionId: 'wallet', tool: 'open', uri: 'ui://w', entrypoint: true },
    })
    expect(appPin(own, 'Wallet')).toEqual({ kind: 'server', connectionId: 'wallet' })
    expect(appPin(app('5'), 'Board (2)')).toEqual({ kind: 'view', appId: '5', title: 'Board (2)' })
  })
})
