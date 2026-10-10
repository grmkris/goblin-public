import { PRIMARY_CHAT } from '@goblin/contracts'
import { Effect, Option, Schema } from 'effect'
import { expect } from 'vitest'
import { callOwner } from '../owner-client.ts'
import { ModelRequest, Settled, requestTurns } from './conversation-checks.ts'
import { type NativeCase, probeOf } from './native-case.ts'
import { type Probes, type ProbeStub, inWorker } from './probe.ts'
import { exchange, historyOf, linesOf, ownerResult, ownerSend, snapshotOf } from './probe-reads.ts'
import { until } from './until.ts'

const ViewData = Schema.Struct({ through: Schema.Number })
const throughOf = (data: unknown): number | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(ViewData)(data))?.through

/**
 * Personal's memory placed while the owner sends (K1). After two exchanges the builder places a view (the stack folds
 * after every turn), and the owner sends twice at once while it builds and places the next ones. The probe answers
 * what the sends got, Personal's memory once it has caught up, and its entries in order: each turn's lines and the
 * views between them with how far each reaches.
 */
async function memoryPlacementSequence(agent: ProbeStub) {
  await exchange(agent, PRIMARY_CHAT, 'place alpha', 'placement-1')
  await exchange(agent, PRIMARY_CHAT, 'place beta', 'placement-2')
  const sent = await Promise.all([
    ownerSend(agent, PRIMARY_CHAT, 'place gamma', 'placement-3'),
    ownerSend(agent, PRIMARY_CHAT, 'place delta', 'placement-4'),
  ])
  for (const operation of ['placement-3', 'placement-4']) await agent.settle(PRIMARY_CHAT, operation)
  const memory = await until(
    async () => {
      const status = await ownerResult(agent, (api) => api.memory.status({ query: {} }))
      return status.ok ? status.value : { messages: -1, summarized: -1 }
    },
    // Four exchanges are eight messages; the newest view reaches the last input, message 6.
    ({ messages, summarized }) => messages >= 8 && summarized >= 6,
  )
  const entries = (await historyOf(agent, PRIMARY_CHAT)).entries ?? []
  return {
    sent: sent.map((result) => result.ok),
    memory,
    turns: entries.flatMap((entry) =>
      entry.kind === 'app.memory'
        ? [`view ${throughOf(entry.data) ?? '?'}`]
        : entry.kind === 'pi.user' || entry.kind === 'pi.assistant'
          ? linesOf([entry])
          : [],
    ),
  }
}

/**
 * Main remembers: after two turns the builder places a view of the first, so the next request reads the view, then
 * the second turn verbatim; `zoom` opens a line of it, and the history route still serves what the view replaced.
 */
async function memorySequence(agent: ProbeStub) {
  await exchange(agent, PRIMARY_CHAT, 'remember alpha', 'memory-1')
  await exchange(agent, PRIMARY_CHAT, 'remember beta', 'memory-2')
  const summarized = await until(
    async () =>
      callOwner(agent, (api) =>
        api.memory.status({ query: {} }).pipe(
          Effect.map((status) => status.summarized),
          // expected: until polls again; a failed read counts as nothing summarized yet
          Effect.orElseSucceed(() => 0),
        ),
      ),
    (count) => count >= 2,
  )
  await exchange(agent, PRIMARY_CHAT, 'what do you remember?', 'memory-3')
  const zoomed = await exchange(agent, PRIMARY_CHAT, 'call zoom {"id":0,"n":1}', 'memory-4')
  const view = (await snapshotOf(agent, PRIMARY_CHAT)).entries?.[0]
  return {
    summarized,
    request: await agent.requestFor('what do you remember?'),
    zoomed,
    view: view?.kind,
    earlier: linesOf((await historyOf(agent, PRIMARY_CHAT, view?.head)).entries ?? []),
  }
}

export const probes: Probes = {
  memory: inWorker(({ agent }) => memorySequence(agent)),
  'memory-placement': inWorker(({ agent }) => memoryPlacementSequence(agent)),
}

const PlacementRun = Schema.Struct({
  sent: Schema.Array(Schema.Boolean),
  memory: Schema.Struct({ messages: Schema.Number, summarized: Schema.Number }),
  turns: Schema.Array(Schema.String),
})

/**
 * A memory view placed while the owner sends lands between turns, once per placement (K1): both sends are admitted
 * and answered, every input appears once, no view sits between an input and its answer, and the views reach further
 * each time.
 */
async function placementChecks(base: string): Promise<void> {
  const result = await probeOf(base, 'memory-placement', PlacementRun)
  expect(result.sent).toEqual([true, true])
  expect(result.memory.messages).toBeGreaterThanOrEqual(8)
  expect(result.memory.summarized).toBeGreaterThanOrEqual(6)
  const lines = result.turns.filter((line) => !line.startsWith('view '))
  const inputs = lines.filter((line) => line.startsWith('pi.user'))
  expect(inputs.toSorted()).toEqual(
    ['alpha', 'beta', 'delta', 'gamma'].map((word) => `pi.user: ${JSON.stringify(`place ${word}`)}`),
  )
  // Every input is answered, and a view never lands inside a turn: never right after an input, before its answer.
  for (const word of ['alpha', 'beta', 'gamma', 'delta'])
    expect(lines.some((line) => line.startsWith('pi.assistant') && line.includes(`echo: place ${word}`))).toBe(true)
  result.turns.forEach((line, at) => {
    if (line.startsWith('pi.user')) expect(result.turns[at + 1] ?? '').not.toMatch(/^view /u)
  })
  const views = result.turns.filter((line) => line.startsWith('view ')).map((line) => Number(line.slice(5)))
  expect(views.length).toBeGreaterThan(0)
  expect(views).toEqual([...new Set(views)].toSorted((a, b) => a - b))
}

const MemoryRun = Schema.Struct({
  summarized: Schema.Number,
  request: ModelRequest,
  zoomed: Settled,
  view: Schema.String,
  earlier: Schema.Array(Schema.String),
})

export const cases: readonly NativeCase[] = [
  {
    // Messages are short here, so each is its own summary line, word for word (no model call).
    title: 'main reads its earlier turns as a memory view and zooms into it',
    run: async (base) => {
      const result = await probeOf(base, 'memory', MemoryRun)
      expect(result.summarized).toBeGreaterThanOrEqual(2)
      expect(requestTurns(result.request)).toEqual([
        '<memory>\n0+1|user: remember alpha\n1+1|talk: echo: remember alpha\n</memory>',
        'remember beta',
        'echo: remember beta',
        'what do you remember?',
      ])
      expect(result.request.tools).toContain('zoom')
      expect(result.zoomed.text).toBe('done: 0+1|user: remember alpha')
      expect(result.view).toBe('app.memory')
      expect(result.earlier).toContain('pi.user: "remember alpha"')
    },
  },
  { title: 'memory views placed during sends land between turns (K1)', run: placementChecks },
]
