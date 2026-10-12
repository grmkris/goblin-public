import type { AppView, McpOutcome } from '@goblin/contracts'
import { createMcpHandler } from '@modelcontextprotocol/server'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import { afterEach, describe, expect, it } from 'vitest'
import { Apps } from '../../src/apps/service.ts'
import { ChatId } from '../../src/chats/directory.ts'
import { Chats, Conversations } from '../../src/chats/service.ts'
import type { AppError } from '../../src/http/errors.ts'
import type { AgentServices } from '../../src/layers/index.ts'
import { approvalsOver, heldCalls, spendingOver, urlRequestsOver } from '../../src/layers/mcp.ts'
import { decideApproval } from '../../src/mcp/approval-decision.ts'
import { McpApprovalStore } from '../../src/mcp/approvals.ts'
import { CredentialCipher } from '../../src/mcp/cipher.ts'
import { mercatorWallet, profileOf, profileView } from '../../src/mcp/first-class.ts'
import { fundJob } from '../../src/mcp/fund-job.ts'
import { mcpHost } from '../../src/mcp/host.ts'
import { Approvals, McpConnections, Resident, Spending, UrlRequests } from '../../src/mcp/service.ts'
import { SpendStore } from '../../src/mcp/spend.ts'
import {
  TOP_UP_TOOL,
  assertRecordedTopUp,
  balanceMicros,
  destinationOf,
  ensureFunded,
  topUpAmount,
} from '../../src/mcp/top-up.ts'
import { answerUrlRequest, urlRequestView } from '../../src/mcp/url-request.ts'
import { McpUrlRequestStore } from '../../src/mcp/url-requests.ts'
import { Notices } from '../../src/notices/service.ts'
import type { NewNotice, NoticeRow } from '../../src/notices/store.ts'
import { FlowEvents } from '../../src/observability/flows.ts'
import { SingleFlight } from '../../src/observability/single-flight.ts'
import { RoutineRuns } from '../../src/routines/service.ts'
import { Changes, makeChanges } from '../../src/runtime/changes.ts'
import { scopeOf } from '../../src/setup/scope.ts'
import { Setups } from '../../src/setup/service.ts'
import { chatDatabase, durable } from '../chats-sqlite.ts'
import { plans, stub } from '../http/api/fixture.ts'
import { declaresUrlElicitation, lowLevelServer } from './low-level-server.ts'
import { MemoryCredentials, MemoryGrants, MemoryLabels, MemoryRegistries } from './memory.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const close of cleanups.splice(0)) close()
})

/** Mercator's wallet on Tempo, as its status reports it, and an address that is not it. */
const MERCATOR_WALLET = '0xF144e54D000000000000000000000000000a2dDd'
const ELSEWHERE = `0x${'e'.repeat(40)}`
const MERCATOR = { connectionId: 'mercator', endpoint: 'https://mercator.sh/mcp/auth', label: 'Mercator' }
const WALLET = { connectionId: 'wallet', endpoint: 'https://wallet.goblin.surf/mcp', label: 'Goblin Wallet' }
const APPROVE = 'https://wallet.goblin.surf/approve/topup%3Amercator%3A1'

/** Mercator's `get_connection_status`, shaped as its output schema says (2026-10-12), holding `balance` USDC.e. */
const mercatorStatus = (balance: string | undefined) => ({
  readiness: {
    authorization: 'ready',
    walletBinding: 'ready',
    funding: 'ready',
    spendPolicy: 'ready',
    paidExecution: 'ready',
    confirmationPolicy: 'standing_authorization',
    tokens: [{ symbol: 'USDC.e', ...(balance === undefined ? {} : { balance }), status: 'ready' }],
  },
  account: {
    accessKey: { expiresAt: null, spendPolicy: 'limited', status: 'active', address: `0x${'a'.repeat(40)}` },
    tokens: [],
    walletAddress: MERCATOR_WALLET,
  },
  next_action: 'Ready to pay.',
  oauthAuthenticated: true,
  paymentMode: 'hosted_oauth',
})

