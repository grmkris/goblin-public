import type { AssistantMessage, Message } from '@earendil-works/pi-ai'
import type { EntryRecord } from '@earendil-works/pi-durable'
import { authorTag, TELEGRAM_AUTHOR } from '@goblin/contracts'
import { RunAttribute, type FlowEvent, type RunEvent } from '@goblin/contracts/telemetry'
import { afterEach, describe, expect, it } from 'vitest'
import { Inspector, inspectEntry, summarize } from '../src/inspect/inspector.ts'
import { conversationId, entryId } from '../src/pi/context.ts'
import { flowRunEvent } from '../src/telemetry/events.ts'
import { RunLedger } from '../src/telemetry/ledger.ts'
import { chatDatabase } from './chats-sqlite.ts'

const usage = (input: number, output: number) => ({
  input,
  output,
  cacheRead: 3,
  cacheWrite: 0,
  totalTokens: input + output,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
})

const answer = (content: AssistantMessage['content']): AssistantMessage => ({
  role: 'assistant',
  content,
  api: 'test',
  provider: 'openai',
  model: 'gpt-test',
  usage: usage(120, 30),
  stopReason: 'toolUse',
  timestamp: 1000,
})

const entry = (kind: string, message: Message): EntryRecord => ({
  id: entryId(7),
  conversationId: conversationId('1'),
  kind,
  model: [message],
})

describe('inspectEntry', () => {
  it('names the author a tag block carries and keeps only the words', () => {
    const view = inspectEntry(
      entry('pi.user', {
        role: 'user',
        content: [
          { type: 'text', text: authorTag(TELEGRAM_AUTHOR) },
          { type: 'text', text: 'what is on today?' },
        ],
        timestamp: 500,
      }),
    )
    expect(view).toEqual({
      id: 7,
      kind: 'pi.user',
      role: 'user',
      author: TELEGRAM_AUTHOR,
      text: 'what is on today?',
      at: 500,
    })
  })

  it("keeps an answer's visible thinking and leaves redacted thinking out", () => {
    const view = inspectEntry(
      entry(
        'pi.assistant',
        answer([
          { type: 'thinking', thinking: ' Plan the app first. ' },
          { type: 'thinking', thinking: 'opaque', redacted: true },
          { type: 'text', text: 'Building it.' },
        ]),
      ),
    )
    expect(view).toMatchObject({ thinking: 'Plan the app first.', text: 'Building it.' })
    expect(view.truncated).toBeUndefined()
    const long = inspectEntry(entry('pi.assistant', answer([{ type: 'thinking', thinking: 'z'.repeat(5000) }])))
    expect(long.thinking).toHaveLength(4001)
    expect(long.truncated).toBe(true)
  })

  it('cuts long text and long arguments, and says so', () => {
    const view = inspectEntry(
      entry(
        'pi.assistant',
        answer([
          { type: 'text', text: 'x'.repeat(5000) },
          { type: 'toolCall', id: 'call-1', name: 'mcp_call', arguments: { body: 'y'.repeat(3000) } },
        ]),
      ),
    )
    expect(view.truncated).toBe(true)
    expect(view.text).toHaveLength(4001)
    expect(view.toolCalls?.[0]?.name).toBe('mcp_call')
    expect(view.toolCalls?.[0]?.arguments).toHaveLength(2001)
    expect(view.model).toEqual({
      provider: 'openai',
      model: 'gpt-test',
      stopReason: 'toolUse',
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 3,
    })
  })

  it('says which call a tool result answers and whether it failed', () => {
    const view = inspectEntry(
      entry('pi.tool-result', {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'mcp_call',
        content: [{ type: 'text', text: 'server refused' }],
        isError: true,
        timestamp: 2000,
      }),
    )
    expect(view).toMatchObject({ text: 'server refused', tool: { callId: 'call-1', name: 'mcp_call', isError: true } })
    expect(view.truncated).toBeUndefined()
  })

  it("keeps Pi's own data for an entry without a message", () => {
    const view = inspectEntry({ id: entryId(9), conversationId: conversationId('1'), kind: 'app.note', data: { a: 1 } })
    expect(view).toEqual({ id: 9, kind: 'app.note', data: '{"a":1}' })
  })
})

const event = (
  kind: RunEvent['kind'],
  status: RunEvent['status'],
  attributes: RunEvent['attributes'] = {},
): RunEvent => ({
  id: `${kind}:${status}:${JSON.stringify(attributes)}`,
  kind,
  status,
  operationId: 'op-1',
  conversationId: '1',
  startedAt: 10,
  endedAt: 20,
  attributes,
})

