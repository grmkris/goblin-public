import type { AppView, McpOutcome } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import { afterEach, describe, expect, it } from 'vitest'
import { Apps } from '../../src/apps/service.ts'
import { ChatId } from '../../src/chats/directory.ts'
import { Chats, Conversations } from '../../src/chats/service.ts'
import type { AppError } from '../../src/http/errors.ts'
import type { AgentServices } from '../../src/layers/index.ts'
import { approvalsOver, heldCalls, urlRequestsOver } from '../../src/layers/mcp.ts'
import { decideApproval, sendApproved } from '../../src/mcp/approval-decision.ts'
import { modelApprovalId } from '../../src/mcp/approval-request.ts'
import { McpApprovalStore } from '../../src/mcp/approvals.ts'
import { CredentialCipher } from '../../src/mcp/cipher.ts'
import { mcpHost } from '../../src/mcp/host.ts'
import { settledDetails } from '../../src/mcp/kept-app.ts'
import { Approvals, Resident, Spending, UrlRequests } from '../../src/mcp/service.ts'
import { answerUrlRequest, urlRequestView } from '../../src/mcp/url-request.ts'
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

/** What a turn was told, by operation id: goblin's words and the outcome block. */
type Told = { readonly text: string; readonly outcome: McpOutcome; readonly operationId: string }

const GRANT = { connectionId: 'sq', capability: 'tool' as const, name: 'create_agent' }
const APPROVAL = modelApprovalId('41', 'c1')
const REQUEST = 'mcp-url:41:c1'

/**
 * The owner approves a model's held call to an ask-first tool on the Sidequest-like server, whose dispatch it answers
 * with a URL request (ADR 0042, the F5 case of a wallet transfer to a new recipient): real approval and URL request
 * stores and the agent's own held-call check (`heldCalls`), chat 41 acting and allowed everything.
 */
const fixture = async () => {
  const server = sidequestServer()
  const { db, close } = chatDatabase()
  cleanups.push(close)
  const cipher = await CredentialCipher.fromBase64(btoa(String.fromCharCode(...new Uint8Array(32))))
  const approvals = new McpApprovalStore(durable(db), cipher)
  const grants = new MemoryGrants([GRANT])
  grants.setAskFirst(GRANT, true)
  const credentials = new MemoryCredentials()
  await credentials.saveTokens('sq', { access_token: 'fixture', token_type: 'bearer' }, 0)
  const host = mcpHost({
    servers: [{ ...SIDEQUEST, label: 'Sidequest · Worker' }],
    credentials,
    grants,
    registries: new MemoryRegistries(),
    labels: new MemoryLabels(),
    appUrl: 'https://goblin.test',
    fetch: server.fetch,
    authorizeTool: heldCalls(approvals, grants),
  })
  const layer = host.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        SingleFlight.layer,
        FlowEvents.layerWith(() => Effect.void),
        Layer.succeed(Approvals, approvalsOver(approvals)),
        Layer.succeed(UrlRequests, urlRequestsOver(new McpUrlRequestStore(durable(db), cipher))),
        Layer.succeed(Changes, makeChanges()),
        stub(Resident, { require: () => Effect.void }),
        stub(Spending, { record: () => Effect.succeed(true) }),
        stub(RoutineRuns, { session: () => Effect.succeed(undefined) }),
        stub(Chats, { chatOf: () => Effect.succeed(Option.some(ChatId('41'))) }),
        stub(Conversations, { requireActing: (chat) => Effect.succeed(chat), kindOf: () => Effect.succeed('main') }),
        stub(Setups, { scope: () => Effect.succeed(scopeOf([], true)) }),
        // SAFETY: the test never reads the view a kept App answers.
        stub(Apps, { register: () => Effect.succeed({} as AppView) }),
        plans(),
      ),
    ),
  )
  const run = <A>(program: Effect.Effect<A, AppError, AgentServices>): Promise<A> =>
    // SAFETY: these programs need only the MCP, approval, URL request, chat, setup and resident services above.
    Effect.runPromise(Effect.provide(program, layer) as Effect.Effect<A, AppError>)
  const told: Told[] = []
  const tell = (_session: string, { text, outcome }: { text: string; outcome: McpOutcome }, operationId: string) =>
    Effect.sync(() => void told.push({ text, outcome, operationId }))
  await approvals.hold(
    {
      id: APPROVAL,
      caller: 'model',
      sessionId: '41',
      sourceCallId: 'c1',
      taskId: 't1',
      ...GRANT,
      arguments: { name: 'Worker' },
      endpoint: SIDEQUEST.endpoint,
      grantVersion: grants.policy(GRANT)?.version ?? '',
    },
    Date.now(),
  )
  return {
    server,
    grants,
    approvals,
    told,
    run,
    decide: () => run(decideApproval({ id: APPROVAL, allowed: true, continue: tell })),
    answer: (action: 'accept' | 'decline') => run(answerUrlRequest({ id: REQUEST, action, continue: tell })),
    request: () => run(urlRequestView(REQUEST)),
  }
}

