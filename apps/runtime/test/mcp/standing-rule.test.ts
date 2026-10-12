import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import { afterEach, describe, expect, it } from 'vitest'
import { ChatId } from '../../src/chats/directory.ts'
import { Chats, Conversations } from '../../src/chats/service.ts'
import type { AppError } from '../../src/http/errors.ts'
import type { AgentServices } from '../../src/layers/index.ts'
import { approvalsOver, spendingOver } from '../../src/layers/mcp.ts'
import { holdModelCall } from '../../src/mcp/approval-request.ts'
import { McpApprovalStore } from '../../src/mcp/approvals.ts'
import { CredentialCipher } from '../../src/mcp/cipher.ts'
import { Approvals, McpConnections, McpGrants, Resident, Spending } from '../../src/mcp/service.ts'
import { SpendStore } from '../../src/mcp/spend.ts'
import { RoutineRuns } from '../../src/routines/service.ts'
import { Changes, makeChanges } from '../../src/runtime/changes.ts'
import { scopeOf } from '../../src/setup/scope.ts'
import { Setups } from '../../src/setup/service.ts'
import { chatDatabase, durable } from '../chats-sqlite.ts'
import { stub } from '../http/api/fixture.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const close of cleanups.splice(0)) close()
})

const MERCATOR = { connectionId: 'mercator', endpoint: 'https://mercator.sh/mcp/auth' }

/**
 * The hold step of a model's call to Mercator's `create_job`, which the owner set to ask first: real approval and
 * spend stores, chat 41 acting and allowed everything, no routine run.
 */
const fixture = async () => {
  const { db, close } = chatDatabase()
  cleanups.push(close)
  const cipher = await CredentialCipher.fromBase64(btoa(String.fromCharCode(...new Uint8Array(32))))
  const spend = new SpendStore(durable(db))
  const layer = Layer.mergeAll(
    Layer.succeed(Approvals, approvalsOver(new McpApprovalStore(durable(db), cipher))),
    Layer.succeed(Spending, spendingOver(spend)),
    Layer.succeed(Changes, makeChanges()),
    stub(McpGrants, {
      policy: () => Effect.succeed(Option.some({ askFirst: true, version: 'v1' })),
    }),
    stub(McpConnections, { server: () => Effect.succeed(MERCATOR) }),
    stub(Resident, { require: () => Effect.void }),
    stub(RoutineRuns, { session: () => Effect.succeed(undefined) }),
    stub(Chats, { chatOf: () => Effect.succeed(Option.some(ChatId('41'))) }),
    stub(Conversations, { requireActing: (chat) => Effect.succeed(chat) }),
    stub(Setups, { scope: () => Effect.succeed(scopeOf([], true)) }),
  )
  const run = <A>(program: Effect.Effect<A, AppError, AgentServices>): Promise<A> =>
    // SAFETY: the hold step needs only the services provided here.
    Effect.runPromise(Effect.provide(program, layer) as Effect.Effect<A, AppError>)
  /** The model's call `callId` for a job of `total`, held as `mcp_call` holds it. */
  const hold = (callId: string, total: string) =>
    run(
      holdModelCall('41', callId, 't1', {
        connectionId: 'mercator',
        name: 'create_job',
        arguments: { plan: { nodes: [] }, idempotency_key: callId, approved_total: total },
      }),
    )
  return { spend, hold }
}

describe('a paid call under the owner’s spending rule (ADR 0044)', () => {
  it('asks first with no rule, and runs a job within the rule as approved by it, once however often it is held', async () => {
    const { spend, hold } = await fixture()
    expect((await hold('c1', '1.25'))?.state).toBe('pending')
    spend.setRule('mercator', 'create_job', { perJob: 5_000_000, daily: 6_000_000 }, Date.now())
    const first = await hold('c2', '4.50')
    expect(first?.state).toBe('approved')
    // Execution holds it again after the hook did: the same approval, counted once.
    expect((await hold('c2', '4.50'))?.id).toBe(first?.id)
    expect(spend.spentOn('mercator', 'create_job', new Date().toISOString().slice(0, 10))).toBe(4_500_000)
    // Past the day's total, or above the per-job limit, or with an amount that is not a plain decimal: it asks.
    expect((await hold('c3', '2'))?.state).toBe('pending')
    expect((await hold('c4', '5.01'))?.state).toBe('pending')
    expect((await hold('c5', '1e0'))?.state).toBe('pending')
  })
})
