import { createMcpHandler } from '@modelcontextprotocol/server'
import * as Effect from 'effect/Effect'
import { describe, expect, it } from 'vitest'
import { McpConnectionManager, encodedSize } from '../../src/mcp/connection.ts'
import { MemoryGrants } from './memory.ts'
import { Forbidden } from '../../src/http/errors.ts'
import type { McpStep } from '../../src/telemetry/report.ts'
import { lowLevelServer } from './low-level-server.ts'

const serverConfig = {
  serverId: 'fixture',
  endpoint: 'https://fixture.test/mcp',
  issuer: 'https://fixture.test/api/auth',
}
const grants = new MemoryGrants([
  { serverId: 'fixture', capability: 'tool', name: 'read' },
  { serverId: 'fixture', capability: 'resource', name: 'ui://fixture/view.html' },
])
type ResourceFixture = { readonly text?: string; readonly mimeType?: string; readonly returnedUri?: string }
const handler = (resourceTemplates = true, resource: ResourceFixture = {}) =>
  createMcpHandler(() => {
    const server = lowLevelServer({ name: 'fixture', version: '1.0.0' }, { capabilities: { tools: {}, resources: {} } })
    server.setRequestHandler('tools/list', () => ({
      tools: [
        {
          name: 'read',
          inputSchema: { type: 'object', properties: {} },
          _meta: { vendorFuture: { data: 'retained' }, ui: { resourceUri: 'ui://fixture/view.html' } },
        },
        { name: 'hidden', inputSchema: { type: 'object', properties: {} }, _meta: { ui: { visibility: ['app'] } } },
      ],
    }))
    server.setRequestHandler('tools/call', (request) => ({
      content: [{ type: 'text', text: request.params.name }],
      structuredContent: { safe: true },
      _meta: { vendorFuture: { revision: 1 } },
    }))
    server.setRequestHandler('resources/list', () => ({
      resources: [{ uri: 'ui://fixture/view.html', name: 'View', mimeType: 'text/html;profile=mcp-app' }],
    }))
    if (resourceTemplates) server.setRequestHandler('resources/templates/list', () => ({ resourceTemplates: [] }))
    server.setRequestHandler('resources/read', (request) => ({
      contents: [
        {
          uri: resource.returnedUri ?? request.params.uri,
          text: resource.text ?? '<!doctype html><title>Fixture</title>',
          mimeType: resource.mimeType ?? 'text/html;profile=mcp-app',
        },
      ],
    }))
    return server
  })
const makeManager = (
  maxResultBytes?: number,
  resourceTemplates = true,
  resource: ResourceFixture = {},
  maxAppResourceBytes?: number,
) => {
  const officialHandler = handler(resourceTemplates, resource)
  return new McpConnectionManager({
    servers: [serverConfig],
    allows: (grant) => grants.allows(grant),
    auth: () => ({ token: async () => 'fixture-token-never-exported' }),
    fetch: async (input, init) => officialHandler.fetch(new Request(input, init)),
    ...(maxResultBytes === undefined ? {} : { maxResultBytes }),
    ...(maxAppResourceBytes === undefined ? {} : { maxAppResourceBytes }),
  })
}

