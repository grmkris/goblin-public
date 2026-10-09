import { assert, describe, it } from '@effect/vitest'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Schema from 'effect/Schema'
import { makeChanges } from '../src/runtime/changes.ts'
import type { Instrument } from '../src/runtime/instrument.ts'

type Topics = {
  readonly 'chat.closed': { readonly id: string }
  readonly 'topic.renamed': number
}

class Refused extends Schema.TaggedError<Refused>()('Refused', {}) {}

describe('Changes bus (unit)', () => {
  it.effect('runs a topic’s handlers inline, in registration order', () =>
    Effect.gen(function* () {
      const changes = makeChanges<Topics>()
      const seen: string[] = []
      yield* changes.on('chat.closed', ({ id }) => Effect.sync(() => seen.push(`first ${id}`)))
      yield* changes.on('topic.renamed', (topic) => Effect.sync(() => seen.push(`topic ${String(topic)}`)))
      yield* changes.on('chat.closed', ({ id }) => Effect.sync(() => seen.push(`second ${id}`)))
      yield* changes.publish('chat.closed', { id: '7' })
      assert.deepStrictEqual(seen, ['first 7', 'second 7'])
      yield* changes.publish('topic.renamed', 3)
      assert.deepStrictEqual(seen, ['first 7', 'second 7', 'topic 3'])
    }),
  )

  it('publishes synchronously: no fiber or timer is involved', () => {
    const changes = makeChanges<Topics>()
    const seen: string[] = []
    Effect.runSync(changes.on('chat.closed', ({ id }) => Effect.sync(() => seen.push(id))))
    Effect.runSync(changes.publish('chat.closed', { id: '1' }))
    Effect.runSync(changes.publish('topic.renamed', 1))
    assert.deepStrictEqual(seen, ['1'])
  })

  it.effect('a failing handler ends only itself, and the instrument sees the failure', () =>
    Effect.gen(function* () {
      const reported: string[] = []
      const instrument: Instrument = (effect) =>
        Effect.tapCause(effect, (cause) => Effect.sync(() => reported.push(Cause.hasFails(cause) ? 'fail' : 'die')))
      const changes = makeChanges<Topics>(instrument)
      const seen: string[] = []
      yield* changes.on('chat.closed', () => Effect.fail(new Refused()))
      yield* changes.on('chat.closed', () => Effect.die(new Refused()))
      yield* changes.on('chat.closed', () => {
        throw new Refused()
      })
      yield* changes.on('chat.closed', ({ id }) => Effect.sync(() => seen.push(id)))
      yield* changes.publish('chat.closed', { id: '9' })
      assert.deepStrictEqual(seen, ['9'])
      assert.deepStrictEqual(reported, ['fail', 'die', 'die'])
    }),
  )

  it.effect('a handler added during a publish runs from the next publish', () =>
    Effect.gen(function* () {
      const changes = makeChanges<Topics>()
      const seen: string[] = []
      const late = ({ id }: { readonly id: string }) => Effect.sync(() => seen.push(`late ${id}`))
      yield* changes.on('chat.closed', () => changes.on('chat.closed', late))
      yield* changes.publish('chat.closed', { id: 'a' })
      assert.deepStrictEqual(seen, [])
      yield* changes.publish('chat.closed', { id: 'b' })
      assert.deepStrictEqual(seen, ['late b'])
    }),
  )

  it.effect('an interruption is not swallowed: it ends the publish', () =>
    Effect.gen(function* () {
      const changes = makeChanges<Topics>()
      const seen: string[] = []
      yield* changes.on('chat.closed', () => Effect.interrupt)
      yield* changes.on('chat.closed', ({ id }) => Effect.sync(() => seen.push(id)))
      const exit = yield* Effect.exit(changes.publish('chat.closed', { id: 'x' }))
      assert.isTrue(Exit.hasInterrupts(exit))
      assert.deepStrictEqual(seen, [])
    }),
  )
})
