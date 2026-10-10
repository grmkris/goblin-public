import { assert, describe, it } from '@effect/vitest'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import { NotFound } from '../src/http/errors.ts'
import { bound, promiseWith, syncWith } from '../src/runtime/boundary.ts'

class Greeting extends Context.Service<Greeting, { readonly word: string }>()('test/boundary/Greeting') {}

const context = Context.make(Greeting, { word: 'hello' })

describe('runtime boundary', () => {
  it('syncWith runs an Effect to its value on the caller stack, with the captured services', () => {
    const value = syncWith(context)(Greeting.use((greeting) => Effect.succeed(greeting.word)))
    assert.strictEqual(value, 'hello')
  })

  it('promiseWith resolves with the value, with the captured services', async () => {
    const value = await promiseWith(context)(Greeting.use((greeting) => Effect.succeed(`${greeting.word}!`)))
    assert.strictEqual(value, 'hello!')
  })

  it('promiseWith rejects with the typed failure itself, so it crosses foreign code unchanged', async () => {
    const failure = new NotFound({ what: 'server x' })
    const rejected = await promiseWith(context)(Effect.fail(failure)).then(
      () => assert.fail('resolved'),
      (cause: unknown) => cause,
    )
    assert.strictEqual(rejected, failure)
    assert.instanceOf(rejected, NotFound)
  })

  it('promiseWith rejects with a defect as it was thrown', async () => {
    const defect = new RangeError('boom')
    const rejected = await promiseWith(context)(Effect.die(defect)).then(
      () => assert.fail('resolved'),
      (cause: unknown) => cause,
    )
    assert.strictEqual(rejected, defect)
  })

  it('bound keeps the services of the program that made it, so Promise code runs it with none', async () => {
    const check = Effect.runSync(
      bound(Greeting.use((greeting) => Effect.succeed(greeting.word))).pipe(
        Effect.provideService(Greeting, { word: 'kept' }),
      ),
    )
    assert.strictEqual(await promiseWith(Context.empty())(check), 'kept')
  })
})