describe('summarize', () => {
  it('counts attempts, calls and failures, and sums tokens', () => {
    const turn = event('turn.submitted', 'error', {
      [RunAttribute.source]: 'telegram',
      [RunAttribute.reason]: 'model_error',
    })
    const summary = summarize(turn, [
      turn,
      event('model.attempt', 'error', { [RunAttribute.inputTokens]: 100 }),
      event('model.attempt', 'ok', { [RunAttribute.inputTokens]: 110, [RunAttribute.outputTokens]: 12 }),
      event('tool.call', 'blocked'),
      event('tool.call', 'ok'),
    ])
    expect(summary).toEqual({
      operationId: 'op-1',
      conversationId: '1',
      source: 'telegram',
      status: 'error',
      reason: 'model_error',
      startedAt: 10,
      endedAt: 20,
      modelAttempts: 2,
      failedAttempts: 1,
      toolCalls: 2,
      failedToolCalls: 1,
      inputTokens: 210,
      outputTokens: 12,
    })
  })
})

const closes: (() => void)[] = []
afterEach(() => {
  for (const close of closes.splice(0)) close()
})

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = 10 * DAY_MS

/** The inspector over a real ledger. Flows, and turns outside a conversation, read neither Pi nor the registry. */
const inspector = () => {
  const { db, close } = chatDatabase()
  closes.push(close)
  const ledger = new RunLedger(db)
  // SAFETY: nothing here lists conversations or reads Pi: flows are ledger rows, and the turns have no conversation.
  const unread = undefined as never
  return { ledger, inspect: new Inspector(ledger, unread, unread, () => NOW) }
}

const step = (flow: FlowEvent['flow'], chat: string, status: FlowEvent['status'] = 'ok'): FlowEvent => ({
  flow,
  via: 'app',
  actor: 'owner',
  chat,
  operationId: `op-${flow}-${chat}`,
  status,
  ms: 5,
})

describe('inspection of flows', () => {
  it('reads the last day of flow steps, newest first, with when each was recorded', () => {
    const { ledger, inspect } = inspector()
    ledger.ended(flowRunEvent(step('send', '1'), 'flow:old', NOW - 2 * DAY_MS))
    ledger.ended(flowRunEvent(step('reply', '12'), 'flow:1', NOW - 300))
    ledger.ended(flowRunEvent(step('move', '12', 'refused'), 'flow:2', NOW - 200))
    ledger.ended(event('turn.submitted', 'ok'))

    expect(inspect.flows({})).toEqual({
      since: NOW - DAY_MS,
      flows: [
        { ...step('move', '12', 'refused'), at: NOW - 200 },
        { ...step('reply', '12'), at: NOW - 300 },
      ],
    })
    expect(inspect.flows({ since: 0, limit: 1 }).flows.map((flow) => flow.flow)).toEqual(['move'])
  })

  it("filters by a chat's exact id and by flow", () => {
    const { ledger, inspect } = inspector()
    ledger.ended(flowRunEvent(step('reply', '12'), 'flow:1', NOW - 300))
    ledger.ended(flowRunEvent(step('reply', '123'), 'flow:2', NOW - 200))
    ledger.ended(flowRunEvent(step('move', '12'), 'flow:3', NOW - 100))

    expect(inspect.flows({ chat: '12' }).flows.map((flow) => flow.operationId)).toEqual(['op-move-12', 'op-reply-12'])
    expect(inspect.flows({ flow: 'reply' }).flows.map((flow) => flow.chat)).toEqual(['123', '12'])
    expect(inspect.flows({ chat: '12', flow: 'reply' }).flows).toHaveLength(1)
    expect(inspect.flows({ chat: '7' }).flows).toEqual([])
  })
})

describe('inspection of details', () => {
  it("gives a turn operation's timeline with no related operations yet", async () => {
    const { ledger, inspect } = inspector()
    const turn: RunEvent = {
      id: 'turn:op-1',
      kind: 'turn.submitted',
      status: 'ok',
      operationId: 'op-1',
      startedAt: 10,
      endedAt: 20,
      attributes: {},
    }
    ledger.ended(turn)
    const details = await inspect.run({ kind: 'details', operation: 'op-1' })
    expect(details).toMatchObject({ turn: { operationId: 'op-1', status: 'ok' }, events: [turn], related: [] })
  })

  it('refuses a query that names neither an operation nor a chat entry, and finds no entry operation yet', async () => {
    const { inspect } = inspector()
    await expect(inspect.run({ kind: 'details', chat: '12' })).rejects.toMatchObject({ _tag: 'InvalidInput' })
    await expect(inspect.run({ kind: 'details', chat: '12', entry: 4 })).rejects.toMatchObject({ _tag: 'NotFound' })
    await expect(inspect.run({ kind: 'details', operation: 'missing' })).rejects.toMatchObject({ _tag: 'NotFound' })
  })
})
