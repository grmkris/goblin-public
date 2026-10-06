import type { AssistantMessage, Message } from '@earendil-works/pi-ai'
import type { EntryRecord } from '@earendil-works/pi-durable'
import { authorTag, TELEGRAM_AUTHOR } from '@goblin/contracts'
import { RunAttribute, type RunEvent } from '@goblin/contracts/telemetry'
import { describe, expect, it } from 'vitest'
import { inspectEntry, summarize } from '../src/inspect/inspector.ts'
import { conversationId, entryId } from '../src/pi/context.ts'

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
