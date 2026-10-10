import { Attention, PRIMARY_CHAT } from '@goblin/contracts'
import { Effect, Result, Schema } from 'effect'
import { nextInt } from 'effect/Random'
import { expect } from 'vitest'
import { ModelRequest, requestTurns } from './conversation-checks.ts'
import { callOwner } from './owner-api.ts'
import {
  exchange,
  linesOf,
  ownerCreate,
  ownerResult,
  snapshotOf,
  transcript,
  until,
  workspaceConversations,
} from './probe-reads.ts'
import type { PersonalAgentProbe } from './worker.ts'

type Probe = DurableObjectStub<PersonalAgentProbe>

const status = async (agent: Probe, chat: string) => {
  const result = await ownerResult(agent, (api) => api.memory.status({ query: { chat } }))
  return result.ok ? result.value : { messages: -1, summarized: -1 }
}

/** A new Topic through the owner API, or the failure it answered (which the run's decode then shows). */
const createTopic = (agent: Probe, name: string, operationId: string) =>
  callOwner(agent, (api) => Effect.result(api.topics.create({ payload: { name, operationId } })))

/**
 * Two Topics remember apart (ADR 0032): a new Topic's Conversation gets its own memory, its builder places the view
 * only there, Personal's memory holds only Personal's messages, and a thread reports its Conversation's memory.
 */
export async function topicMemorySequence(agent: Probe): Promise<Response> {
  const created = await createTopic(agent, 'Garden', 'topic-memory')
  if (Result.isFailure(created)) return Response.json({ created: created.failure })
  const garden = created.success.conversation
  await exchange(agent, garden, 'garden alpha', 'topic-memory-1')
  await exchange(agent, garden, 'garden beta', 'topic-memory-2')
  await exchange(agent, PRIMARY_CHAT, 'personal gamma', 'topic-memory-3')
  const remembered = await until(
    async () => status(agent, garden),
    ({ summarized }) => summarized >= 2,
  )
  await exchange(agent, garden, 'what grows here?', 'topic-memory-4')
  const thread = await ownerCreate(agent, { topic: created.success.id })
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
  const created = await createTopic(agent, 'Errands', 'topic-routine')
  if (Result.isFailure(created)) return Response.json({ created: created.failure })
  const errands = created.success.conversation
  const attentionOf = async () => {
    const views = await workspaceConversations(agent)
    return views.find((view) => view.id === errands)?.attention ?? []
  }
  const question = { questions: [{ id: 'day', prompt: 'Which day suits you?', kind: 'text' }] }
  await exchange(agent, errands, `call ask_user ${JSON.stringify(question)}`, 'topic-ask')
  const asked = await attentionOf()
  await exchange(agent, errands, 'Tuesday', 'topic-answer')
  const answered = await attentionOf()
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
  const listed = await ownerResult(agent, (api) => api.routines.list())
  const routine = listed.ok ? listed.value.routines.find((each) => each.definition.title === 'Errand check') : undefined
  if (routine === undefined) return Response.json({ listed })
  const confirm = { revision: 1, operationId: 'topic-routine-confirm' }
  await ownerResult(agent, (api) => api.routines.confirm({ params: { id: routine.id }, payload: confirm }))
  const manual = { revision: 1, operationId: 'topic-routine-run', confirmRun: true } as const
  await ownerResult(agent, (api) => api.routines.run({ params: { id: routine.id }, payload: manual }))
  const runs = async () => {
    const page = await ownerResult(agent, (api) => api.routines.runs({ params: { id: routine.id } }))
    return page.ok ? page.value.runs : []
  }
  await until(runs, (each) => each.some((run) => run.state === 'completed'))
  await agent.routinesWake()
  const reported = await until(runs, (each) => each.some((run) => run.reportAcceptedAt !== null))
  const views = await workspaceConversations(agent)
  return Response.json({
    topic: created.success.id,
    errands,
    asked,
    answered,
    reported: reported.some((run) => run.reportAcceptedAt !== null),
    runChat: views.find((view) => view.title === 'Errand check') ?? null,
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
  asked: Schema.Array(Attention),
  answered: Schema.Array(Attention),
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
    // A question waits on the owner in its chat's attention until their next message answers it.
    expect(routine.asked).toEqual([
      { kind: 'question', since: expect.any(Number), entry: expect.any(Number), label: 'Which day suits you?' },
    ])
    expect(routine.answered).toEqual([])
    expect(routine.reported).toBe(true)
    expect(routine.runChat).toMatchObject({ parent: routine.errands, topic: routine.topic })
    expect(routine.errandsLines.some((line) => line.startsWith('app.routine'))).toBe(true)
    expect(routine.personalLines.some((line) => line.startsWith('app.routine'))).toBe(false)
  })
