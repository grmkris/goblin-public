import { MessageReceipt } from '@goblin/contracts'
import * as Schema from 'effect/Schema'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { URL as FileURL } from 'node:url'
import { expect } from 'vitest'
import { Listed, Ok, Refused } from './conversation-checks.ts'
import { type NativeCase, type Phase, freshName, nativeFetch, probeCase, probeOf } from './native-case.ts'

const Table = Schema.Struct({ name: Schema.String, definition: Schema.NullOr(Schema.String) })
const Startup = Schema.Struct({
  snapshot: Schema.Unknown,
  before: Schema.Array(Table),
  after: Schema.Array(Table),
  metadata: Schema.String,
})

const Status = Schema.Struct({ state: Schema.String })
const OwnerApiRun = Schema.Struct({
  first: Ok(Status),
  revoked: Ok(Status),
  afterOwnerRequest: Ok(Status),
  enabled: Ok(Status),
  servers: Ok(Schema.Array(Schema.Unknown)),
  unknownServer: Refused,
  unknownApp: Refused,
  noConversation: Ok(Schema.Array(Schema.Unknown)),
  threads: Schema.Array(Listed),
  badBranch: Refused,
  unknownThread: Refused,
  closed: Ok(Listed),
  mainUntouchable: Refused,
  usage: Ok(Schema.Struct({ used: Schema.Number, limit: Schema.Number, resetsAt: Schema.Number })),
  model: Ok(Schema.Struct({ current: Schema.String, default: Schema.String, options: Schema.Array(Schema.Unknown) })),
  unknownModel: Refused,
  askWhileRevoked: Refused,
})

/** The owner API through a real stub, then Events ingress on another agent. */
async function ownerApiChecks(base: string): Promise<void> {
  const result = await probeOf(base, 'owner-api', OwnerApiRun)
  const states = [result.first, result.revoked, result.afterOwnerRequest, result.enabled].map(({ value }) => value)
  expect(states.map(({ state }) => state)).toEqual(['active', 'revoked', 'revoked', 'active'])
  expect(result.servers.value).toEqual([])
  expect([result.unknownServer.error._tag, result.unknownApp.error._tag]).toEqual(['NotFound', 'NotFound'])
  expect(result.noConversation.value).toEqual([])
  // Main is registered on first use; an empty thread joins it. Only registered conversations reach Pi.
  expect(result.threads.map(({ kind, closedAt }) => ({ kind, closed: closedAt !== undefined }))).toEqual([
    { kind: 'main', closed: false },
    { kind: 'thread', closed: false },
  ])
  expect(result.badBranch.error._tag).toBe('InvalidInput')
  expect(result.unknownThread.error._tag).toBe('NotFound')
  expect(result.closed.value).toMatchObject({ closedBy: 'owner', closedAt: expect.any(Number) })
  expect(result.mainUntouchable.error._tag).toBe('InvalidInput')
  // A fresh agent has spent nothing today; the budget table exists after migration.
  expect(result.usage.value).toMatchObject({ used: 0, limit: 300_000 })
  expect(result.usage.value.resetsAt % 86_400).toBe(0)
  // No pick yet: the deployment default; a model the deployment does not offer is refused (app_model_choice exists).
  expect(result.model.value).toMatchObject({ current: 'storage-only', default: 'storage-only' })
  expect(result.unknownModel.error._tag).toBe('InvalidInput')
  expect(result.askWhileRevoked.error._tag).toBe('ResidentInactive')
  // Events ingress: a transient failure of its authority check answers 503; the owner's refusal 410.
  expect(await probeOf(base, 'events-ingress', Schema.Unknown)).toEqual({ transient: 503, revoked: 410 })
}

const Stored = Schema.Struct({ credentials: Schema.Number, grants: Schema.Number, pending: Schema.Number })
const Binding = Schema.Struct({
  first: Schema.Array(Schema.String),
  same: Schema.Array(Schema.String),
  kept: Stored,
  moved: Schema.Array(Schema.String),
  after: Stored,
  bound: Schema.Array(Schema.Struct({ serverId: Schema.String, endpoint: Schema.String, boundAt: Schema.Number })),
  removed: Schema.Struct({
    listed: Schema.Array(Schema.String),
    left: Schema.Number,
    after: Stored,
    bound: Schema.Number,
  }),
})

