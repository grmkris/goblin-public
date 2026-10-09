import { PRIMARY_CHAT } from '@goblin/contracts'
import { Effect, Schema } from 'effect'
import { nextInt } from 'effect/Random'
import { expect } from 'vitest'
import { ModelRequest, requestTurns } from './conversation-checks.ts'
import { exchange, linesOf, snapshotOf, transcript, until } from './probe-reads.ts'
import type { PersonalAgentProbe } from './worker.ts'

type Probe = DurableObjectStub<PersonalAgentProbe>

const status = async (agent: Probe, chat: string) => {
  const result = await agent.memoryStatus(chat)
  return result.ok ? result.value : { messages: -1, summarized: -1 }
}

/**
 * Two Topics remember apart (ADR 0032): a new Topic's Conversation gets its own memory, its builder places the view
 * only there, Personal's memory holds only Personal's messages, and a thread reports its Conversation's memory.
 */
export async function topicMemorySequence(agent: Probe): Promise<Response> {
  const created = await agent.createTopic({ name: 'Garden', operationId: 'topic-memory' })
  if (!created.ok) return Response.json({ created })
  const garden = created.value.conversation
  await exchange(agent, garden, 'garden alpha', 'topic-memory-1')
  await exchange(agent, garden, 'garden beta', 'topic-memory-2')
  await exchange(agent, PRIMARY_CHAT, 'personal gamma', 'topic-memory-3')
  const remembered = await until(
    async () => status(agent, garden),
    ({ summarized }) => summarized >= 2,
  )
  await exchange(agent, garden, 'what grows here?', 'topic-memory-4')
  const thread = await agent.createConversation({ topic: created.value.id })
  return Response.json({
    garden: remembered,
    personal: await status(agent, PRIMARY_CHAT),
    thread: thread.ok ? await status(agent, thread.value.id) : null,
    request: await agent.requestFor('what grows here?'),
    view: (await snapshotOf(agent, garden)).entries?.[0]?.kind,
    personalLines: await transcript(agent, PRIMARY_CHAT),
    gardenLines: linesOf((await snapshotOf(agent, garden)).entries ?? []),
  })
}

const Status = Schema.Struct({ messages: Schema.Number, summarized: Schema.Number })
const TopicMemoryRun = Schema.Struct({
  garden: Status,
  personal: Status,
  thread: Status,
  request: ModelRequest,
  view: Schema.String,
  personalLines: Schema.Array(Schema.String),
  gardenLines: Schema.Array(Schema.String),
})

/** The native case over `topicMemorySequence`. */
export const topicMemoryCase = (url: string) =>
  Effect.gen(function* () {
    const name = `topic-memory-${yield* nextInt}`
    const response = yield* Effect.promise(() =>
      fetch(`${url.replace(/\/+$/u, '')}/topic-memory?name=${name}`, { headers: { connection: 'close' } }),
    )
    const result = yield* Schema.decodeUnknownEffect(TopicMemoryRun)(yield* Effect.promise(() => response.json()))
    expect(result.garden.summarized).toBeGreaterThanOrEqual(2)
    expect(result.thread.messages).toBeGreaterThanOrEqual(result.garden.messages)
    expect(requestTurns(result.request)).toEqual([
      '<memory>\n0+1|user: garden alpha\n1+1|talk: echo: garden alpha\n</memory>',
      'garden beta',
      'echo: garden beta',
      'what grows here?',
    ])
    expect(result.view).toBe('app.memory')
    // Personal remembers only its own exchange, and no view of the Garden reaches it.
    expect(result.personal).toEqual({ messages: 2, summarized: 0 })
    expect(result.personalLines.join('\n')).not.toContain('garden')
    expect(result.personalLines.some((line) => line.startsWith('app.memory'))).toBe(false)
    expect(result.gardenLines.join('\n')).not.toContain('personal gamma')
  })
