import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Test from 'alchemy/Test/Vitest'
import * as Effect from 'effect/Effect'
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Config from 'effect/Config'
import Stack from './stack.ts'
import { homeCase } from './native-home.ts'

const harness = Test.make({
  providers: Cloudflare.providers(),
  state: Alchemy.localState(),
  stage: 'test_native_home',
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
            ConfigProvider.fromUnknown({ GOBLIN_HARNESS_PORT: port + 40 }).pipe(
              ConfigProvider.orElse(ConfigProvider.fromEnv()),
            ),
          ),
        ),
      )
  }),
)
harness.test(
  'local workerd: Home layout receipts, bounds, authority and reconstruction',
  stack.pipe(Effect.flatMap(({ url }) => homeCase(url))),
)
