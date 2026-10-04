import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Test from 'alchemy/Test/Vitest'
import * as Effect from 'effect/Effect'
import * as Config from 'effect/Config'
import { nextInt } from 'effect/Random'
import * as Schema from 'effect/Schema'
import { expect } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { URL as FileURL } from 'node:url'
import Stack from './stack.ts'

const harness = Test.make({
  providers: Cloudflare.providers(),
  state: Alchemy.localState(),
  stage: 'test_native_runtime',
  dev: true,
})
const stack = harness.beforeAll(harness.deploy(Stack))
const phase = await Effect.runPromise(
  Config.String('PURRABLE_NATIVE_LIFECYCLE_PHASE').pipe(
    Config.withDefault('same-process'),
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Literals(['same-process', 'write', 'read']))),
  ),
)
const Table = Schema.Struct({ name: Schema.String, definition: Schema.NullOr(Schema.String) })
const NativeResult = Schema.Struct({
  snapshot: Schema.Unknown,
  before: Schema.Array(Table),
  after: Schema.Array(Table),
  metadata: Schema.String,
})
const Receipt = Schema.Struct({ operationId: Schema.String, session: Schema.String, accepted: Schema.Boolean })
const Operation = Schema.Struct({
  operationId: Schema.String,
  session: Schema.String,
  status: Schema.Literals(['done', 'unanswered']),
  text: Schema.optional(Schema.String),
})
const LifecycleRead = Schema.Struct({ instance: Schema.String, messages: Schema.Array(Schema.Unknown) })
const Reopen = Schema.Struct({ replacedPiInstance: Schema.Boolean, messages: Schema.Array(Schema.Unknown) })
const Sessions = Schema.Struct({ sessions: Schema.Array(Schema.Struct({ id: Schema.String, busy: Schema.Boolean })) })
const Evidence = Schema.Struct({
  name: Schema.String,
  operationId: Schema.String,
  instance: Schema.String,
  testProcess: Schema.Number,
  messages: Schema.Array(Schema.Unknown),
})

const baseUrl = (url: string): string => url.replace(/\/+$/u, '')

function lifecycleEvidencePath(): FileURL {
  return new FileURL('../../.alchemy/purrable-native-lifecycle.json', import.meta.url)
}

function lifecycleClient(url: string, name: string, operationId: string) {
  return <S extends Schema.Top>(path: string, schema: S) =>
    Effect.gen(function* () {
      const response = yield* Effect.promise(() =>
        fetch(`${baseUrl(url)}/lifecycle${path}?name=${name}&operationId=${operationId}`),
      )
      expect(response.status).toBe(200)
      const raw: unknown = yield* Effect.promise(() => response.json())
      return yield* Schema.decodeUnknownEffect(schema)(raw)
    })
}

harness.test(
  'local workerd: actual PersonalAgent startup and additive app migration preserve vendor schemas',
  Effect.gen(function* () {
    const { url } = yield* stack
    const fixtureId = yield* nextInt
    const response = yield* Effect.promise(() => fetch(`${url.replace(/\/+$/u, '')}/?name=${fixtureId}`))
    expect(response.status).toBe(200)
    const raw: unknown = yield* Effect.promise(() => response.json())
    const result = yield* Schema.decodeUnknownEffect(NativeResult)(raw)
    expect(result.snapshot).toMatchObject({ type: 'snapshot', entries: [] })
    expect(result.metadata).toBe('stored-updated')
    expect(result.after).toEqual(result.before)
    expect(JSON.stringify(result.after)).toContain('app_metadata')
    expect(JSON.stringify(result.after)).toContain('pi_submissions')
    expect(JSON.stringify(result.after)).toContain('cf_agents_jobs')
  }),
)

const Status = Schema.Struct({ state: Schema.String })
const Rpc = Schema.Struct({
  first: Schema.Struct({ ok: Schema.Literal(true), value: Status }),
  revoked: Schema.Struct({ ok: Schema.Literal(true), value: Status }),
  afterOwnerRequest: Schema.Struct({ ok: Schema.Literal(true), value: Status }),
  enabled: Schema.Struct({ ok: Schema.Literal(true), value: Status }),
  servers: Schema.Struct({ ok: Schema.Literal(true), value: Schema.Array(Schema.Unknown) }),
  unknownServer: Schema.Struct({ ok: Schema.Literal(false), error: Schema.Struct({ _tag: Schema.String }) }),
  noConversation: Schema.Struct({ ok: Schema.Literal(true), value: Schema.Array(Schema.Unknown) }),
  usage: Schema.Struct({
    ok: Schema.Literal(true),
    value: Schema.Struct({ used: Schema.Number, limit: Schema.Number, resetsAt: Schema.Number }),
  }),
  askWhileRevoked: Schema.Struct({ ok: Schema.Literal(false), error: Schema.Struct({ _tag: Schema.String }) }),
})

