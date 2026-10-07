import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Test from 'alchemy/Test/Vitest'
import { Config, ConfigProvider, Effect, Schema } from 'effect'
import { nextInt } from 'effect/Random'
import { expect } from 'vitest'
import Stack from './stack.ts'

const harness = Test.make({
  providers: Cloudflare.providers(),
  state: Alchemy.localState(),
  stage: 'test_native_code_recovery',
  dev: true,
})
const stack = harness.beforeAll(
  Effect.gen(function* () {
    const port = yield* Config.Port('GOBLIN_HARNESS_PORT')
    return yield* harness
      .deploy(Stack)
      .pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({ GOBLIN_HARNESS_PORT: port + 60 }).pipe(
              ConfigProvider.orElse(ConfigProvider.fromEnv()),
            ),
          ),
        ),
      )
  }),
)
const Written = Schema.Struct({ instance: Schema.String, text: Schema.String })
const Recovered = Schema.Struct({ ...Written.fields, result: Schema.Struct({ text: Schema.optional(Schema.String) }) })

harness.test(
  'local workerd: interrupted code_run never replays a committed file write',
  Effect.gen(function* () {
    const { url } = yield* stack
    const name = `code-recovery-${yield* nextInt}`
    // Eviction deliberately closes a socket. These lifecycle probes each use a fresh connection.
    const get = (path: string) =>
      fetch(`${url.replace(/\/+$/u, '')}/${path}?name=${name}`, { headers: { connection: 'close' } })
    const first = yield* Schema.decodeUnknownEffect(Written)(
      yield* Effect.promise(() => get('code-recovery-write').then((r) => r.json())),
    )
    expect(first.text).toBe('x')
    yield* Effect.promise(() =>
      get('routine-evict').then(
        () => undefined,
        () => undefined,
      ),
    )
    const after = yield* Schema.decodeUnknownEffect(Recovered)(
      yield* Effect.promise(() => get('code-recovery-read').then((r) => r.json())),
    )
    expect(after.instance).not.toBe(first.instance)
    expect(after.text).toBe('x')
    expect(after.result.text).toContain('interrupted')
  }),
)