const Destroy = Schema.Struct({
  submitted: Schema.Struct({ ok: Schema.Literal(true) }),
  before: Schema.Number,
  deleted: Schema.Unknown,
  after: Schema.Number,
  resident: Ok(Status),
})

const Operation = Schema.Struct({
  operationId: Schema.String,
  session: Schema.String,
  status: Schema.Literals(['done', 'unanswered']),
  text: Schema.optional(Schema.String),
})
const LifecycleRead = Schema.Struct({ instance: Schema.String, messages: Schema.Array(Schema.Unknown) })
const Reopen = Schema.Struct({ replacedPiInstance: Schema.Boolean, messages: Schema.Array(Schema.Unknown) })
const Sessions = Schema.Struct({ sessions: Schema.Array(Schema.Struct({ id: Schema.String, busy: Schema.Boolean })) })
const Evidence = Schema.Struct({
  name: Schema.String,
  operationId: Schema.String,
  instance: Schema.String,
  testProcess: Schema.Number,
  messages: Schema.Array(Schema.Unknown),
})

const lifecycleEvidencePath = new FileURL('../../.alchemy/goblin-native-lifecycle.json', import.meta.url)

/** The lifecycle object `name`'s steps, each under operation `operationId`. */
const lifecycle =
  (base: string, name: string, operationId: string) =>
  <A>(step: string, schema: Schema.Decoder<A>) =>
    probeOf(base, `lifecycle-${step}`, schema, name, { operationId })

/** Native Pi submit, receipt retry, durable readback and public dispose/reopen; `write` keeps the evidence. */
async function lifecycleChecks(base: string, phase: Phase): Promise<void> {
  const name = freshName('lifecycle')
  const operationId = crypto.randomUUID()
  const get = lifecycle(base, name, operationId)
  expect(await get('sessions', Sessions)).toEqual({ sessions: [{ id: '1', busy: false }] })
  expect(await get('submit', MessageReceipt)).toEqual({ operationId, session: '1', accepted: true })
  expect(await get('submit', MessageReceipt)).toEqual({ operationId, session: '1', accepted: false })
  const result = await get('wait', Operation)
  expect(result).toMatchObject({
    operationId,
    session: '1',
    status: 'done',
    text: 'echo: persist this lifecycle fixture input',
  })
  const read = await get('read', LifecycleRead)
  expect(read.messages).toHaveLength(2)
  expect(read.messages).toMatchObject([
    { kind: 'pi.user', model: [{ role: 'user', content: 'persist this lifecycle fixture input' }] },
    {
      kind: 'pi.assistant',
      model: [{ role: 'assistant', content: [{ type: 'text', text: 'echo: persist this lifecycle fixture input' }] }],
    },
  ])
  const reopened = await get('reopen', Reopen)
  expect(reopened.replacedPiInstance).toBe(true)
  expect(reopened.messages).toEqual(read.messages)
  expect(await get('submit', MessageReceipt)).toEqual({ operationId, session: '1', accepted: false })
  expect(await get('wait', Operation)).toEqual(result)
  expect((await get('read', LifecycleRead)).messages).toEqual(read.messages)
  if (phase !== 'write') return
  mkdirSync(new FileURL('./', lifecycleEvidencePath), { recursive: true })
  const evidence = { name, operationId, instance: read.instance, testProcess: process.pid, messages: read.messages }
  writeFileSync(lifecycleEvidencePath, JSON.stringify(evidence, null, 2))
}

/** Two explicit Vitest processes prove local storage reconstruction, independently of remote eviction. */
async function reconstructionChecks(base: string): Promise<void> {
  const evidence = Schema.decodeUnknownSync(Evidence)(JSON.parse(readFileSync(lifecycleEvidencePath, 'utf8')))
  expect(process.pid).not.toBe(evidence.testProcess)
  const get = lifecycle(base, evidence.name, evidence.operationId)
  const fresh = await get('read', LifecycleRead)
  expect(fresh.instance).not.toBe(evidence.instance)
  expect(fresh.messages).toEqual(evidence.messages)
  expect(await get('submit', MessageReceipt)).toEqual({
    operationId: evidence.operationId,
    session: '1',
    accepted: false,
  })
  expect((await get('read', LifecycleRead)).messages).toEqual(evidence.messages)
  const receipt = {
    environment: 'local-workerd-process-reconstruction',
    previousInstance: evidence.instance,
    reconstructedInstance: fresh.instance,
    previousTestProcess: evidence.testProcess,
    testProcess: process.pid,
    sameTranscript: true,
  }
  writeFileSync(
    new FileURL('../../.alchemy/goblin-native-reconstruction.json', import.meta.url),
    JSON.stringify(receipt, null, 2),
  )
}