harness.test(
  'local workerd: owner RPC renews resident authority, revocation is sticky and blocks client asks',
  Effect.gen(function* () {
    const { url } = yield* stack
    const name = `rpc-${yield* nextInt}`
    const response = yield* Effect.promise(() => fetch(`${baseUrl(url)}/rpc?name=${name}`))
    expect(response.status).toBe(200)
    const raw: unknown = yield* Effect.promise(() => response.json())
    const result = yield* Schema.decodeUnknownEffect(Rpc)(raw)
    expect(result.first.value.state).toBe('active')
    expect(result.revoked.value.state).toBe('revoked')
    expect(result.afterOwnerRequest.value.state).toBe('revoked')
    expect(result.enabled.value.state).toBe('active')
    expect(result.servers.value).toEqual([])
    expect(result.unknownServer.error._tag).toBe('NotFound')
    expect(result.noConversation.value).toEqual([])
    // A fresh agent has spent nothing today; the budget table exists after migration.
    expect(result.usage.value).toMatchObject({ used: 0, limit: 300_000 })
    expect(result.usage.value.resetsAt % 86_400).toBe(0)
    expect(result.askWhileRevoked.error._tag).toBe('ResidentInactive')
  }),
)

harness.test(
  'local workerd: native Pi submit, receipt retry, durable readback and public dispose/reopen',
  Effect.gen(function* () {
    const { url } = yield* stack
    const name = `lifecycle-${yield* nextInt}`
    const operationId = String(yield* nextInt)
    const get = lifecycleClient(url, name, operationId)
    expect(yield* get('', Sessions)).toEqual({ sessions: [{ id: '1', busy: false }] })
    const receipt = yield* get('/submit', Receipt)
    expect(receipt).toEqual({ operationId, session: '1', accepted: true })
    expect(yield* get('/submit', Receipt)).toEqual({
      operationId,
      session: '1',
      accepted: false,
    })
    const result = yield* get('/wait', Operation)
    expect(result).toMatchObject({ operationId, session: '1', status: 'done', text: 'fixture-persisted-answer' })
    const read = yield* get('/read', LifecycleRead)
    expect(read.messages).toHaveLength(2)
    expect(read.messages).toMatchObject([
      { kind: 'pi.user', model: [{ role: 'user', content: 'persist this lifecycle fixture input' }] },
      {
        kind: 'pi.assistant',
        model: [{ role: 'assistant', content: [{ type: 'text', text: 'fixture-persisted-answer' }] }],
      },
    ])
    const reopened = yield* get('/reopen', Reopen)
    expect(reopened.replacedPiInstance).toBe(true)
    expect(reopened.messages).toEqual(read.messages)
    expect(yield* get('/submit', Receipt)).toEqual({ operationId, session: '1', accepted: false })
    expect(yield* get('/wait', Operation)).toEqual(result)
    expect((yield* get('/read', LifecycleRead)).messages).toEqual(read.messages)
    if (phase === 'write') {
      const path = lifecycleEvidencePath()
      mkdirSync(new FileURL('./', path), { recursive: true })
      writeFileSync(
        path,
        JSON.stringify(
          { name, operationId, instance: read.instance, testProcess: process.pid, messages: read.messages },
          null,
          2,
        ),
      )
    }
  }),
)

// Two explicit Vitest processes prove local storage reconstruction, independently of remote eviction.
if (phase === 'read')
  harness.test(
    'local workerd process two: fresh Agent reads the persisted native Pi transcript',
    Effect.gen(function* () {
      const path = lifecycleEvidencePath()
      const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
      const evidence = yield* Schema.decodeUnknownEffect(Evidence)(raw)
      expect(process.pid).not.toBe(evidence.testProcess)
      const { url } = yield* stack
      const get = lifecycleClient(url, evidence.name, evidence.operationId)
      const fresh = yield* get('/read', LifecycleRead)
      expect(fresh.instance).not.toBe(evidence.instance)
      expect(fresh.messages).toEqual(evidence.messages)
      expect(yield* get('/submit', Receipt)).toEqual({
        operationId: evidence.operationId,
        session: '1',
        accepted: false,
      })
      expect((yield* get('/read', LifecycleRead)).messages).toEqual(evidence.messages)
      writeFileSync(
        new FileURL('../../.alchemy/purrable-native-reconstruction.json', import.meta.url),
        JSON.stringify(
          {
            environment: 'local-workerd-process-reconstruction',
            previousInstance: evidence.instance,
            reconstructedInstance: fresh.instance,
            previousTestProcess: evidence.testProcess,
            testProcess: process.pid,
            sameTranscript: true,
          },
          null,
          2,
        ),
      )
    }),
  )