/** A listed tool that takes any object. */
const tool = (name: string) => ({ name, inputSchema: { type: 'object' } as const })

/**
 * Mercator (its status and `create_job`) and the Goblin Wallet (`transfer`, `wallet_status`) behind one fetch. The
 * wallet's transfer asks the owner first while `newRecipient` holds and the request declares URL elicitation, until it
 * comes back accepted once `approved`; `refuse` makes it answer a refusal.
 */
const servers = () => {
  const state: { balance: string | undefined; newRecipient: boolean; approved: boolean; refuse: boolean } = {
    balance: '0.55',
    newRecipient: false,
    approved: false,
    refuse: false,
  }
  const transfers: { readonly args: Record<string, unknown>; readonly answered: boolean }[] = []
  const jobs: Record<string, unknown>[] = []
  const mercator = createMcpHandler(() => {
    const server = lowLevelServer({ name: 'mercator', version: '0.5.0' }, { capabilities: { tools: {} } })
    server.setRequestHandler('tools/list', () => ({ tools: [tool('get_connection_status'), tool('create_job')] }))
    server.setRequestHandler('tools/call', (request) => {
      if (request.params.name === 'get_connection_status')
        return { content: [{ type: 'text', text: 'status' }], structuredContent: mercatorStatus(state.balance) }
      jobs.push(request.params.arguments ?? {})
      return { content: [{ type: 'text', text: 'job started' }], structuredContent: { jobId: 'job_1' } }
    })
    return server
  })
  const wallet = createMcpHandler(() => {
    const server = lowLevelServer({ name: 'wallet', version: '1.0.0' }, { capabilities: { tools: {} } })
    server.setRequestHandler('tools/list', () => ({ tools: [tool('transfer'), tool('wallet_status')] }))
    server.setRequestHandler('tools/call', (request, ctx) => {
      if (request.params.name !== 'transfer') return { content: [{ type: 'text', text: 'status' }] }
      const answer = JSON.stringify(ctx.mcpReq.inputResponses?.['approval'])
      transfers.push({ args: request.params.arguments ?? {}, answered: answer !== undefined })
      if (state.refuse)
        return {
          isError: true,
          content: [{ type: 'text', text: 'Not enough USDC.e.' }],
          structuredContent: { error: { code: 'insufficient_funds', message: 'Not enough USDC.e.' } },
        }
      const accepted = answer === '{"action":"accept"}' && state.approved
      if (state.newRecipient && declaresUrlElicitation(ctx.mcpReq.envelope) && !accepted)
        // SAFETY: the 2026 server seam takes a hand-built input_required result in place of a CallToolResult.
        return {
          resultType: 'input_required',
          inputRequests: {
            approval: {
              method: 'elicitation/create',
              params: { mode: 'url', message: 'Approve the recipient.', url: APPROVE },
            },
          },
          requestState: 'topup:mercator:1',
        } as never
      return {
        content: [{ type: 'text', text: 'sent' }],
        structuredContent: { operation: { id: request.params.arguments?.['operation_id'], status: 'confirmed' } },
      }
    })
    return server
  })
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    return new URL(request.url).hostname === 'mercator.sh' ? mercator.fetch(request) : wallet.fetch(request)
  }
  return { state, transfers, jobs, fetch }
}

/** What the agent's services keep for a test to read: the receipts claimed and posted, and the flow steps. */
type Kept = { readonly notices: NewNotice[]; readonly posted: string[]; readonly flows: string[] }

/** The notices a receipt claims, read back as a fresh claim keeps them. */
const memoryNotices = (kept: Kept) =>
  stub(Notices, {
    claim: (notice) => Effect.sync(() => (kept.notices.push(notice), { posted: true })),
    get: (id) =>
      Effect.sync(() => {
        const notice = kept.notices.find((one) => one.id === id)
        // SAFETY: the notice as kept, with the state a fresh claim has.
        return notice === undefined ? undefined : ({ ...notice, writtenAt: null, readAt: null } as NoticeRow)
      }),
    written: () => Effect.void,
  })