/** Canonical host redirects keep the method, path and query. */
async function canonicalChecks(base: string): Promise<void> {
  for (const method of ['GET', 'HEAD', 'POST']) {
    const response = await nativeFetch(`${base}/canonical/path?q=a%2Fb`, {
      method,
      redirect: 'manual',
      ...(method === 'POST' ? { body: 'keep this body' } : {}),
    })
    expect(response.status).toBe(method === 'POST' ? 308 : 301)
    expect(response.headers.get('location')).toBe('https://goblin.surf/canonical/path?q=a%2Fb')
  }
}

/** The inbound MCP endpoint takes the custom domain's Origin and refuses a foreign one. */
async function inboundHostChecks(base: string): Promise<void> {
  const send = (origin: string) =>
    nativeFetch(`${base}/inbound-host`, {
      method: 'POST',
      headers: {
        origin,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-06-18',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
  const valid = await send('https://dev.goblin.surf')
  expect(valid.status).toBe(200)
  expect(await valid.text()).toContain('ask_agent')
  expect((await send('https://attacker.example')).status).toBe(403)
}

/** The agent itself: its start, its owner API by stub, endpoint binding, deletion, the Pi lifecycle and the edges. */
export const agentCases = (phase: Phase): readonly NativeCase[] => [
  probeCase(
    'actual PersonalAgent startup and additive app migration preserve vendor schemas',
    'startup',
    Startup,
    (result) => {
      expect(result.snapshot).toMatchObject({ type: 'snapshot', entries: [] })
      expect(result.metadata).toBe('stored-updated')
      expect(result.after).toEqual(result.before)
      expect(JSON.stringify(result.after)).toContain('app_metadata')
      expect(JSON.stringify(result.after)).toContain('pi_submissions')
      expect(JSON.stringify(result.after)).toContain('cf_agents_jobs')
    },
  ),
  {
    title:
      'owner RPC renews resident authority, gates threads, revocation blocks client asks, and Events ingress [canary]',
    run: ownerApiChecks,
  },
  probeCase(
    're-pointing a server drops the credentials, grants and pending state made for its old endpoint',
    'binding',
    Binding,
    (result) => {
      expect(result.first).toEqual([])
      expect(result.same).toEqual([])
      expect(result.kept).toEqual({ credentials: 1, grants: 1, pending: 1 })
      expect(result.moved).toEqual(['notes'])
      expect(result.after).toEqual({ credentials: 0, grants: 0, pending: 0 })
      expect(result.bound).toEqual([{ serverId: 'notes', endpoint: 'https://b.test/mcp', boundAt: 3 }])
      expect(result.removed).toEqual({
        listed: ['extra'],
        left: 0,
        after: { credentials: 0, grants: 0, pending: 0 },
        bound: 1,
      })
    },
  ),
  probeCase('deleting an agent erases its conversation and application state', 'destroy', Destroy, (result) => {
    expect(result.before).toBeGreaterThan(0)
    // Either the result or the isolate abort that `Agent.destroy()` causes; nothing else is acceptable.
    expect(JSON.stringify(result.deleted)).toMatch(/"ok":true|destroyed/u)
    expect(result.after).toBe(0)
    // The revocation row was erased too: the owner request after deletion starts a fresh, active authority.
    expect(result.resident.value.state).toBe('active')
  }),
  {
    title: 'native Pi submit, receipt retry, durable readback and public dispose/reopen [canary]',
    run: (base) => lifecycleChecks(base, phase),
  },
  ...(phase === 'read'
    ? [
        {
          title: 'fresh Agent reads the persisted native Pi transcript',
          secondProcess: true,
          run: reconstructionChecks,
        } as const,
      ]
    : []),
  { title: 'canonical host redirects preserve methods, path and query', run: canonicalChecks },
  { title: 'MCP custom-domain Origin passes and foreign Origin is refused', run: inboundHostChecks },
]
