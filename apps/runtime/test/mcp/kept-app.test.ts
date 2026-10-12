import type { AppView } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import { afterEach, describe, expect, it } from 'vitest'
import { Apps } from '../../src/apps/service.ts'
import { ChatId } from '../../src/chats/directory.ts'
import { Chats, Conversations } from '../../src/chats/service.ts'
import type { AppError } from '../../src/http/errors.ts'
import type { AgentServices } from '../../src/layers/index.ts'
import { approvalsOver, urlRequestsOver } from '../../src/layers/mcp.ts'
import { McpApprovalStore } from '../../src/mcp/approvals.ts'
import { sendApproved } from '../../src/mcp/approval-decision.ts'
import { CredentialCipher } from '../../src/mcp/cipher.ts'
import { mcpHost } from '../../src/mcp/host.ts'
import { settledDetails } from '../../src/mcp/kept-app.ts'
import { Approvals, McpConnections, Resident, Spending, UrlRequests } from '../../src/mcp/service.ts'
import { answerUrlRequest, holdUrlRequest } from '../../src/mcp/url-request.ts'
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
import { SIDEQUEST, sidequestServer } from './sidequest-fixture.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const close of cleanups.splice(0)) close()
})

const input = { connectionId: 'sq', name: 'create_agent', arguments: { name: 'Worker' } }
const placeholderOfApproval = (approvalId: string) => ({
  kind: 'approval-required',
  approvalId,
  connectionId: 'sq',
  name: 'create_agent',
})

/**
 * Sidequest's `create_agent` renders an App. A model's call to it is held (for the owner's approval, or as a URL
 * request); `registered` records the Apps kept, `run` runs programs over the real host and stores.
 */
const fixture = async () => {
  const server = sidequestServer()
  server.state.app = true
  const registered: { session: string; callId: string; uri: string }[] = []
  const { db, close } = chatDatabase()
  cleanups.push(close)
  const cipher = await CredentialCipher.fromBase64(btoa(String.fromCharCode(...new Uint8Array(32))))
  const approvals = new McpApprovalStore(durable(db), cipher)
  const urlRequests = new McpUrlRequestStore(durable(db), cipher)
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
    // The dispatch of an approved call claims its one dispatch, as the agent's own check does.
    authorizeTool: (_call, approvalId, dispatch) =>
      Effect.sync(() => void (dispatch && approvalId !== undefined && approvals.claim(approvalId, 2))),
  })
  const layer = host.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        SingleFlight.layer,
        FlowEvents.layerWith(() => Effect.void),
        Layer.succeed(Approvals, approvalsOver(approvals)),
        Layer.succeed(UrlRequests, urlRequestsOver(urlRequests)),
        Layer.succeed(Changes, makeChanges()),
        stub(Resident, { require: () => Effect.void }),
        stub(Spending, { record: () => Effect.succeed(true) }),
        stub(RoutineRuns, { session: () => Effect.succeed(undefined) }),
        stub(Chats, { chatOf: () => Effect.succeed(Option.some(ChatId('41'))) }),
        stub(Conversations, { requireActing: (chat) => Effect.succeed(chat), kindOf: () => Effect.succeed('main') }),
        stub(Setups, { scope: () => Effect.succeed(scopeOf([], true)) }),
        stub(Apps, {
          register: (session, callId, origin) =>
            Effect.sync(() => {
              registered.push({ session, callId, uri: origin.uri })
              // SAFETY: the test reads only that an App was registered, never the view it answers.
              return {} as AppView
            }),
        }),
        plans(),
      ),
    ),
  )
  const run = <A>(program: Effect.Effect<A, AppError, AgentServices>): Promise<A> =>
    // SAFETY: these programs need only the MCP, approval, URL request, App, chat, setup and resident services above.
    Effect.runPromise(Effect.provide(program, layer) as Effect.Effect<A, AppError>)
  // The tools are listed once so the host knows which of them renders an App.
  await run(Effect.asVoid(McpConnections.use((connections) => connections.connect('sq'))))
  return { server, registered, approvals, run }
}