/** The agent's services over the real stores: chat 41 acting and allowed everything, no routine run. */
const agentServices = (
  stores: { readonly approvals: McpApprovalStore; readonly urls: McpUrlRequestStore; readonly spend: SpendStore },
  kept: Kept,
) =>
  Layer.mergeAll(
    SingleFlight.layer,
    FlowEvents.layerWith((event) => Effect.sync(() => void kept.flows.push(`${event.flow}:${event.status}`))),
    Layer.succeed(Approvals, approvalsOver(stores.approvals)),
    Layer.succeed(UrlRequests, urlRequestsOver(stores.urls)),
    Layer.succeed(Spending, spendingOver(stores.spend)),
    Layer.succeed(Changes, makeChanges()),
    stub(Resident, { require: () => Effect.void }),
    stub(RoutineRuns, { session: () => Effect.succeed(undefined) }),
    stub(Chats, { chatOf: () => Effect.succeed(Option.some(ChatId('41'))) }),
    stub(Conversations, {
      requireActing: (chat) => Effect.succeed(chat),
      kindOf: () => Effect.succeed('main'),
      postNotice: (notice) => Effect.sync(() => void kept.posted.push(notice.data.title)),
    }),
    stub(Setups, { scope: () => Effect.succeed(scopeOf([], true)) }),
    memoryNotices(kept),
    // SAFETY: the test never reads the view a kept App answers.
    stub(Apps, { register: () => Effect.succeed({} as AppView) }),
    plans(),
  )

/**
 * The real MCP host over both servers with the agent's own held-call check, real approval, URL request and spend
 * stores; chat 41 acting and allowed everything. `notices` records the receipts, `told` what reaches a turn.
 */
const fixture = async () => {
  const remote = servers()
  const { db, close } = chatDatabase()
  cleanups.push(close)
  const cipher = await CredentialCipher.fromBase64(btoa(String.fromCharCode(...new Uint8Array(32))))
  const approvals = new McpApprovalStore(durable(db), cipher)
  const spend = new SpendStore(durable(db))
  const grants = new MemoryGrants(
    ['get_connection_status', 'create_job']
      .map((name) => ({ connectionId: 'mercator', capability: 'tool' as const, name }))
      .concat(['transfer', 'wallet_status'].map((name) => ({ connectionId: 'wallet', capability: 'tool', name }))),
  )
  // As Allow recommended leaves them: a job and a transfer ask the owner first.
  grants.setAskFirst({ connectionId: 'mercator', capability: 'tool', name: 'create_job' }, true)
  grants.setAskFirst({ connectionId: 'wallet', capability: 'tool', name: 'transfer' }, true)
  const credentials = new MemoryCredentials()
  for (const id of ['mercator', 'wallet'])
    await credentials.saveTokens(id, { access_token: id, token_type: 'bearer' }, 0)
  const host = mcpHost({
    servers: [MERCATOR, WALLET],
    credentials,
    grants,
    registries: new MemoryRegistries(),
    labels: new MemoryLabels(),
    appUrl: 'https://goblin.test',
    fetch: remote.fetch,
    authorizeTool: heldCalls(approvals, grants, spend),
  })
  const kept: Kept = { notices: [], posted: [], flows: [] }
  const urls = new McpUrlRequestStore(durable(db), cipher)
  const layer = host.pipe(Layer.provideMerge(agentServices({ approvals, urls, spend }, kept)))
  const run = <A>(program: Effect.Effect<A, AppError, AgentServices>): Promise<A> =>
    // SAFETY: these programs need only the MCP, approval, URL request, spend, chat, notice and resident services above.
    Effect.runPromise(Effect.provide(program, layer) as Effect.Effect<A, AppError>)
  /** How `program` failed, by its tag; `ok` when it did not. */
  const fails = <A>(program: Effect.Effect<A, AppError, AgentServices>) =>
    run(Effect.match(program, { onSuccess: () => 'ok', onFailure: (error) => error._tag }))
  return { remote, spend, approvals, grants, ...kept, run, fails }
}

