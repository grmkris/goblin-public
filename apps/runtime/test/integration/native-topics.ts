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

/**
 * A routine the agent proposes in a Topic's Conversation belongs to that Topic (ADR 0032): its run sits under that
 * Conversation and its report lands there, never in Personal.
 */
export async function topicRoutineSequence(agent: Probe): Promise<Response> {
  const created = await agent.createTopic({ name: 'Errands', operationId: 'topic-routine' })
  if (!created.ok) return Response.json({ created })
  const errands = created.value.conversation
  const definition = {
    title: 'Errand check',
    prompt: 'Return a short reminder.',
    timezone: 'UTC',
    trigger: { kind: 'once', at: new Date(Date.now() + 3_600_000).toISOString() },
    notifyTelegram: false,
    allowedTools: [],
    budget: { tokensPerRun: 1000, tokensPerDay: 2000, runtimeSeconds: 60 },
  }
  await exchange(agent, errands, `call routine_propose ${JSON.stringify(definition)}`, 'topic-routine-propose')
  const listed = await agent.routines()
  const routine = listed.ok ? listed.value.routines.find((each) => each.definition.title === 'Errand check') : undefined
  if (routine === undefined) return Response.json({ listed })
  await agent.routineChange(routine.id, { revision: 1, operationId: 'topic-routine-confirm' }, 'confirm')
  await agent.routineRun(routine.id, { revision: 1, operationId: 'topic-routine-run', confirmRun: true })
  const runs = async () => {
    const page = await agent.routineRuns(routine.id)
    return page.ok ? page.value.runs : []
  }
  await until(runs, (each) => each.some((run) => run.state === 'completed'))
  await agent.routinesWake()
  const reported = await until(runs, (each) => each.some((run) => run.reportAcceptedAt !== null))
  const views = await agent.conversations()
  return Response.json({
    topic: created.value.id,
    errands,
    reported: reported.some((run) => run.reportAcceptedAt !== null),
    runChat: (views.ok ? views.value : []).find((view) => view.title === 'Errand check') ?? null,
    errandsLines: await transcript(agent, errands),
    personalLines: await transcript(agent, PRIMARY_CHAT),
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

const TopicRoutineRun = Schema.Struct({
  topic: Schema.Number,
  errands: Schema.String,
  reported: Schema.Boolean,
  runChat: Schema.Struct({ parent: Schema.optional(Schema.String), topic: Schema.optional(Schema.Number) }),
  errandsLines: Schema.Array(Schema.String),
  personalLines: Schema.Array(Schema.String),
})

/** Runs one probe sequence of the native worker on a fresh agent and decodes its answer. */
const probe = <A>(url: string, path: string, schema: Schema.Decoder<A>) =>
  Effect.gen(function* () {
    const name = `${path}-${yield* nextInt}`
    const response = yield* Effect.promise(() =>
      fetch(`${url.replace(/\/+$/u, '')}/${path}?name=${name}`, { headers: { connection: 'close' } }),
    )
    return yield* Schema.decodeUnknownEffect(schema)(yield* Effect.promise(() => response.json()))
  })

/** The native Topic cases: two Topics remember apart, and a Topic's routine reports to its own Conversation. */
export const topicsNativeCase = (url: string) =>
  Effect.gen(function* () {
    const result = yield* probe(url, 'topic-memory', TopicMemoryRun)
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
    const routine = yield* probe(url, 'topic-routine', TopicRoutineRun)
    expect(routine.reported).toBe(true)
    expect(routine.runChat).toMatchObject({ parent: routine.errands, topic: routine.topic })
    expect(routine.errandsLines.some((line) => line.startsWith('app.routine'))).toBe(true)
    expect(routine.personalLines.some((line) => line.startsWith('app.routine'))).toBe(false)
  })
