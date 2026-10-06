import { describe, expect, it } from 'vitest'
import { InMemoryTransport } from '@modelcontextprotocol/client'
import { App } from '@modelcontextprotocol/ext-apps'
import { createAppBridge, type AppCalls } from '../src/lib/app-bridge.ts'
import type { AgentAppCalls } from '../src/lib/agent-app-bridge.ts'
import type { FrameEvents } from '../src/components/apps/frame.tsx'

const events: FrameEvents = {
  report: () => undefined,
  resize: () => undefined,
  close: () => undefined,
  requestMode: (mode) => mode,
  share: () => undefined,
  offerLink: () => undefined,
  offerDownload: () => undefined,
  askGrant: async () => false,
}
/** An MCP App's frame reaches no agent app route. */
const noAgent: AgentAppCalls = {
  call: async () => {
    throw new Error('not an agent app')
  },
  state: async () => {
    throw new Error('not an agent app')
  },
  report: async () => {
    throw new Error('not an agent app')
  },
}
async function pair(serverId: string, calls: Omit<AppCalls, 'agent'>) {
  const { bridge } = createAppBridge(
    { kind: 'mcp', serverId, uri: `ui://${serverId}/app`, arguments: {}, result: { content: [] } },
    '',
    { displayMode: 'inline' },
    { ...calls, agent: noAgent },
    events,
  )
  const app = new App({ name: 'Fixture', version: '1' }, {}, { autoResize: false })
  const [host, client] = InMemoryTransport.createLinkedPair()
  await bridge.connect(host)
  await app.connect(client)
  return {
    bridge,
    app,
    close: async () => {
      await app.close()
      await bridge.close()
    },
  }
}

describe('official MCP App bridge stays bound to its originating connection', () => {
  it('reconnects the same originating App after teardown without retaining the old bridge', async () => {
    const reached: string[] = []
    const calls: Omit<AppCalls, 'agent'> = {
      tool: async (serverId, params) => {
        reached.push(`${serverId}:${params.name}`)
        return { content: [{ type: 'text', text: serverId }] }
      },
      resource: async (serverId, params) => ({ contents: [{ uri: params.uri, text: serverId }] }),
    }
    const first = await pair('notes', calls)
    try {
      await first.app.callServerTool({ name: 'before' })
    } finally {
      await first.close()
    }
    await expect(first.app.callServerTool({ name: 'stale' })).rejects.toThrow()
    const remounted = await pair('notes', calls)
    try {
      expect(await remounted.app.callServerTool({ name: 'after', arguments: { serverId: 'other' } })).toMatchObject({
        content: [{ text: 'notes' }],
      })
    } finally {
      await remounted.close()
    }
    expect(reached).toEqual(['notes:before', 'notes:after'])
  })

  it('continues tool/resource calls after placement updates and reconnects a new selection cleanly', async () => {
    const reached: string[] = []
    const calls: Omit<AppCalls, 'agent'> = {
      tool: async (serverId, params) => {
        reached.push(`${serverId}:${params.name}`)
        return { content: [{ type: 'text', text: serverId }] }
      },
      resource: async (serverId, params) => {
        reached.push(`${serverId}:${params.uri}`)
        return { contents: [{ uri: params.uri, text: serverId }] }
      },
    }
    const first = await pair('notes', calls)
    try {
      expect(await first.app.callServerTool({ name: 'read', arguments: { serverId: 'evil' } })).toMatchObject({
        content: [{ text: 'notes' }],
      })
      for (const surface of ['page', 'home', 'inline'] as const) {
        first.bridge.setHostContext({
          displayMode: surface === 'page' ? 'fullscreen' : 'inline',
          containerDimensions: { width: 400, maxHeight: 600 },
          surface,
          ...(surface === 'home' ? { tileSize: 'small' } : {}),
        })
        expect(
          await first.app.callServerTool({ name: 'after-placement', arguments: { serverId: 'evil' } }),
        ).toMatchObject({ content: [{ text: 'notes' }] })
        expect(await first.app.readServerResource({ uri: 'data://value' })).toMatchObject({
          contents: [{ text: 'notes' }],
        })
      }
    } finally {
      await first.close()
    }
    await expect(first.app.callServerTool({ name: 'read' })).rejects.toThrow()
    const second = await pair('other', calls)
    try {
      expect(await second.app.callServerTool({ name: 'read' })).toMatchObject({ content: [{ text: 'other' }] })
    } finally {
      await second.close()
    }
    expect(reached).toEqual([
      'notes:read',
      'notes:after-placement',
      'notes:data://value',
      'notes:after-placement',
      'notes:data://value',
      'notes:after-placement',
      'notes:data://value',
      'other:read',
    ])
  })
})