describe('an App kept for a call that ends its turn waiting on the owner (unit)', () => {
  it('registers the App when the owner approves the held call, and shows its real result instead of the placeholder', async () => {
    const { registered, approvals, run } = await fixture()
    const held = await approvals.hold(
      {
        id: 'mcp-approval:41:c1',
        caller: 'model',
        sessionId: '41',
        sourceCallId: 'c1',
        taskId: 't1',
        connectionId: 'sq',
        name: 'create_agent',
        arguments: input.arguments,
        endpoint: SIDEQUEST.endpoint,
        grantVersion: 'v1',
      },
      0,
    )
    const placeholder = placeholderOfApproval(held.id)
    // Still waiting: nothing is kept, and the App would show the placeholder.
    expect(registered).toEqual([])
    expect(await run(settledDetails(placeholder))).toEqual(placeholder)
    approvals.decide(held.id, true, 1)
    await run(sendApproved(approvals.get(held.id)))
    expect(registered).toEqual([{ session: '41', callId: 'c1', uri: 'ui://sq/agent' }])
    const details = await run(settledDetails(placeholder))
    expect(details).toMatchObject({ origin: { connectionId: 'sq' } })
    expect(JSON.stringify(details)).toContain('Approval needed')
    expect(details).not.toHaveProperty('kind')
  })

  it('keeps no App for a call the owner refused or one made by an App or the console', async () => {
    const { registered, approvals, run } = await fixture()
    const base = { connectionId: 'sq', name: 'create_agent', arguments: input.arguments, endpoint: SIDEQUEST.endpoint }
    const refused = await approvals.hold(
      { ...base, id: 'a1', caller: 'model', sessionId: '41', sourceCallId: 'c2', taskId: 't1', grantVersion: 'v1' },
      0,
    )
    approvals.decide(refused.id, false, 1)
    expect(await run(settledDetails(placeholderOfApproval(refused.id)))).toEqual(placeholderOfApproval(refused.id))
    const human = await approvals.hold({ ...base, id: 'a2', caller: 'human', grantVersion: 'v1' }, 0)
    approvals.decide(human.id, true, 1)
    await run(sendApproved(approvals.get(human.id)))
    expect(registered).toEqual([])
  })

  it('registers the App when a finished URL request is retried, and shows its real result', async () => {
    const { server, registered, run } = await fixture()
    const asked = await run(
      Effect.gen(function* () {
        const outcome = yield* (yield* McpConnections).callModelTool(input.connectionId, input.name, input.arguments)
        if (outcome.kind !== 'url') return yield* Effect.die('the server did not ask')
        return yield* holdUrlRequest('41', 'c1', 't1', input, outcome.prompt)
      }),
    )
    const placeholder = asked.details
    const id = 'mcp-url:41:c1'
    const answer = (action: 'accept' | 'decline') => run(answerUrlRequest({ id, action, continue: () => Effect.void }))
    // Done before the server's operator approved: still waiting, nothing kept.
    await answer('accept')
    expect(registered).toEqual([])
    expect(await run(settledDetails(placeholder))).toEqual(placeholder)
    server.state.approved = true
    await answer('accept')
    expect(registered).toEqual([{ session: '41', callId: 'c1', uri: 'ui://sq/agent' }])
    const details = await run(settledDetails(placeholder))
    expect(details).toMatchObject({ origin: { connectionId: 'sq' }, structuredContent: { agent: 'ag_1' } })
  })

  it('leaves anything that is not such a placeholder as it is', async () => {
    const { run } = await fixture()
    for (const details of [undefined, null, 'text', { structuredContent: { a: 1 } }, { kind: 'approval-required' }])
      expect(await run(settledDetails(details))).toEqual(details)
  })
})
