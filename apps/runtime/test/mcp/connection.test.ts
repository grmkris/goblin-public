import { createMcpHandler } from '@modelcontextprotocol/server'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as TestClock from 'effect/testing/TestClock'
import { describe, expect, it } from 'vitest'
import { makeManager as nativeManager } from '../../src/mcp/manager.ts'
import { McpConnections } from '../../src/mcp/service.ts'
import { SingleFlight } from '../../src/observability/single-flight.ts'
import { servicesOf } from './runtime.ts'
import { encodedSize, toolOffered } from '../../src/mcp/remote.ts'
import { managerOf } from './manager.ts'
import { MemoryGrants } from './memory.ts'
import { Forbidden } from '../../src/http/errors.ts'
import type { McpStep } from '../../src/telemetry/report.ts'
import { lowLevelServer } from './low-level-server.ts'

const serverConfig = {
  connectionId: 'fixture',
  endpoint: 'https://fixture.test/mcp',
  issuer: 'https://fixture.test/api/auth',
}
const grants = new MemoryGrants([
  { connectionId: 'fixture', capability: 'tool', name: 'read' },
  { connectionId: 'fixture', capability: 'resource', name: 'ui://fixture/view.html' },
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
  return managerOf({
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
    const manager = managerOf({
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
        manager.connections.connect('fixture', { runContext: one }),
        manager.connections.connect('fixture', { runContext: two }),
      ])
      const connected = reports.filter(({ step }) => step.step === 'connect')
      expect(connected).toHaveLength(3)
      expect(connected).toEqual(
        expect.arrayContaining([
          { step: { step: 'connect', connectionId: 'fixture', sharedConnection: true }, outcome: 'ok' },
          { step: { step: 'connect', connectionId: 'fixture', scope: one }, outcome: 'ok' },
          { step: { step: 'connect', connectionId: 'fixture', scope: two }, outcome: 'ok' },
        ]),
      )
      await manager.connections.callTool('fixture', 'read', {}, { runContext: two })
      await expect(manager.connections.callTool('fixture', 'missing', {}, { runContext: one })).rejects.toMatchObject({
        _tag: 'GrantDenied',
      })
      expect(reports.filter(({ step }) => step.step === 'call')).toEqual([
        { step: { step: 'call', connectionId: 'fixture', tool: 'read', scope: two }, outcome: 'ok' },
        { step: { step: 'call', connectionId: 'fixture', tool: 'missing', scope: one }, outcome: 'GrantDenied' },
      ])
    } finally {
      await manager.dispose()
    }
  })
  it('rechecks execution authority after SDK token refresh and keeps correlation headers local', async () => {
    const official = handler()
    let revoked = false
    let calls = 0
    const manager = managerOf({
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
        manager.connections.callTool(
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
      await manager.dispose()
    }
  })
  it('connects a resource provider that rejects optional template discovery as not implemented', async () => {
    const manager = makeManager(undefined, false)
    try {
      const connected = await manager.connections.connect('fixture')
      expect(connected.resources).toHaveLength(1)
      expect(connected.resourceTemplates).toEqual([])
      const resource = await manager.connections.readResource('fixture', 'ui://fixture/view.html', 'human')
      expect(resource.contents[0]).toMatchObject({ mimeType: 'text/html;profile=mcp-app' })
    } finally {
      await manager.dispose()
    }
  })
  it('negotiates and preserves structured content/_meta while filtering app-only tools', async () => {
    const manager = makeManager()
    try {
      const connected = await manager.connections.connect('fixture')
      expect(connected.protocolEra).toBe('modern')
      expect(connected.protocolVersion).toBe('2026-07-28')
      expect(connected.tools[0]?._meta).toMatchObject({ vendorFuture: { data: 'retained' } })
      const offered = (caller: 'model' | 'app') => connected.tools.filter((tool) => toolOffered(tool, caller))
      expect(offered('model').map((tool) => tool.name)).toEqual(['read'])
      expect(offered('app').map((tool) => tool.name)).toEqual(['read', 'hidden'])
      const result = await manager.connections.callTool('fixture', 'read', {})
      expect(result.structuredContent).toEqual({ safe: true })
      expect(result._meta).toMatchObject({ vendorFuture: { revision: 1 } })
      const resource = await manager.connections.readResource('fixture', 'ui://fixture/view.html', 'human')
      expect(resource.contents[0]).toMatchObject({ mimeType: 'text/html;profile=mcp-app' })
      expect(JSON.stringify(connected)).not.toContain('fixture-token-never-exported')
    } finally {
      await manager.dispose()
    }
  })
  it('denies ungranted execution and reconnects through a new authoritative handshake', async () => {
    const manager = makeManager()
    try {
      await expect(manager.connections.callTool('fixture', 'missing', {})).rejects.toMatchObject({
        _tag: 'GrantDenied',
      })
      const first = await manager.connections.connect('fixture')
      expect(await manager.connections.connect('fixture')).toBe(first)
      const second = await manager.connections.reconnect('fixture')
      expect(second).not.toBe(first)
      expect(second.tools).toEqual(first.tools)
      expect(second.protocolVersion).toBe(first.protocolVersion)
    } finally {
      await manager.dispose()
    }
  })
  it('answers a 403 insufficient_scope as ScopeRequired with the scope tokens, and keeps the connection open', async () => {
    const official = handler()
    const manager = managerOf({
      servers: [serverConfig],
      allows: (grant) => grants.allows(grant),
      auth: () => ({ token: async () => 'fixture-token' }),
      fetch: async (input, init) => {
        const request = new Request(input, init)
        if (request.method === 'POST' && (await request.clone().text()).includes('"method":"tools/call"'))
          return new Response(null, {
            status: 403,
            headers: {
              'www-authenticate': 'Bearer error="insufficient_scope", scope="fixture:read fixture:write \\bad\\"',
            },
          })
        return official.fetch(request)
      },
    })
    try {
      const opened = await manager.connections.connect('fixture')
      await expect(manager.connections.callTool('fixture', 'read', {})).rejects.toMatchObject({
        _tag: 'ScopeRequired',
        connectionId: 'fixture',
        scope: 'fixture:read fixture:write',
      })
      expect(await manager.connections.snapshot('fixture')).toEqual(Option.some(opened))
    } finally {
      await manager.dispose()
    }
  })
  it('rejects oversized discovery without returning a partial snapshot', async () => {
    const manager = makeManager(32)
    try {
      await expect(manager.connections.connect('fixture')).rejects.toMatchObject({
        _tag: 'UpstreamMcp',
        reason: 'content-limit',
      })
      expect(await manager.connections.snapshot('fixture')).toEqual(Option.none())
    } finally {
      await manager.dispose()
    }
  })
  it('allows a granted HTML App bundle above the ordinary resource limit without relaxing ordinary reads', async () => {
    const html = '<!doctype html>' + 'x'.repeat(1_048_576)
    const manager = makeManager(undefined, true, { text: html })
    try {
      await expect(
        manager.connections.readResource('fixture', 'ui://fixture/view.html', 'human'),
      ).rejects.toMatchObject({
        reason: 'content-limit',
      })
      const app = await manager.connections.readResource('fixture', 'ui://fixture/view.html', 'app')
      expect(app.contents[0]).toMatchObject({ uri: 'ui://fixture/view.html', text: html })
      await expect(
        manager.connections.readResource('fixture', 'ui://fixture/view.html', 'human'),
      ).rejects.toMatchObject({
        reason: 'content-limit',
      })
    } finally {
      await manager.dispose()
    }
  })
  it('enforces the separate App byte bound on UTF-8 HTML', async () => {
    const manager = makeManager(undefined, true, { text: 'é'.repeat(1024) }, 2048)
    try {
      await expect(manager.connections.readResource('fixture', 'ui://fixture/view.html', 'app')).rejects.toMatchObject({
        reason: 'content-limit',
      })
    } finally {
      await manager.dispose()
    }
  })
  it('rejects non-HTML App results and responses for a different resource', async () => {
    const nonHtml = makeManager(undefined, true, { mimeType: 'application/json' })
    const wrongUri = makeManager(undefined, true, { returnedUri: 'ui://other/view.html' })
    try {
      await expect(nonHtml.connections.readResource('fixture', 'ui://fixture/view.html', 'app')).rejects.toMatchObject({
        reason: 'unsupported',
      })
      await expect(wrongUri.connections.readResource('fixture', 'ui://fixture/view.html', 'app')).rejects.toMatchObject(
        {
          reason: 'unsupported',
        },
      )
    } finally {
      await Promise.all([nonHtml.dispose(), wrongUri.dispose()])
    }
  })
  it('retains ui URI and exact resource grant requirements for App reads', async () => {
    const manager = makeManager()
    try {
      await expect(
        manager.connections.readResource('fixture', 'ui://fixture/ungranted.html', 'app'),
      ).rejects.toMatchObject({
        _tag: 'GrantDenied',
      })
      await expect(
        manager.connections.readResource('fixture', 'https://fixture.test/view.html', 'app'),
      ).rejects.toMatchObject({
        reason: 'unsupported',
      })
      expect(await manager.connections.snapshot('fixture')).toEqual(Option.none())
    } finally {
      await manager.dispose()
    }
  })
})

describe('the connection manager as a service (unit)', () => {
  /** A manager on a test clock whose connections close after 1 s unused; `opened` counts the handshakes. */
  const idleManager = () => {
    const official = handler()
    const counts = { opened: 0 }
    const services = servicesOf(
      Layer.effect(
        McpConnections,
        Effect.orDie(
          nativeManager({
            servers: [serverConfig],
            allows: (grant) => grants.allows(grant),
            auth: () => ({ token: async () => 'fixture' }),
            idleMs: 1000,
            fetch: async (input, init) => {
              const request = new Request(input, init)
              const body = request.method === 'POST' ? await request.clone().text() : ''
              if (/"method":"(?:server\/discover|initialize)"/u.test(body)) counts.opened += 1
              return official.fetch(request)
            },
          }),
        ),
      ).pipe(Layer.provide(SingleFlight.layer), Layer.provideMerge(TestClock.layer())),
    )
    return { ...services, counts }
  }

  it('opens one connection for callers that connect at once', async () => {
    const { run, dispose, counts } = idleManager()
    try {
      const connections = await run(McpConnections)
      const snapshots = await run(
        Effect.all([connections.connect('fixture'), connections.connect('fixture'), connections.connect('fixture')], {
          concurrency: 'unbounded',
        }),
      )
      expect(counts.opened).toBe(1)
      expect(new Set(snapshots).size).toBe(1)
    } finally {
      await dispose()
    }
  })

  it('closes a connection once it has gone unused for its idle time, and each use restarts that time', async () => {
    const { run, dispose, counts } = idleManager()
    try {
      const connections = await run(McpConnections)
      await run(connections.connect('fixture'))
      await run(TestClock.adjust(900))
      await run(connections.connect('fixture'))
      await run(TestClock.adjust(900))
      expect(Option.isSome(await run(connections.snapshot('fixture')))).toBe(true)
      await run(TestClock.adjust(100))
      expect(await run(connections.snapshot('fixture'))).toEqual(Option.none())
      await run(connections.connect('fixture'))
      expect(counts.opened).toBe(2)
    } finally {
      await dispose()
    }
  })

  it('closes every connection when the layer ends', async () => {
    const { run, dispose } = idleManager()
    const connections = await run(McpConnections)
    await run(connections.connect('fixture'))
    await dispose()
    await expect(run(connections.snapshot('fixture'))).rejects.toBeDefined()
  })
})

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('a slow tool call (unit)', () => {
  const slowGrants = new MemoryGrants([{ connectionId: 'fixture', capability: 'tool', name: 'slow' }])
  /** A server whose one tool answers after `answerMs`, sending progress every `progressMs` when asked for it. */
  const slowServer = (answerMs: number, progressMs?: number) =>
    createMcpHandler(() => {
      const server = lowLevelServer({ name: 'slow', version: '1.0.0' }, { capabilities: { tools: {} } })
      server.setRequestHandler('tools/list', () => ({
        tools: [{ name: 'slow', inputSchema: { type: 'object', properties: {} } }],
      }))
      server.setRequestHandler('tools/call', async (_request, ctx) => {
        const token = ctx.mcpReq._meta?.progressToken
        const started = Date.now()
        let progress = 0
        while (Date.now() - started < answerMs && !ctx.mcpReq.signal.aborted) {
          await pause(progressMs ?? answerMs)
          progress += 1
          if (progressMs !== undefined && token !== undefined)
            await ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken: token, progress } })
        }
        return { content: [{ type: 'text', text: 'done' }] }
      })
      return server
    })
  const slowManager = (
    answerMs: number,
    progressMs?: number,
    deadlines = { toolTimeoutMs: 80, toolDeadlineMs: 400 },
  ) => {
    const official = slowServer(answerMs, progressMs)
    return managerOf({
      servers: [serverConfig],
      allows: (grant) => slowGrants.allows(grant),
      auth: () => ({ token: async () => 'fixture' }),
      fetch: async (input, init) => official.fetch(new Request(input, init)),
      ...deadlines,
    })
  }

  it('answers a missed deadline as a timeout and keeps the connection until a second one in a row', async () => {
    const manager = slowManager(300)
    try {
      const opened = await manager.connections.connect('fixture')
      await expect(manager.connections.callTool('fixture', 'slow', {})).rejects.toMatchObject({
        _tag: 'UpstreamMcp',
        reason: 'timeout',
      })
      expect(await manager.connections.snapshot('fixture')).toEqual(Option.some(opened))
      await expect(manager.connections.callTool('fixture', 'slow', {})).rejects.toMatchObject({ reason: 'timeout' })
      expect(await manager.connections.snapshot('fixture')).toEqual(Option.none())
    } finally {
      await manager.dispose()
    }
  })

  it('lets a server that reports progress run past the deadline of one wait', async () => {
    const manager = slowManager(240, 40)
    try {
      const result = await manager.connections.callTool('fixture', 'slow', {})
      expect(result.content).toEqual([{ type: 'text', text: 'done' }])
    } finally {
      await manager.dispose()
    }
  })

  it('ends a call that keeps reporting progress at its deadline in all', async () => {
    const manager = slowManager(5000, 30, { toolTimeoutMs: 80, toolDeadlineMs: 200 })
    try {
      const started = Date.now()
      await expect(manager.connections.callTool('fixture', 'slow', {})).rejects.toMatchObject({ reason: 'timeout' })
      expect(Date.now() - started).toBeLessThan(2000)
    } finally {
      await manager.dispose()
    }
  })

  it('never closes a connection for being idle while a call on it is under way', async () => {
    const official = slowServer(250)
    const manager = managerOf({
      servers: [serverConfig],
      allows: (grant) => slowGrants.allows(grant),
      auth: () => ({ token: async () => 'fixture' }),
      fetch: async (input, init) => official.fetch(new Request(input, init)),
      idleMs: 60,
    })
    try {
      const result = await manager.connections.callTool('fixture', 'slow', {})
      expect(result.content).toEqual([{ type: 'text', text: 'done' }])
      expect(Option.isSome(await manager.connections.snapshot('fixture'))).toBe(true)
    } finally {
      await manager.dispose()
    }
  })

  it('answers a caller who stops waiting as cancelled, not as a timeout, and keeps the connection', async () => {
    const manager = slowManager(300)
    try {
      const opened = await manager.connections.connect('fixture')
      const stop = new AbortController()
      setTimeout(() => stop.abort(), 20)
      await expect(manager.connections.callTool('fixture', 'slow', {}, { signal: stop.signal })).rejects.toMatchObject({
        _tag: 'UpstreamMcp',
        reason: 'cancelled',
      })
      expect(await manager.connections.snapshot('fixture')).toEqual(Option.some(opened))
    } finally {
      await manager.dispose()
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
