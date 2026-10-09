import { describe, expect, it } from 'vitest'
import type { AppView } from '@goblin/contracts'
import { agentApps, appHue, appNames, appOrigin } from '../src/lib/app-names.ts'

const app = (id: string, conversation: string, extra: Partial<AppView> = {}): AppView => ({
  id,
  conversation,
  source: { kind: 'mcp', callId: `call-${id}`, serverId: 'board', tool: 'show', uri: 'ui://board/app.html' },
  title: `Board ${id}`,
  createdAt: Number(id),
  ...extra,
})
const agent = (id: string): Partial<AppView> => ({
  source: { kind: 'agent', name: `app-${id}`, release: 'r_1', version: 1, revision: 0, jobs: [] },
})

describe('App names', () => {
  it('numbers Apps of one title within a conversation, closed ones counted, so names never shift', () => {
    const board = { title: 'Board' }
    const names = appNames([
      app('3', '1', board),
      app('1', '1', board),
      app('2', '1', { ...board, closedAt: 5 }),
      app('4', '6', board),
      app('5', '1', { title: 'Map' }),
    ])
    expect(Object.fromEntries(names)).toEqual({ 1: 'Board (1)', 2: 'Board (2)', 3: 'Board (3)', 4: 'Board', 5: 'Map' })
  })

  it('lists the open agent apps newest first, apart from MCP Apps', () => {
    const apps = [
      app('1', '1', agent('1')),
      app('2', '1'),
      app('3', '1', agent('3')),
      app('4', '1', { ...agent('4'), closedAt: 1 }),
    ]
    expect(agentApps(apps).map(({ id }) => id)).toEqual(['3', '1'])
    expect(appOrigin(apps[1] ?? app('0', '1'))).toBe('board')
    expect(appOrigin(apps[0] ?? app('0', '1'))).toBe('app-1')
  })

  it('gives a server the same hue every time, and different servers different ones', () => {
    expect(appHue('board')).toBe(appHue('board'))
    expect(appHue('board')).not.toBe(appHue('maps'))
    for (const id of ['board', 'maps', 'x', '']) expect(appHue(id)).toBeGreaterThanOrEqual(0)
    expect(appHue('maps')).toBeLessThan(360)
  })
})