/** A Mercator job of `total` dollars, as the model calls `create_job`. */
const job = (total: string) => ({ plan: { nodes: [] }, idempotency_key: 'job-key-0001', approved_total: total })

describe('top-ups of a prepaid server from the Goblin Wallet (unit, ADR 0049)', () => {
  it('reads where Mercator is funded from its status, and keeps how goblin funds it out of the owner view', () => {
    expect(mercatorWallet(mercatorStatus('0.55'))?.depositTo).toEqual({
      address: MERCATOR_WALLET,
      chain: 'tempo',
      token: 'USDC.e',
    })
    const unbound = {
      ...mercatorStatus('0.55'),
      account: { ...mercatorStatus('0').account, walletAddress: `0x${'0'.repeat(40)}` },
    }
    expect(mercatorWallet(unbound)?.depositTo).toBeUndefined()
    const view = profileView(profileOf(MERCATOR.endpoint) ?? expect.fail('no profile'))
    expect(view.prepaid).toEqual({ chain: 'tempo', token: 'USDC.e', perTopUp: '5', daily: '20' })
    const wallet = profileOf(WALLET.endpoint) ?? expect.fail('no profile')
    expect(wallet.funding).toEqual({ tool: 'transfer' })
    expect(Object.keys(profileView(wallet))).not.toContain('funding')
  })

  it('cuts a balance down to micro-dollars, and tops up the shortfall rounded up to a dollar, at least $2', () => {
    expect([balanceMicros('0.55'), balanceMicros('2.0512345678'), balanceMicros('7')]).toEqual([
      550_000, 2_051_234, 7_000_000,
    ])
    for (const bad of [undefined, '', '-1', '1e3', 'n/a']) expect(balanceMicros(bad), String(bad)).toBeUndefined()
    expect([topUpAmount(1), topUpAmount(2_450_000), topUpAmount(3_000_000), topUpAmount(3_000_001)]).toEqual([
      2_000_000, 3_000_000, 3_000_000, 4_000_000,
    ])
  })

  it('lets a funding call out only as recorded: its amount, chain, token and recipient', () => {
    const row = {
      approvalId: 'topup:mercator:1',
      connectionId: 'mercator',
      tool: TOP_UP_TOOL,
      micros: 3_000_000,
      standing: true,
      destination: destinationOf('tempo', 'USDC.e', MERCATOR_WALLET),
      day: '2026-10-12',
      at: 0,
    }
    const args = {
      chain: 'tempo',
      token: 'USDC.e',
      to: MERCATOR_WALLET.toLowerCase(),
      amount: '3',
      max_usd: '3',
      operation_id: 'topup:mercator:1',
    }
    expect(() => assertRecordedTopUp(row, args)).not.toThrow()
    for (const wrong of [
      { to: ELSEWHERE },
      { amount: '4' },
      { max_usd: '30' },
      { chain: 'base' },
      { token: 'USDC' },
      { operation_id: 'topup:mercator:2' },
    ])
      expect(() => assertRecordedTopUp(row, { ...args, ...wrong }), JSON.stringify(wrong)).toThrow()
    expect(() => assertRecordedTopUp(undefined, args)).toThrow()
    expect(() => assertRecordedTopUp({ ...row, tool: 'create_job' }, args)).toThrow()
  })
})

