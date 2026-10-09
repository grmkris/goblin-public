import { describe, expect, it } from 'vitest'
import { appAnswer } from '../src/agent-apps/live.ts'
import { AppCodeError, problemText } from '../src/agent-apps/queue.ts'
import { CheapModel, ModelFailed, modelFailureText } from '../src/memory/model.ts'

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
