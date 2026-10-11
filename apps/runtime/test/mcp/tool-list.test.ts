import { createMcpHandler } from '@modelcontextprotocol/server'
import * as Option from 'effect/Option'
import { describe, expect, it } from 'vitest'
import type { McpStep } from '../../src/telemetry/report.ts'
import { lowLevelServer } from './low-level-server.ts'
import { managerOf } from './manager.ts'
import { MemoryGrants } from './memory.ts'

const serverConfig = { connectionId: 'roles', endpoint: 'https://roles.test/mcp' }

/**
 * A server whose tools change while goblin is connected, as Sidequest's do when the operator grants the agent a role
 * (ADR 0042): `names` is what it lists now, `lists` counts its tools/list answers and `opened` its handshakes. While
 * `hold` is set, a list waits for it.
 */
type RolesState = { names: string[]; lists: number; opened: number; pad: number; hold: Promise<void> | undefined }
const rolesServer = () => {
  const state: RolesState = { names: ['whoami'], lists: 0, opened: 0, pad: 0, hold: undefined }
  const official = createMcpHandler(() => {
    const server = lowLevelServer({ name: 'roles', version: '1.0.0' }, { capabilities: { tools: {} } })
    server.setRequestHandler('tools/list', async () => {
      state.lists += 1
      await state.hold
      return {
        tools: state.names.map((name) => ({
          name,
          description: 'x'.repeat(state.pad),
          inputSchema: { type: 'object' as const, properties: {} },
        })),
      }
    })
    server.setRequestHandler('tools/call', (request) => ({ content: [{ type: 'text', text: request.params.name }] }))
    return server
  })
  const reports: { step: McpStep; outcome: string }[] = []
  const manager = managerOf({
    servers: [serverConfig],
    allows: (grant) =>
      new MemoryGrants([
        { connectionId: 'roles', capability: 'tool', name: 'whoami' },
        { connectionId: 'roles', capability: 'tool', name: 'create_task' },
        { connectionId: 'roles', capability: 'tool', name: 'retired' },
      ]).allows(grant),
    auth: () => ({ token: async () => 'fixture' }),
    maxResultBytes: 4096,
    report: (step, outcome) => reports.push({ step, outcome }),
    fetch: async (input, init) => {
      const request = new Request(input, init)
      const body = request.method === 'POST' ? await request.clone().text() : ''
      if (/"method":"(?:server\/discover|initialize)"/u.test(body)) state.opened += 1
      return official.fetch(request)
    },
  })
  return { state, manager, reports }
}

describe("a connection's tools, re-listed in place (unit, ADR 0042)", () => {
  it('calls a tool the server added since it was listed, over the same connection', async () => {
    const { state, manager, reports } = rolesServer()
    try {
      await manager.connections.connect('roles')
      state.names = ['whoami', 'create_task']
      const result = await manager.connections.callTool('roles', 'create_task', {})
      expect(result.content).toEqual([{ type: 'text', text: 'create_task' }])
      expect(state.opened).toBe(1)
      const snapshot = Option.getOrThrow(await manager.connections.snapshot('roles'))
      expect(snapshot.tools.map(({ name }) => name)).toEqual(['whoami', 'create_task'])
      expect(reports.filter(({ step }) => step.step === 'tools')).toEqual([
        { step: { step: 'tools', connectionId: 'roles' }, outcome: 'ok' },
      ])
      // A granted tool it still does not list after that one more list is refused.
      await expect(manager.connections.callTool('roles', 'retired', {})).rejects.toMatchObject({ _tag: 'NotFound' })
      expect(state.lists).toBe(3)
    } finally {
      await manager.dispose()
    }
  })

  it('lists once more for the changes announced while a list is running, and no more', async () => {
    const { state, manager } = rolesServer()
    try {
      await manager.connections.connect('roles')
      const before = state.lists
      const held = Promise.withResolvers<void>()
      state.hold = held.promise
      const first = manager.connections.refreshTools('roles')
      while (state.lists === before) await new Promise((resolve) => setTimeout(resolve, 5))
      // Two changes arrive while that list waits: they are one more list, which every caller gets.
      state.names = ['whoami', 'create_task']
      const later = [manager.connections.refreshTools('roles'), manager.connections.refreshTools('roles')]
      await new Promise((resolve) => setTimeout(resolve, 20))
      state.hold = undefined
      held.resolve()
      const snapshots = await Promise.all([first, ...later])
      expect(state.lists - before).toBe(2)
      for (const snapshot of snapshots)
        expect(snapshot.tools.map(({ name }) => name)).toEqual(['whoami', 'create_task'])
    } finally {
      await manager.dispose()
    }
  })

  it('keeps no partial list: a list over the bound leaves the connection stale, and its next use opens it again', async () => {
    const { state, manager } = rolesServer()
    try {
      const opened = await manager.connections.connect('roles')
      state.pad = 8192
      await expect(manager.connections.refreshTools('roles')).rejects.toMatchObject({
        _tag: 'UpstreamMcp',
        reason: 'content-limit',
      })
      expect(await manager.connections.snapshot('roles')).toEqual(Option.some(opened))
      state.pad = 0
      state.names = ['whoami', 'create_task']
      const reopened = await manager.connections.connect('roles')
      expect(state.opened).toBe(2)
      expect(reopened.tools.map(({ name }) => name)).toEqual(['whoami', 'create_task'])
    } finally {
      await manager.dispose()
    }
  })
})
