import { InMemoryServerEventBus, createMcpHandler } from '@modelcontextprotocol/server'
import * as Option from 'effect/Option'
import { describe, expect, it } from 'vitest'
import type { McpStep } from '../../src/telemetry/report.ts'
import { lowLevelServer } from './low-level-server.ts'
import { managerOf } from './manager.ts'
import { MemoryGrants } from './memory.ts'

const serverConfig = { connectionId: 'roles', endpoint: 'https://roles.test/mcp' }

type RolesState = {
  names: string[]
  lists: number
  opened: number
  listens: number
  pad: number
  hold: Promise<void> | undefined
}

/**
 * A server whose tools change while goblin is connected, as Sidequest's do when the operator grants the agent a role
 * (ADR 0042): `names` is what it lists now, `lists` counts its tools/list answers, `opened` its handshakes and
 * `listens` the listen streams asked of it. While `hold` is set, a list waits for it. With `listChanged` it announces
 * tool changes on listen streams, which goblin closes `listenIdleMs` after the connection's last use.
 */
const rolesServer = ({ listChanged = false, listenIdleMs = 60_000 } = {}) => {
  const state: RolesState = { names: ['whoami'], lists: 0, opened: 0, listens: 0, pad: 0, hold: undefined }
  const bus = new InMemoryServerEventBus()
  const official = createMcpHandler(
    () => {
      const capabilities = { tools: listChanged ? { listChanged: true } : {} }
      const server = lowLevelServer({ name: 'roles', version: '1.0.0' }, { capabilities })
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
    },
    { bus },
  )
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
    listenIdleMs,
    report: (step, outcome) => reports.push({ step, outcome }),
    fetch: async (input, init) => {
      const request = new Request(input, init)
      const body = request.method === 'POST' ? await request.clone().text() : ''
      if (/"method":"(?:server\/discover|initialize)"/u.test(body)) state.opened += 1
      if (body.includes('"method":"subscriptions/listen"')) state.listens += 1
      return official.fetch(request)
    },
  })
  const dispose = async () => {
    await manager.dispose()
    await official.close()
  }
  return { state, manager, reports, official, bus, dispose }
}

/** Waits, in small real steps, until `check` holds; fails after about five seconds. */
const until = async (check: () => boolean | Promise<boolean>) => {
  for (let step = 0; step < 500; step++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('the condition never held')
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

/** The names of the tools the connection lists now. */
const listed = async (manager: ReturnType<typeof rolesServer>['manager']) =>
  Option.getOrThrow(await manager.connections.snapshot('roles')).tools.map(({ name }) => name)

describe('live tool lists over subscriptions/listen (unit, ADR 0042)', () => {
  it('lists the tools again, in place, when the server announces a change while the connection is used', async () => {
    const { state, manager, official, bus, reports, dispose } = rolesServer({ listChanged: true })
    try {
      await manager.connections.connect('roles')
      await until(() => bus.listenerCount === 1)
      state.names = ['whoami', 'create_task']
      official.notify.toolsChanged()
      await until(async () => (await listed(manager)).includes('create_task'))
      expect(state.opened).toBe(1)
      expect(reports.some(({ step }) => step.step === 'tools')).toBe(true)
    } finally {
      await dispose()
    }
  })

  it('closes the stream once the connection goes unused, then lists first and listens again on its next use', async () => {
    const { state, manager, official, reports, dispose } = rolesServer({ listChanged: true, listenIdleMs: 50 })
    try {
      await manager.connections.connect('roles')
      // The stream's step is reported when it ends.
      await until(() => reports.some(({ step }) => step.step === 'listen'))
      expect(reports.find(({ step }) => step.step === 'listen')?.outcome).toBe('ok')
      // A change while nothing listens is not announced to goblin, and is not missed: the next use lists first.
      state.names = ['whoami', 'create_task']
      official.notify.toolsChanged()
      const next = await manager.connections.connect('roles')
      expect(next.tools.map(({ name }) => name)).toEqual(['whoami', 'create_task'])
      await until(() => state.listens === 2)
      expect(state.opened).toBe(1)
    } finally {
      await dispose()
    }
  })

  it("holds no stream for goblin's own background calls, only for the owner's and the model's use", async () => {
    const { state, manager, dispose } = rolesServer({ listChanged: true })
    try {
      // A plain model-caller call is background work: an agent app's job, a notice, the channel.
      await manager.connections.callTool('roles', 'whoami', {})
      await manager.connections.callTool('roles', 'whoami', {})
      expect(state.listens).toBe(0)
      await manager.connections.connect('roles')
      await until(() => state.listens === 1)
    } finally {
      await dispose()
    }
  })

  it('listens for a foreground caller that joins an open a background call started', async () => {
    const { state, manager, dispose } = rolesServer({ listChanged: true })
    try {
      await Promise.all([manager.connections.callTool('roles', 'whoami', {}), manager.connections.connect('roles')])
      await until(() => state.listens === 1)
      expect(state.opened).toBe(1)
    } finally {
      await dispose()
    }
  })

  it('closes the stream when the owner and the model stop, though background calls go on', async () => {
    const { state, manager, reports, dispose } = rolesServer({ listChanged: true, listenIdleMs: 60 })
    try {
      await manager.connections.connect('roles')
      await until(() => state.listens === 1)
      for (let call = 0; call < 8; call++) {
        await manager.connections.callTool('roles', 'whoami', {})
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      await until(() => reports.some(({ step }) => step.step === 'listen'))
      expect(state.listens).toBe(1)
    } finally {
      await dispose()
    }
  })

  it('never listens to a server that does not announce tool changes', async () => {
    const { state, manager, dispose } = rolesServer()
    try {
      await manager.connections.connect('roles')
      await manager.connections.callTool('roles', 'whoami', {})
      expect(state.listens).toBe(0)
    } finally {
      await dispose()
    }
  })
})
