import { describe, expect, it } from 'vitest'
import type { Part, ToolPart } from '../src/lib/parts.ts'
import { presenceOf } from '../src/lib/presence.ts'
import type { ConversationProjection } from '../src/lib/projection.ts'
import { BudgetExhausted } from '@goblin/contracts/api'
import { WALLET_NEEDED, messageOf } from '../src/lib/query/app-error.ts'

const projection = (extra: Partial<ConversationProjection> = {}): ConversationProjection => ({
  messages: [],
  entries: [],
  tools: [],
  running: false,
  partial: '',
  partialReasoning: '',
  partialBlocks: [],
  progress: '',
  inbox: [],
  queued: [],
  queueNotice: '',
  ...extra,
})
const running = (target?: { connectionId: string; name: string }): ToolPart => ({
  kind: 'tool',
  id: 'tool:c1',
  call: { id: 'c1', name: target ? 'mcp_call' : 'web_fetch', arguments: {} },
  ...(target && { target: { ...target, arguments: {} } }),
  state: 'running',
})
const failure = (stopped?: true): Part => ({
  kind: 'failure',
  id: 'f1',
  failure: { text: 'No answer', provider: false, ...(stopped && { stopped }) },
})
const base = { status: 'connected' as const, parts: [], waiting: 0, exhausted: false }

/** The owner's label for `myplan`; any other connection by its id. */
const named = (connectionId: string) => (connectionId === 'myplan' ? 'MyPlan · Work' : connectionId)

describe('the agent’s presence', () => {
  it('names a lost connection before anything the agent is doing', () => {
    expect(presenceOf({ ...base, status: 'reconnecting', projection: projection({ running: true }) })).toEqual({
      state: 'offline',
      label: 'Reconnecting…',
    })
    expect(presenceOf({ ...base, projection: undefined }).state).toBe('offline')
  })
  it('puts the owner’s open requests ahead of the run', () => {
    expect(presenceOf({ ...base, waiting: 1, projection: projection({ running: true }) })).toEqual({
      state: 'waiting',
      label: 'Waiting for you',
    })
  })
  it('follows the run: retrying, a tool by its server name, writing, thinking', () => {
    const live = projection({ running: true })
    expect(presenceOf({ ...base, projection: { ...live, progress: 'Waiting for model retry' } }).state).toBe('retrying')
    expect(
      presenceOf({ ...base, projection: live, parts: [running({ connectionId: 'myplan', name: 'open' })] }),
    ).toEqual({
      state: 'tool',
      label: 'Using myplan · open',
    })
    // The connection by the owner's label where one is known.
    expect(
      presenceOf({ ...base, projection: live, parts: [running({ connectionId: 'myplan', name: 'open' })], named })
        .label,
    ).toBe('Using MyPlan · Work · open')
    expect(presenceOf({ ...base, projection: live, parts: [running()] }).label).toBe('Using web_fetch')
    expect(presenceOf({ ...base, projection: { ...live, partial: 'Hel' } }).state).toBe('responding')
    expect(presenceOf({ ...base, projection: live }).state).toBe('thinking')
  })
  it('is thinking from the moment a message is sent, before the run has started', () => {
    const working: Part = { kind: 'working', id: 'working' }
    expect(presenceOf({ ...base, projection: projection(), parts: [working] })).toEqual({
      state: 'thinking',
      label: 'Thinking…',
    })
  })
  it('keeps pending work visible while idle, including after a failed run', () => {
    const pending = projection({ inbox: [{ id: 8, mode: 'followUp' }] })
    expect(presenceOf({ ...base, projection: pending })).toEqual({ state: 'waiting', label: '1 queued message' })
    expect(presenceOf({ ...base, projection: pending, parts: [failure()] })).toEqual({
      state: 'error',
      label: 'No answer',
    })
  })
  it('settles into how the last turn ended; stopping is not an error, a cut-off answer says so', () => {
    expect(presenceOf({ ...base, exhausted: true, projection: projection() }).state).toBe('exhausted')
    // A day with no allowance at all: the free plan waits for a funded Goblin Wallet (ADR 0047).
    expect(presenceOf({ ...base, exhausted: true, walletNeeded: true, projection: projection() }).label).toBe(
      'Needs a funded Goblin Wallet',
    )
    expect(presenceOf({ ...base, projection: projection(), parts: [failure()] }).state).toBe('error')
    expect(presenceOf({ ...base, projection: projection(), parts: [failure(true)] }).state).toBe('idle')
    const cutOff: Part = { kind: 'failure', id: 'f2', failure: { text: 'Cut off', provider: false, cutOff: true } }
    expect(presenceOf({ ...base, projection: projection(), parts: [cutOff] })).toEqual({
      state: 'error',
      label: 'Cut off',
    })
    expect(presenceOf({ ...base, projection: projection() })).toEqual({ state: 'idle', label: 'Ready' })
  })
})

describe('what a send refused for a wallet says (ADR 0047)', () => {
  it('points at the wallet and paying per call, not at a spent day', () => {
    expect(messageOf(new BudgetExhausted({ limit: 0, resetsAt: 86_400 }), 'send the message')).toBe(WALLET_NEEDED)
    expect(messageOf(new BudgetExhausted({ limit: 50, resetsAt: 86_400 }), 'send the message')).not.toBe(WALLET_NEEDED)
  })
})
