import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Test from 'alchemy/Test/Vitest'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as Config from 'effect/Config'
import * as ConfigProvider from 'effect/ConfigProvider'
import { writeFileSync } from 'node:fs'
import { expect } from 'vitest'
import Stack from './stack.ts'

const harness = Test.make({
  providers: Cloudflare.providers(),
  state: Alchemy.localState(),
  stage: 'test_native_inbox',
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
            ConfigProvider.fromUnknown({ GOBLIN_HARNESS_PORT: port + 50 }).pipe(
              ConfigProvider.orElse(ConfigProvider.fromEnv()),
            ),
          ),
        ),
      )
  }),
)
const Snapshot = Schema.Struct({
  revision: Schema.Number,
  release: Schema.String,
  state: Schema.Struct({
    messages: Schema.Array(Schema.Unknown),
    refreshedAt: Schema.NullOr(Schema.Number),
    error: Schema.optional(Schema.String),
  }),
})
const Proof = Schema.Struct({
  built: Schema.Literal('active'),
  calls: Schema.Number,
  first: Snapshot,
  refreshed: Snapshot,
  lastGood: Snapshot,
  job: Schema.Unknown,
  placed: Schema.Unknown,
  app: Schema.Unknown,
  launch: Schema.Unknown,
})

harness.test(
  'local workerd: inbox example refreshes on its 15-minute schedule and preserves last-good data',
  Effect.gen(function* () {
    const { url } = yield* stack
    const response = yield* Effect.promise(() =>
      fetch(`${url.replace(/\/+$/u, '')}/inbox-app?name=inbox-${Date.now()}`),
    )
    const raw: unknown = yield* Effect.promise(() => response.json())
    expect(response.status, JSON.stringify(raw)).toBe(200)
    const proof = yield* Schema.decodeUnknownEffect(Proof)(raw)
    expect(proof.calls).toBe(3)
    expect(proof.first.state.messages).toHaveLength(5)
    expect(proof.first.state.messages[0]).toMatchObject({ id: 'fixture-7' })
    expect(proof.refreshed.state.refreshedAt).toBeGreaterThan(proof.first.state.refreshedAt ?? 0)
    expect(proof.lastGood.state.messages).toEqual(proof.refreshed.state.messages)
    expect(proof.lastGood.state.refreshedAt).toBe(proof.refreshed.state.refreshedAt)
    expect(proof.lastGood.state.error).toContain('invalid list')
    expect(proof.job).toMatchObject({
      action: 'refresh',
      every: '15m',
      status: 'ok',
    })

    const receipt = yield* Config.String('GOBLIN_INBOX_RECEIPT').pipe(Config.withDefault(''))
    if (receipt !== '')
      writeFileSync(receipt, JSON.stringify({ environment: 'local-workerd-fixture', pass: true, ...proof }), {
        mode: 0o600,
      })
    expect(proof.placed).toMatchObject({
      kind: 'applied',
      layout: { tiles: [expect.objectContaining({ kind: 'app', placedBy: 'agent' })] },
    })
  }),
)
