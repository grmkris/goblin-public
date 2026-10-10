import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Test from 'alchemy/Test/Vitest'
import { Config, ConfigProvider, Effect, Schema } from 'effect'
import { expect } from 'vitest'
import { evict, freshName, probeOf } from './native-case.ts'
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
    const base = url.replace(/\/+$/u, '')
    const name = freshName('code-recovery')
    const first = yield* Effect.promise(() => probeOf(base, 'code-recovery-write', Written, name))
    expect(first.text).toBe('x')
    // Eviction deliberately closes a socket; every probe request uses a fresh connection.
    yield* Effect.promise(() => evict(base, name))
    const after = yield* Effect.promise(() => probeOf(base, 'code-recovery-read', Recovered, name))
    expect(after.instance).not.toBe(first.instance)
    expect(after.text).toBe('x')
    expect(after.result.text).toContain('interrupted')
  }),
)
