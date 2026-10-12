import type { McpOutcome } from '@goblin/contracts'
import type { FlowEvent } from '@goblin/contracts/telemetry'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import { afterEach, describe, expect, it } from 'vitest'
import { ChatId } from '../../src/chats/directory.ts'
import { Chats, Conversations } from '../../src/chats/service.ts'
import type { AppError } from '../../src/http/errors.ts'
import type { AgentServices } from '../../src/layers/index.ts'
import { approvalsOver, urlRequestsOver } from '../../src/layers/mcp.ts'
import { McpApprovalStore } from '../../src/mcp/approvals.ts'
import { CredentialCipher } from '../../src/mcp/cipher.ts'
import { mcpHost } from '../../src/mcp/host.ts'
import { Approvals, McpConnections, Resident, UrlRequests } from '../../src/mcp/service.ts'
import { answerUrlRequest, holdUrlRequest, urlRequestView } from '../../src/mcp/url-request.ts'
import { McpUrlRequestStore } from '../../src/mcp/url-requests.ts'
import { FlowEvents } from '../../src/observability/flows.ts'
import { SingleFlight } from '../../src/observability/single-flight.ts'
import { RoutineRuns } from '../../src/routines/service.ts'
import { Changes, makeChanges } from '../../src/runtime/changes.ts'
import { scopeOf } from '../../src/setup/scope.ts'
import { Setups } from '../../src/setup/service.ts'
import { chatDatabase, durable } from '../chats-sqlite.ts'
import { plans, stub } from '../http/api/fixture.ts'
import { MemoryCredentials, MemoryGrants, MemoryLabels, MemoryRegistries } from './memory.ts'
import { APPROVE, SIDEQUEST, sidequestServer } from './sidequest-fixture.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const close of cleanups.splice(0)) close()
})

/** What the turn that asked was told, by operation id: goblin's words, the outcome block, and whom it is from. */
type Told = {
  readonly session: string
  readonly text: string
  readonly outcome: McpOutcome
  readonly from: string
  readonly operationId: string
}

/**
 * The URL request flow over the Sidequest-like server (ADR 0042): a real MCP host and URL request store, chat 41's
 * conversation acting and allowed everything, no routine run. `told` records what goes back to the turn that asked.
 */
const fixture = async () => {
  const server = sidequestServer()
  /** The flow steps recorded, ids and states only (ADR 0024). */
  const flows: FlowEvent[] = []
  const { db, close } = chatDatabase()
  cleanups.push(close)
  const cipher = await CredentialCipher.fromBase64(btoa(String.fromCharCode(...new Uint8Array(32))))
  const store = new McpUrlRequestStore(durable(db), cipher)
  const credentials = new MemoryCredentials()
  await credentials.saveTokens('sq', { access_token: 'fixture', token_type: 'bearer' }, 0)
  const host = mcpHost({
    servers: [{ ...SIDEQUEST, label: 'Sidequest · Worker' }],
    credentials,
    grants: new MemoryGrants([{ connectionId: 'sq', capability: 'tool', name: 'create_agent' }]),
    registries: new MemoryRegistries(),
    labels: new MemoryLabels(),
    appUrl: 'https://goblin.test',
    fetch: server.fetch,
  })
  const layer = host.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        SingleFlight.layer,
        FlowEvents.layerWith((event) => Effect.sync(() => void flows.push(event))),
        Layer.succeed(UrlRequests, urlRequestsOver(store)),
        Layer.succeed(Approvals, approvalsOver(new McpApprovalStore(durable(db), cipher))),
        Layer.succeed(Changes, makeChanges()),
        stub(Resident, { require: () => Effect.void }),
        stub(RoutineRuns, { session: () => Effect.succeed(undefined) }),
        stub(Chats, { chatOf: () => Effect.succeed(Option.some(ChatId('41'))) }),
        stub(Conversations, { requireActing: (chat) => Effect.succeed(chat), kindOf: () => Effect.succeed('main') }),
        stub(Setups, { scope: () => Effect.succeed(scopeOf([], true)) }),
        plans(),
      ),
    ),
  )
  const run = <A>(program: Effect.Effect<A, AppError, AgentServices>): Promise<A> =>
    // SAFETY: the URL request flow needs only the MCP, chat, setup, routine and resident services provided here.
    Effect.runPromise(Effect.provide(program, layer) as Effect.Effect<A, AppError>)
  const told: Told[] = []
  const answer = (id: string, action: 'accept' | 'decline') =>
    run(
      answerUrlRequest({
        id,
        action,
        continue: (session, { text, outcome, from }, operationId) =>
          Effect.sync(() => told.push({ session, text, outcome, from, operationId })),
      }),
    )
  const input = { connectionId: 'sq', name: 'create_agent', arguments: { name: 'Worker' } }
  // The model's call meets the URL request and keeps it, as mcp_call does.
  const asked = await run(
    Effect.gen(function* () {
      const outcome = yield* (yield* McpConnections).callModelTool(input.connectionId, input.name, input.arguments)
      if (outcome.kind !== 'url') return yield* Effect.die('the server did not ask')
      return yield* holdUrlRequest('41', 'c1', 't1', input, outcome.prompt)
    }),
  )
  return { server, told, answer, asked, flows, view: (id: string) => run(urlRequestView(id)) }
}