describe('an approved call the server answers with a URL request (unit, ADR 0042)', () => {
  it('declares URL elicitation, keeps the request for the owner and continues the turn only once it is settled', async () => {
    const { server, told, decide, answer, request, run } = await fixture()
    // Before F5 the approved dispatch declared nothing, the server refused to ask (-32021), and the call read "may have
    // run". Now it asks, and the approval goes on as the URL request.
    expect(await decide()).toMatchObject({ state: 'completed', urlRequest: REQUEST })
    expect(server.seen).toEqual([{ url: true, answer: undefined, state: undefined }])
    expect(await request()).toMatchObject({ url: APPROVE, state: 'pending', conversation: '41', ownHost: true })
    expect(told).toEqual([])
    // The App placeholder of the held call stays until the request is finished.
    const placeholder = { kind: 'approval-required', approvalId: APPROVAL, connectionId: 'sq', name: 'create_agent' }
    expect(await run(settledDetails(placeholder))).toEqual(placeholder)
    // Done before the owner approved on the server's site: it asks again, and nothing goes back to the turn.
    expect(await answer('accept')).toMatchObject({ state: 'pending' })
    expect(told).toEqual([])
    server.state.approved = true
    expect(await answer('accept')).toMatchObject({ state: 'completed' })
    expect(server.seen.filter(({ answer: given }) => given !== undefined)).toHaveLength(2)
    expect(told).toHaveLength(1)
    expect(told[0]).toMatchObject({
      operationId: `mcp-url-continue:${REQUEST}`,
      outcome: {
        continuation: { kind: 'url', connectionId: 'sq', name: 'create_agent', state: 'completed' },
        result: { structuredContent: { agent: 'ag_1' } },
      },
    })
    expect(await run(settledDetails(placeholder))).toMatchObject({ structuredContent: { agent: 'ag_1' } })
  })

  it('refuses the retry once the owner changed what the approval rested on', async () => {
    const { server, grants, decide, answer } = await fixture()
    await decide()
    // The owner turns ask-first off and on again: the grant's version moves, so the reviewed authority is gone.
    grants.setAskFirst(GRANT, false)
    grants.setAskFirst(GRANT, true)
    server.state.approved = true
    expect(await answer('accept')).toMatchObject({ state: 'failed' })
    expect(server.seen.filter(({ answer: given }) => given !== undefined)).toEqual([])
  })

  it('answers an approval under the owner’s rule with the URL request, for the turn that waits on it', async () => {
    const { approvals, run } = await fixture()
    approvals.decide(APPROVAL, true, Date.now())
    const sent = await run(sendApproved(approvals.get(APPROVAL)))
    expect(sent.kind).toBe('url')
    expect(sent.result).toMatchObject({ isError: true, details: { kind: 'url-required', requestId: REQUEST } })
  })
})
