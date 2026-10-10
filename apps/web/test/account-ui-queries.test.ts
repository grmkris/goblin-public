import type { ModelChoice, RoutineSettings, RoutineView } from '@goblin/contracts'
import { AgentGroup, InvalidInput, OwnerApi, OwnerAdmission, RoutinesGroup, ownerApiOf } from '@goblin/contracts/api'
import { MutationObserver, QueryObserver } from '@tanstack/react-query'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { chooseModelMutation, modelQuery } from '../src/agent/queries.ts'
import { owner } from '../src/lib/api.ts'
import { fakeHttpApi, testQueryClient } from '../src/lib/query/testing.ts'
import { changeRoutineMutation, routinesQuery } from '../src/routines/queries.ts'
import { unusedHandlers } from './query/unused-handlers.ts'

const OPTION = { route: 'Google', note: '', images: false, contextWindow: 1_000_000 }
const CHOICE: ModelChoice = {
  current: 'fast',
  default: 'fast',
  options: [
    { id: 'fast', label: 'Fast', ...OPTION },
    { id: 'deep', label: 'Deep', ...OPTION },
  ],
}
const SETTINGS: RoutineSettings = { timezone: 'UTC', maxActive: 20, maxRunning: 2 }
const ROUTINE: RoutineView = {
  id: 'rt_daily',
  revision: 1,
  state: 'proposed',
  definition: {
    title: 'Daily',
    prompt: 'Summarize the day.',
    timezone: 'UTC',
    trigger: { kind: 'cron', expression: '0 8 * * *' },
    notifyTelegram: false,
    allowedTools: [],
    budget: { tokensPerRun: 25_000, tokensPerDay: 50_000, runtimeSeconds: 900 },
  },
  confirmedAt: null,
  nextFireAt: null,
  lastFireAt: null,
  missedCount: 0,
  suppressedCount: 0,
  health: null,
  createdAt: 1,
  updatedAt: 1,
}

/** The real agent and routines groups served in memory, over one model choice and one routine. */
const fakeOwner = () => {
  const operations: string[] = []
  const state = { choice: CHOICE, routine: ROUTINE, operations }
  const Agent = HttpApiBuilder.group(OwnerApi, 'agent', (handlers) =>
    handlers.handleAll({
      ...unusedHandlers(OwnerApi.groups.agent),
      model: () => Effect.succeed(state.choice),
      chooseModel: ({ payload }) => {
        if (!state.choice.options.some((option) => option.id === payload.model))
          return Effect.fail(new InvalidInput({ reason: 'model_not_offered' }))
        state.choice = { ...state.choice, current: payload.model }
        return Effect.succeed(state.choice)
      },
    }),
  )
  const Routines = HttpApiBuilder.group(OwnerApi, 'routines', (handlers) =>
    handlers.handleAll({
      ...unusedHandlers(OwnerApi.groups.routines),
      list: () => Effect.succeed({ routines: [state.routine] }),
      settings: () => Effect.succeed(SETTINGS),
      confirm: ({ payload }) => {
        state.operations.push(payload.operationId)
        state.routine = { ...state.routine, state: 'active', revision: payload.revision + 1 }
        return Effect.succeed(state.routine)
      },
    }),
  )
  const gate = Layer.succeed(
    OwnerAdmission,
    OwnerAdmission.of((handler) => handler),
  )
  const server = fakeHttpApi(
    ownerApiOf(AgentGroup, RoutinesGroup),
    Layer.mergeAll(Agent, Routines).pipe(Layer.provide(gate)),
  )
  return {
    ...server,
    state,
    reset: () => {
      state.choice = CHOICE
      state.routine = ROUTINE
      state.operations = []
      server.calls.length = 0
    },
  }
}

const fake = fakeOwner()
beforeAll(() => {
  vi.stubGlobal('location', new URL('http://app.test/'))
  vi.stubGlobal('fetch', fake.fetch)
})
beforeEach(() => fake.reset())
afterAll(async () => {
  vi.unstubAllGlobals()
  await owner.runtime.dispose()
  await fake.dispose()
})

describe('the model pick', () => {
  it("keeps the agent's answer in the cache", async () => {
    const client = testQueryClient()
    await client.query(modelQuery)
    const pick = new MutationObserver(client, chooseModelMutation(client))
    await pick.mutate('deep')
    expect(client.getQueryData(modelQuery.queryKey)).toEqual({ ...CHOICE, current: 'deep' })
  })

  it('puts the previous model back when the agent refuses the pick', async () => {
    const client = testQueryClient()
    await client.query(modelQuery)
    const pick = new MutationObserver(client, chooseModelMutation(client))
    await expect(pick.mutate('retired')).rejects.toBeInstanceOf(InvalidInput)
    expect(client.getQueryData(modelQuery.queryKey)?.current).toBe('fast')
  })
})

describe('a routine change', () => {
  it('runs as its operation and settles once the list is fresh', async () => {
    const client = testQueryClient()
    const list = new QueryObserver(client, routinesQuery)
    const unsubscribe = list.subscribe(() => undefined)
    try {
      await vi.waitFor(() => expect(list.getCurrentResult().data?.routines[0]?.state).toBe('proposed'))
      const change = new MutationObserver(client, changeRoutineMutation(client))
      await change.mutate({ action: 'confirm', id: ROUTINE.id, revision: 1, operationId: 'op-confirm-1' })
      expect(list.getCurrentResult().data?.routines[0]).toMatchObject({ state: 'active', revision: 2 })
      expect(fake.state.operations).toEqual(['op-confirm-1'])
      const confirm = fake.calls.find((call) => call.url.endsWith('/api/routines/rt_daily/confirm'))
      expect(confirm?.headers.get('x-goblin-operation')).toBe('op-confirm-1')
      expect(confirm?.headers.get('x-goblin-csrf')).toBe('1')
    } finally {
      unsubscribe()
    }
  })
})
