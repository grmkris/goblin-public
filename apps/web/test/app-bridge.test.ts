import { describe, expect, it } from 'vitest'
import { InMemoryTransport } from '@modelcontextprotocol/client'
import { App } from '@modelcontextprotocol/ext-apps'
import { createAppBridge, type AppCalls } from '../src/lib/app-bridge.ts'
import type { FrameEvents } from '../src/components/apps/frame.tsx'

const events: FrameEvents = {
  report: () => undefined,
  resize: () => undefined,
  close: () => undefined,
  requestMode: (mode) => mode,
  share: () => undefined,
  offerLink: () => undefined,
  askGrant: async () => false,
}
async function pair(serverId: string, calls: AppCalls) {
  const bridge = createAppBridge(
    { serverId, uri: `ui://${serverId}/app`, arguments: {}, result: { content: [] } },
    '',
    { displayMode: 'inline' },
    calls,
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
    const calls: AppCalls = {
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
    const calls: AppCalls = {
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
      for (const displayMode of ['fullscreen', 'inline'] as const) {
        first.bridge.setHostContext({ displayMode, containerDimensions: { width: 400, maxHeight: 600 } })
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
    expect(reached).toEqual(['notes:read', 'notes:data://value', 'notes:data://value', 'other:read'])
  })
})
