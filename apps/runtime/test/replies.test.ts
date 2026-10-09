import type { AssistantMessage, Message } from '@earendil-works/pi-ai'
import type { EntryRecord } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { conversationId, entryId } from '../src/pi/context.ts'
import { cutOff, replyStats } from '../src/pi/transcript.ts'
import { ReplyLedger } from '../src/replies.ts'

const MAIN = '1'
const THREAD = '7'

const NO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

/** The agent's message: `content` blocks at `at` seconds. */
const answer = (content: AssistantMessage['content'], at: number): AssistantMessage => ({
  role: 'assistant',
  content,
  api: 'test',
  provider: 'test',
  model: 'test',
  usage: NO_USAGE,
  stopReason: 'stop',
  timestamp: at * 1000,
})

/** One Pi entry of `session` holding one message. */
const entry = (id: number, session: string, kind: string, message: Message): EntryRecord => ({
  id: entryId(id),
  conversationId: conversationId(session),
  kind,
  model: [message],
})

const said = (id: number, session: string, role: 'user' | 'assistant', at: number) =>
  role === 'user'
    ? entry(id, session, 'pi.user', { role, content: 'hi', timestamp: at * 1000 })
    : entry(id, session, 'pi.assistant', answer([{ type: 'text', text: 'hi' }], at))

/** A conversation whose entries are `all`; it records the lowest id of each read. */
function conversationOf(all: EntryRecord[]) {
  const reads: number[] = []
  return {
    reads,
    entries: (query: { readonly minEntryId?: number }) => {
      const min = query.minEntryId ?? 0
      reads.push(min)
      return Promise.resolve({ items: all.filter((item) => Number(item.id) >= min).toReversed() })
    },
  }
}

describe('thread replies (unit)', () => {
  it('counts the messages of the owner and the agent, not tool traffic or messages without text', () => {
    const stats = replyStats([
      said(10, THREAD, 'user', 100),
      entry(11, THREAD, 'pi.assistant', answer([{ type: 'toolCall', id: 'c1', name: 'look', arguments: {} }], 101)),
      entry(12, THREAD, 'pi.tool', {
        role: 'toolResult',
        toolCallId: 'c1',
        toolName: 'look',
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
        timestamp: 102_000,
      }),
      said(13, THREAD, 'assistant', 103),
      entry(14, THREAD, 'app.memory', { role: 'user', content: 'memory', timestamp: 104_000 }),
    ])
    expect(stats).toEqual({ replies: 2, lastReplyAt: 103 })
    expect(replyStats([])).toEqual({ replies: 0 })
  })

  it('leaves out what a thread inherited from main and reads only what was written since the last count', async () => {
    const all = [said(3, MAIN, 'user', 10), said(4, MAIN, 'assistant', 11), said(20, THREAD, 'user', 50)]
    const conversation = conversationOf(all)
    const ledger = new ReplyLedger()
    expect(await ledger.stats(THREAD, conversation, 4)).toEqual({ replies: 1, lastReplyAt: 50, asks: [] })
    expect(await ledger.stats(THREAD, conversation, 4)).toEqual({ replies: 1, lastReplyAt: 50, asks: [] })
    all.push(said(21, THREAD, 'assistant', 60))
    expect(await ledger.stats(THREAD, conversation, 4)).toEqual({ replies: 2, lastReplyAt: 60, asks: [] })
    expect(conversation.reads).toEqual([5, 21, 21])
  })

  it('reports nothing for a thread nobody has written in yet', async () => {
    expect(await new ReplyLedger().stats(THREAD, conversationOf([]), 0)).toEqual({ replies: 0, asks: [] })
  })

  it('knows a turn whose last answer reached the output limit, and only the newest turn', () => {
    const limited = entry(5, MAIN, 'pi.assistant', {
      ...answer([{ type: 'text', text: 'The first ha' }], 12),
      stopReason: 'length',
    })
    expect(cutOff([said(4, MAIN, 'user', 11), limited])).toBe(true)
    expect(cutOff([said(4, MAIN, 'user', 11), said(5, MAIN, 'assistant', 12)])).toBe(false)
    expect(cutOff([said(4, MAIN, 'user', 11), limited, said(6, MAIN, 'user', 13)])).toBe(false)
    expect(cutOff([])).toBe(false)
  })
})