const ID = 'mcp-url:41:c1'

describe('the owner finishes or cancels a URL request (unit, ADR 0042)', () => {
  it('shows the owner the link and its host, and leaves it pending while the server still waits', async () => {
    const { asked, told, answer, view, flows } = await fixture()
    expect(asked.details).toEqual({ kind: 'url-required', requestId: ID, connectionId: 'sq', name: 'create_agent' })
    expect(await view(ID)).toMatchObject({
      url: APPROVE,
      host: 'sq.test',
      ownHost: true,
      message: 'Approve the new agent.',
      state: 'pending',
      conversation: '41',
    })
    // Done before the operator approved: the server asks again, and nothing goes back to the turn yet.
    expect(await answer(ID, 'accept')).toMatchObject({ state: 'pending' })
    expect(told).toEqual([])
    expect(
      flows.map(({ flow, actor, status, operationId, chat }) => ({ flow, actor, status, operationId, chat })),
    ).toEqual([
      { flow: 'url_request', actor: 'agent', status: 'ok', operationId: ID, chat: '41' },
      { flow: 'url_request_wait', actor: 'owner', status: 'ok', operationId: ID, chat: '41' },
    ])
  })

  it('retries once with the answer, sends the result back once however often Done is pressed', async () => {
    const { server, told, answer, flows } = await fixture()
    server.state.approved = true
    expect(await answer(ID, 'accept')).toMatchObject({ state: 'completed' })
    expect(await answer(ID, 'accept')).toMatchObject({ state: 'completed' })
    expect(server.seen.filter(({ answer: given }) => given !== undefined)).toHaveLength(1)
    expect(flows.slice(1).map(({ flow, status }) => [flow, status])).toEqual([
      ['url_request_finish', 'ok'],
      ['url_request_finish', 'replayed'],
    ])
    expect(told.map(({ operationId }) => operationId)).toEqual([`mcp-url-continue:${ID}`, `mcp-url-continue:${ID}`])
    const [first] = told
    expect(first?.session).toBe('41')
    expect(first?.text).toContain('The owner finished the step "Sidequest · Worker" (sq) · create_agent asked for')
    expect(first?.from).toBe('Sidequest · Worker')
    expect(first?.outcome).toMatchObject({
      continuation: { kind: 'url', connectionId: 'sq', name: 'create_agent', state: 'completed' },
      origin: { connectionId: 'sq', trust: 'untrusted' },
      result: { structuredContent: { agent: 'ag_1' } },
    })
    expect(JSON.stringify(first)).not.toContain('one-time')
  })

  it('sends the answer even after the server stopped listing the tool, as finishing its step can make it', async () => {
    const { server, told, answer } = await fixture()
    server.state.approved = true
    server.state.unlisted = true
    expect(await answer(ID, 'accept')).toMatchObject({ state: 'completed' })
    expect(server.seen.at(-1)).toMatchObject({ answer: { action: 'accept' }, state: 'op_1' })
    expect(told[0]?.outcome.result).toMatchObject({ structuredContent: { agent: 'ag_1' } })
  })

  it('ends a retry the server answered but goblin could not read as uncertain, and one it refused as failed', async () => {
    const unreadable = await fixture()
    unreadable.server.state.approved = true
    unreadable.server.state.wrongOutput = true
    expect(await unreadable.answer(ID, 'accept')).toMatchObject({ state: 'uncertain' })
    expect(unreadable.told[0]?.text).toContain('It may have taken effect')
    const refused = await fixture()
    refused.server.state.refuse = true
    expect(await refused.answer(ID, 'accept')).toMatchObject({ state: 'failed' })
  })

  it('keeps a cancel declined even when the server asks again', async () => {
    const { server, told, answer } = await fixture()
    server.state.askOnDecline = true
    expect(await answer(ID, 'decline')).toMatchObject({ state: 'declined' })
    expect(told[0]?.text).toContain('The owner cancelled the step')
  })

  it('sends a decline on Cancel and tells the turn the step was cancelled', async () => {
    const { server, told, answer, flows } = await fixture()
    expect(await answer(ID, 'decline')).toMatchObject({ state: 'declined' })
    expect(flows.at(-1)).toMatchObject({ flow: 'url_request_cancel', status: 'ok' })
    expect(server.seen.at(-1)).toMatchObject({ answer: { action: 'decline' }, state: 'op_1' })
    expect(told[0]?.text).toContain('The owner cancelled the step')
  })
})