describe('official MCP SDK host interoperability (unit)', () => {
  it('keeps shared discovery separate from caller scopes and never sends correlation to the server', async () => {
    const official = handler()
    const reports: { step: McpStep; outcome: string }[] = []
    const one = { conversationId: 'local-conversation-one', taskId: 'local-task-one' }
    const two = { conversationId: 'local-conversation-two', taskId: 'local-task-two' }
    const manager = new McpConnectionManager({
      servers: [serverConfig],
      allows: (grant) => grants.allows(grant),
      auth: () => ({ token: async () => 'fixture' }),
      report: (step, outcome) => reports.push({ step, outcome }),
      fetch: async (input, init) => {
        const request = new Request(input, init)
        const body = await request.clone().text()
        const headers = JSON.stringify([...request.headers])
        for (const local of [...Object.values(one), ...Object.values(two)]) {
          expect(body).not.toContain(local)
          expect(headers).not.toContain(local)
        }
        return official.fetch(request)
      },
    })
    try {
      await Promise.all([
        manager.connect('fixture', { runContext: one }),
        manager.connect('fixture', { runContext: two }),
      ])
      const connected = reports.filter(({ step }) => step.step === 'connect')
      expect(connected).toHaveLength(3)
      expect(connected).toEqual(
        expect.arrayContaining([
          { step: { step: 'connect', serverId: 'fixture', sharedConnection: true }, outcome: 'ok' },
          { step: { step: 'connect', serverId: 'fixture', scope: one }, outcome: 'ok' },
          { step: { step: 'connect', serverId: 'fixture', scope: two }, outcome: 'ok' },
        ]),
      )
      await manager.callTool('fixture', 'read', {}, { runContext: two })
      await expect(manager.callTool('fixture', 'missing', {}, { runContext: one })).rejects.toMatchObject({
        _tag: 'GrantDenied',
      })
      expect(reports.filter(({ step }) => step.step === 'call')).toEqual([
        { step: { step: 'call', serverId: 'fixture', tool: 'read', scope: two }, outcome: 'ok' },
        { step: { step: 'call', serverId: 'fixture', tool: 'missing', scope: one }, outcome: 'GrantDenied' },
      ])
    } finally {
      await manager.closeAll()
    }
  })
  it('rechecks execution authority after SDK token refresh and keeps correlation headers local', async () => {
    const official = handler()
    let revoked = false
    let calls = 0
    const manager = new McpConnectionManager({
      servers: [serverConfig],
      allows: (grant) => grants.allows(grant),
      auth: () => ({
        token: async () => 'fixture',
        onUnauthorized: async () => {
          revoked = true
        },
      }),
      fetch: async (input, init) => {
        const request = new Request(input, init)
        expect(request.headers.has('x-goblin-local-dispatch')).toBe(false)
        if (request.method === 'POST') {
          const body: { method?: string } = await request.clone().json()
          if (body.method === 'tools/call') {
            calls += 1
            if (calls === 1) return new Response(null, { status: 401 })
          }
        }
        return official.fetch(request)
      },
    })
    try {
      await expect(
        manager.callTool(
          'fixture',
          'read',
          {},
          {
            authorize: Effect.suspend(() =>
              revoked ? Effect.fail(new Forbidden({ reason: 'execution revoked during refresh' })) : Effect.void,
            ),
          },
        ),
      ).rejects.toMatchObject({ _tag: 'Forbidden' })
      expect(calls).toBe(1)
    } finally {
      await manager.closeAll()
    }
  })
  it('connects a resource provider that rejects optional template discovery as not implemented', async () => {
    const manager = makeManager(undefined, false)
    try {
      const connected = await manager.connect('fixture')
      expect(connected.resources).toHaveLength(1)
      expect(connected.resourceTemplates).toEqual([])
      const resource = await manager.readResource('fixture', 'ui://fixture/view.html')
      expect(resource.contents[0]).toMatchObject({ mimeType: 'text/html;profile=mcp-app' })
    } finally {
      await manager.closeAll()
    }
  })
  it('negotiates and preserves structured content/_meta while filtering app-only tools', async () => {
    const manager = makeManager()
    try {
      const connected = await manager.connect('fixture')
      expect(connected.protocolEra).toBe('modern')
      expect(connected.protocolVersion).toBe('2026-07-28')
      expect(connected.tools[0]?._meta).toMatchObject({ vendorFuture: { data: 'retained' } })
      expect(manager.tools('fixture', 'model').map((tool) => tool.name)).toEqual(['read'])
      expect(manager.tools('fixture', 'app').map((tool) => tool.name)).toEqual(['read', 'hidden'])
      const result = await manager.callTool('fixture', 'read')
      expect(result.structuredContent).toEqual({ safe: true })
      expect(result._meta).toMatchObject({ vendorFuture: { revision: 1 } })
      const resource = await manager.readResource('fixture', 'ui://fixture/view.html')
      expect(resource.contents[0]).toMatchObject({ mimeType: 'text/html;profile=mcp-app' })
      expect(JSON.stringify(connected)).not.toContain('fixture-token-never-exported')
    } finally {
      await manager.closeAll()
    }
  })
  it('denies ungranted execution and reconnects through a new authoritative handshake', async () => {
    const manager = makeManager()
    try {
      await expect(manager.callTool('fixture', 'missing')).rejects.toMatchObject({ _tag: 'GrantDenied' })
      const first = await manager.connect('fixture')
      expect(await manager.connect('fixture')).toBe(first)
      const second = await manager.reconnect('fixture')
      expect(second).not.toBe(first)
      expect(second.tools).toEqual(first.tools)
      expect(second.protocolVersion).toBe(first.protocolVersion)
    } finally {
      await manager.closeAll()
    }
  })
  it('rejects oversized discovery without returning a partial snapshot', async () => {
    const manager = makeManager(32)
    try {
      await expect(manager.connect('fixture')).rejects.toMatchObject({ _tag: 'UpstreamMcp', reason: 'content-limit' })
      expect(manager.snapshot('fixture')).toBeUndefined()
    } finally {
      await manager.closeAll()
    }
  })
  it('allows a granted HTML App bundle above the ordinary resource limit without relaxing ordinary reads', async () => {
    const html = '<!doctype html>' + 'x'.repeat(1_048_576)
    const manager = makeManager(undefined, true, { text: html })
    try {
      await expect(manager.readResource('fixture', 'ui://fixture/view.html')).rejects.toMatchObject({
        reason: 'content-limit',
      })
      const app = await manager.readAppResource('fixture', 'ui://fixture/view.html')
      expect(app.contents[0]).toMatchObject({ uri: 'ui://fixture/view.html', text: html })
      await expect(manager.readResource('fixture', 'ui://fixture/view.html')).rejects.toMatchObject({
        reason: 'content-limit',
      })
    } finally {
      await manager.closeAll()
    }
  })
  it('enforces the separate App byte bound on UTF-8 HTML', async () => {
    const manager = makeManager(undefined, true, { text: 'é'.repeat(1024) }, 2048)
    try {
      await expect(manager.readAppResource('fixture', 'ui://fixture/view.html')).rejects.toMatchObject({
        reason: 'content-limit',
      })
    } finally {
      await manager.closeAll()
    }
  })
  it('rejects non-HTML App results and responses for a different resource', async () => {
    const nonHtml = makeManager(undefined, true, { mimeType: 'application/json' })
    const wrongUri = makeManager(undefined, true, { returnedUri: 'ui://other/view.html' })
    try {
      await expect(nonHtml.readAppResource('fixture', 'ui://fixture/view.html')).rejects.toMatchObject({
        reason: 'unsupported',
      })
      await expect(wrongUri.readAppResource('fixture', 'ui://fixture/view.html')).rejects.toMatchObject({
        reason: 'unsupported',
      })
    } finally {
      await Promise.all([nonHtml.closeAll(), wrongUri.closeAll()])
    }
  })
  it('retains ui URI and exact resource grant requirements for App reads', async () => {
    const manager = makeManager()
    try {
      await expect(manager.readAppResource('fixture', 'ui://fixture/ungranted.html')).rejects.toMatchObject({
        _tag: 'GrantDenied',
      })
      await expect(manager.readAppResource('fixture', 'https://fixture.test/view.html')).rejects.toMatchObject({
        reason: 'unsupported',
      })
      expect(manager.snapshot('fixture')).toBeUndefined()
    } finally {
      await manager.closeAll()
    }
  })
})

describe('the size of a result as the host carries it (unit)', () => {
  it('counts UTF-8 bytes of the JSON, and tells a value JSON cannot hold from one that is merely large', () => {
    expect(encodedSize({ text: 'é' })).toBe(new TextEncoder().encode('{"text":"é"}').byteLength)
    expect(encodedSize(undefined)).toBe(0)
    const cycle: Record<string, unknown> = {}
    cycle['self'] = cycle
    expect(encodedSize(cycle)).toBeUndefined()
    expect(encodedSize({ amount: 1n })).toBeUndefined()
  })
})