/** An agent app's frame reaches no MCP server. */
const notMcp = async (): Promise<never> => {
  throw new Error('not an MCP App')
}

/** Resolves once `ready` holds, checking every few milliseconds for at most a second. */
async function until(ready: () => boolean): Promise<void> {
  for (let tries = 0; tries < 200 && !ready(); tries++) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(ready()).toBe(true)
}

describe('an agent app bridge', () => {
  it('starts the view with its state, calls actions with the frame op, pushes newer state and reports', async () => {
    const reached: unknown[] = []
    const agent: AgentAppCalls = {
      call: async (id, call) => {
        reached.push(['call', id, call])
        return call.name === 'bad'
          ? { ok: false, error: 'bad failed: Error: nope' }
          : { ok: true, revision: 3, release: 'r_1', state: { n: 3 } }
      },
      state: async (id) => {
        reached.push(['state', id])
        return { revision: 5, release: 'r_1', state: { n: 5 } }
      },
      report: async (id, message) => {
        reached.push(['report', id, message])
      },
    }
    const launch = { kind: 'agent' as const, name: 'tapper', release: 'r_1', revision: 2, state: { n: 2 } }
    const offered: string[] = []
    const { bridge, push } = createAppBridge(
      { kind: 'agent', id: '7', launch: { ...launch, ui: { module: '', css: '', libs: [] } } },
      '',
      { displayMode: 'inline' },
      { agent, tool: notMcp, resource: notMcp },
      {
        ...events,
        offerDownload: (file) => offered.push(`${file.name} ${file.type} ${String(file.bytes.byteLength)}`),
      },
    )
    const app = new App({ name: 'Fixture', version: '1' }, {}, { autoResize: false })
    const states: unknown[] = []
    app.addEventListener('toolresult', (result) => states.push(result._meta?.['goblin/state']))
    const [host, client] = InMemoryTransport.createLinkedPair()
    await bridge.connect(host)
    await app.connect(client)
    try {
      await until(() => states.length === 1)
      expect(states[0]).toEqual({ revision: 2, release: 'r_1', state: { n: 2 } })
      const op = crypto.randomUUID()
      const answered = await app.callServerTool({
        name: 'tap',
        arguments: { by: 1 },
        _meta: { 'goblin/op': `ui:${op}` },
      })
      expect(answered._meta).toEqual({ 'goblin/state': { revision: 3, release: 'r_1', state: { n: 3 } } })
      expect(await app.callServerTool({ name: 'bad', arguments: {} })).toMatchObject({
        isError: true,
        content: [{ type: 'text', text: 'bad failed: Error: nope' }],
      })
      push?.want(3)
      push?.want(5)
      await until(() => states.length === 2)
      expect(states[1]).toEqual({ revision: 5, release: 'r_1', state: { n: 5 } })
      const file = { uri: 'file:///report.csv', mimeType: 'text/csv', text: 'a,b\n1,2\n' }
      expect(await app.downloadFile({ contents: [{ type: 'resource', resource: file }] })).not.toHaveProperty('isError')
      expect(offered).toEqual(['report.csv text/csv 8'])
      await app.sendLog({ level: 'error', data: 'TypeError: boom' })
      await until(() => reached.some((entry) => Array.isArray(entry) && entry[0] === 'report'))
      expect(reached[0]).toEqual(['call', '7', { name: 'tap', arguments: { by: 1 }, op }])
      expect(reached.filter((entry) => Array.isArray(entry) && entry[0] === 'state')).toHaveLength(1)
      expect(reached.at(-1)).toEqual(['report', '7', 'TypeError: boom'])
    } finally {
      await app.close()
      await bridge.close()
    }
  })
})