describe('ensureFunded before a prepaid job (unit, ADR 0049)', () => {
  it('tops up the shortfall within the rule, to the address Mercator reports, with a receipt; nothing when funded', async () => {
    const { remote, spend, notices, posted, flows, run } = await fixture()
    expect(await run(ensureFunded('mercator', 500_000, { session: '41' }))).toEqual({ kind: 'ready' })
    expect(remote.transfers).toEqual([])
    expect(await run(ensureFunded('mercator', 3_000_000, { session: '41' }))).toEqual({
      kind: 'moved',
      micros: 3_000_000,
    })
    expect(remote.transfers).toEqual([
      {
        args: {
          chain: 'tempo',
          token: 'USDC.e',
          to: MERCATOR_WALLET,
          amount: '3',
          max_usd: '3',
          operation_id: 'topup:mercator:1',
          memo: 'goblin top-up for "Mercator" (mercator)',
        },
        answered: false,
      },
    ])
    expect(spend.find('topup:mercator:1')).toMatchObject({
      tool: TOP_UP_TOOL,
      micros: 3_000_000,
      standing: true,
      destination: `tempo:USDC.e:${MERCATOR_WALLET.toLowerCase()}`,
    })
    expect(notices.map(({ title, chatId, connectionId }) => ({ title, chatId, connectionId }))).toEqual([
      { title: 'Moved $3.00 to Mercator from your Goblin Wallet', chatId: '41', connectionId: 'wallet' },
    ])
    expect(posted).toEqual(['Moved $3.00 to Mercator from your Goblin Wallet'])
    expect(flows).toEqual(['top_up:ok'])
  })

  it('moves nothing above the rule or past the day, or when the balance cannot be read', async () => {
    const { remote, spend, run } = await fixture()
    const above = await run(ensureFunded('mercator', 9_000_000, { session: '41' }))
    expect(above).toMatchObject({ kind: 'refused' })
    expect(above.kind === 'refused' && above.text).toContain(
      "above the owner's top-up rule (up to $5 a top-up and $20 a day)",
    )
    expect(remote.transfers).toEqual([])
    spend.setRule('mercator', TOP_UP_TOOL, { perJob: 5_000_000, daily: 6_000_000 }, Date.now())
    expect(await run(ensureFunded('mercator', 3_000_000, { session: '41' }))).toMatchObject({ kind: 'moved' })
    expect(await run(ensureFunded('mercator', 4_000_000, { session: '41' }))).toMatchObject({ kind: 'refused' })
    expect(remote.transfers).toHaveLength(1)
    remote.state.balance = undefined
    expect(await run(ensureFunded('mercator', 3_000_000, { session: '41' }))).toEqual({ kind: 'ready' })
    expect(remote.transfers).toHaveLength(1)
  })

  it('refuses the job with the wallet’s code when the wallet does not send the top-up', async () => {
    const { remote, notices, run } = await fixture()
    remote.state.refuse = true
    const refused = await run(ensureFunded('mercator', 3_000_000, { session: '41' }))
    expect(refused.kind === 'refused' && refused.text).toContain('did not send it (insufficient_funds)')
    expect(JSON.stringify(refused)).not.toContain('Not enough')
    expect(notices).toEqual([])
  })
})

describe('the funding caller (unit, ADR 0049)', () => {
  it('reaches only the wallet’s transfer, only as a recorded top-up, while the model’s own transfer still asks', async () => {
    const { remote, run, fails } = await fixture()
    const connections = McpConnections.use((all) => Effect.succeed(all))
    const call = (connectionId: string, name: string, args: Record<string, unknown>, caller: 'funding' | 'model') =>
      Effect.flatMap(connections, (all) => all.callTool(connectionId, name, args, { caller }))
    expect(await fails(call('wallet', 'wallet_status', {}, 'funding'))).toBe('Forbidden')
    expect(await fails(call('mercator', 'create_job', job('1'), 'funding'))).toBe('Forbidden')
    await run(ensureFunded('mercator', 3_000_000, { session: '41' }))
    const recorded = remote.transfers[0]?.args ?? expect.fail('no top-up')
    expect(await fails(call('wallet', 'transfer', { ...recorded, to: ELSEWHERE }, 'funding'))).toBe('Forbidden')
    expect(await fails(call('wallet', 'transfer', { ...recorded, operation_id: 'topup:mercator:9' }, 'funding'))).toBe(
      'Forbidden',
    )
    expect(await fails(call('wallet', 'transfer', recorded, 'model'))).toBe('Forbidden')
    expect(remote.transfers).toHaveLength(1)
  })
})

