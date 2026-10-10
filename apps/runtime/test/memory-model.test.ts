import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { afterEach, describe, expect, it } from 'vitest'
import { appAnswer } from '../src/agent-apps/completion.ts'
import { AppCodeError, problemText } from '../src/agent-apps/queue.ts'
import { usageMilliCredits, utcDay } from '../src/budget.ts'
import { CheapModelsLive } from '../src/layers/knowledge.ts'
import { CheapModel, CheapModels, ModelFailed, modelFailureText } from '../src/memory/model.ts'
import { Db } from '../src/runtime/db.ts'
import { AgentInput, type AgentInputs } from '../src/runtime/input.ts'
import { chatDatabase } from './chats-sqlite.ts'

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

/** The offered models as the cheap model reads them: `fixture` is offered, and every call answers `reply`. */
const cheap = (reply: { readonly stopReason: string; readonly errorMessage?: string }, id = 'fixture') =>
  new CheapModel(
    // SAFETY: the cheap model calls only `getModel` and `completeSimple`, both answered here.
    {
      getModel: (_provider: string, wanted: string) => (wanted === 'fixture' ? { id: wanted } : undefined),
      completeSimple: async () => ({ content: [], usage, ...reply }),
    } as never,
    id,
    () => undefined,
  )

const failureOf = async (model: CheapModel): Promise<unknown> =>
  model.complete('system', 'user', 10).then(
    () => undefined,
    (error: unknown) => error,
  )

describe('the cheap model (unit)', () => {
  it('fails with ModelFailed, and its text is the one a failure always had', async () => {
    const missing = await failureOf(cheap({ stopReason: 'stop' }, 'gone'))
    expect(missing).toMatchObject({ _tag: 'ModelFailed', model: 'gone', reason: 'not_offered' })
    const provider = await failureOf(cheap({ stopReason: 'error', errorMessage: 'HTTP 429 rate limited' }))
    expect(provider).toMatchObject({ _tag: 'ModelFailed', reason: 'error', detail: 'HTTP 429 rate limited' })
    const cut = await failureOf(cheap({ stopReason: 'aborted' }))
    expect(cut).toMatchObject({ _tag: 'ModelFailed', reason: 'aborted' })
    expect(
      [missing, provider, cut].map((failure) => failure instanceof ModelFailed && modelFailureText(failure)),
    ).toEqual(['Memory model gone is not offered', 'HTTP 429 rate limited', 'Memory model aborted'])
  })

  it("reaches an agent app's llm() as the same text it always read", async () => {
    const model = cheap({ stopReason: 'error', errorMessage: 'HTTP 429 rate limited' })
    const failure = await appAnswer(model.complete('system', 'prompt', 10)).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(AppCodeError)
    expect(problemText(failure)).toBe('HTTP 429 rate limited')
    expect(failure).not.toBeInstanceOf(ModelFailed)
  })
})

const closes: (() => void)[] = []
afterEach(() => {
  for (const close of closes.splice(0)) close()
})

describe('the cheap models the agent starts with (unit)', () => {
  it("count each purpose's tokens in the daily budget's usage ledger, with no Budget service", async () => {
    const { db, close } = chatDatabase()
    closes.push(close)
    // The cheap models read only these from the instance input; the model answers as `cheap` above does.
    const input: AgentInputs = Object.assign(Object.create(null), {
      env: { MODELS: 'fixture', MODEL_ID: 'fixture', MEMORY_MODEL: 'fixture' },
      pi: {
        models: {
          getModel: (_provider: string, wanted: string) => ({ id: wanted }),
          completeSimple: async () => ({ content: [{ type: 'text', text: 'named' }], usage, stopReason: 'stop' }),
        },
      },
    })
    const services = CheapModelsLive.pipe(
      // SAFETY: node:sqlite's Drizzle driver runs the same synchronous query builder as the Durable Object's.
      Layer.provide(Layer.mergeAll(Layer.succeed(AgentInput, input), Layer.succeed(Db, db as never))),
    )
    const models = await Effect.runPromise(
      Effect.provide(
        CheapModels.useSync((make) => make),
        services,
      ),
    )
    expect(await models('naming').complete('system', 'user', 10)).toBe('named')
    const { day } = utcDay(Math.floor(Date.now() / 1000))
    // SAFETY: as above.
    expect(usageMilliCredits(db as never, day)).toBeGreaterThan(0)
  })
})