describe('a top-up the wallet asks the owner about (unit, ADRs 0042, 0049)', () => {
  it('keeps the wallet’s URL request under the job’s call, sends the transfer once finished, and tells the turn', async () => {
    const { remote, notices, run } = await fixture()
    remote.state.newRecipient = true
    const call = {
      session: '41',
      callId: 'c1',
      taskId: 't1',
      connectionId: 'mercator',
      endpoint: MERCATOR.endpoint,
      name: 'create_job',
      arguments: job('3'),
    }
    const funding = await run(fundJob(call))
    expect(funding.kind).toBe('asked')
    expect(funding.kind === 'asked' && funding.result.details).toEqual({
      kind: 'url-required',
      requestId: 'mcp-url:41:c1',
      connectionId: 'mercator',
      name: 'create_job',
    })
    expect(await run(urlRequestView('mcp-url:41:c1'))).toMatchObject({
      connectionId: 'wallet',
      name: 'transfer',
      url: APPROVE,
      state: 'pending',
    })
    expect(remote.jobs).toEqual([])
    remote.state.approved = true
    const told: { text: string; outcome: McpOutcome }[] = []
    const answered = await run(
      answerUrlRequest({
        id: 'mcp-url:41:c1',
        action: 'accept',
        continue: (_session, { text, outcome }) => Effect.sync(() => void told.push({ text, outcome })),
      }),
    )
    expect(answered.state).toBe('completed')
    expect(remote.transfers.map(({ answered: given }) => given)).toEqual([false, true])
    expect(told[0]?.text).toContain('top-up of "Mercator" (mercator) went out')
    expect(told[0]?.text).toContain('create it again with the same arguments')
    expect(notices.map(({ title }) => title)).toEqual(['Moved $3.00 to Mercator from your Goblin Wallet'])
    expect(remote.jobs).toEqual([])
  })

  it('funds an approved job first and then sends it; one above the rule is not sent and the turn hears why', async () => {
    const { remote, approvals, grants, run } = await fixture()
    const version = grants.policy({ connectionId: 'mercator', capability: 'tool', name: 'create_job' })?.version ?? ''
    const hold = (callId: string, total: string, grantVersion = version) =>
      approvals.hold(
        {
          id: `mcp:41:${callId}`,
          caller: 'model',
          sessionId: '41',
          sourceCallId: callId,
          taskId: 't1',
          connectionId: 'mercator',
          name: 'create_job',
          arguments: job(total),
          endpoint: MERCATOR.endpoint,
          grantVersion,
        },
        Date.now(),
      )
    const told: string[] = []
    const decide = (id: string) =>
      run(decideApproval({ id, allowed: true, continue: (_s, { text }) => Effect.sync(() => void told.push(text)) }))
    await hold('c1', '3')
    expect((await decide('mcp:41:c1')).state).toBe('completed')
    expect(remote.transfers.map(({ args }) => args['amount'])).toEqual(['3'])
    expect(remote.jobs).toEqual([job('3')])
    expect(told.at(-1)).toContain('the held call returned')
    await hold('c2', '9')
    expect((await decide('mcp:41:c2')).state).toBe('failed')
    expect(told.at(-1)).toContain("above the owner's top-up rule")
    // A held call whose grant changed since it was reviewed moves no money.
    await hold('c3', '3', 'stale')
    expect((await decide('mcp:41:c3')).state).toBe('failed')
    expect(remote.transfers).toHaveLength(1)
    expect(remote.jobs).toHaveLength(1)
  })
})
