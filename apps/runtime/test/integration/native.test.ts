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
import { routineEventsCase, routineSchedulingCase } from './native-routines-events.ts'
import { filesCase } from './native-files.ts'
import { appsCase } from './native-apps.ts'
import { scopesCase } from './native-scopes.ts'
import { composerCase } from './native-composer.ts'
import { telemetryCase } from './native-telemetry.ts'
import { primaryBindingCase } from './native-chats.ts'
import { topicMemoryCase } from './native-topics.ts'
import {
  Listed,
  ModelRequest,
  Ok,
  Refused,
  feedChecks,
  requestTurns,
  subagentBranchChecks,
  treeChecks,
} from './conversation-checks.ts'
import { chainChecks, closeChecks, ownerChecks, synthesisChecks } from './subagent-checks.ts'

const phase = await Effect.runPromise(
  Config.String('GOBLIN_NATIVE_LIFECYCLE_PHASE').pipe(
    Config.withDefault('same-process'),
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Literals(['same-process', 'write', 'read']))),
  ),
)
const primaryProfile = await Effect.runPromise(Config.String('GOBLIN_PRIMARY_PROFILE').pipe(Config.withDefault('root')))
const harness = Test.make({
  providers: Cloudflare.providers(),
  state: Alchemy.localState(),
  // Ordinary runs must not wake alarms from previous fixtures. Explicit two-process proof retains its stage.
  stage: phase === 'same-process' ? `test_native_runtime_${process.pid}` : 'test_native_runtime',
  dev: true,
})
const stack = harness.beforeAll(harness.deploy(Stack))
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
const SkillsCache = Schema.Struct({
  firstBody: Schema.String,
  secondBody: Schema.String,
  reads: Schema.Number,
  repaired: Schema.Boolean,
})
const SkillsLearnerRejection = Schema.Struct({
  first: Schema.Literals(['skipped', 'none', 'duplicate', 'drafted', 'failed']),
  second: Schema.Literals(['skipped', 'none', 'duplicate', 'drafted', 'failed']),
  submitted: Schema.Number,
  statusCalls: Schema.Number,
  row: Schema.Array(Schema.Struct({ status: Schema.Literal('rejected') })),
})
const SkillsPersisted = Schema.Struct({
  instance: Schema.String,
  retained: Schema.Struct({
    activation: Schema.Unknown,
    digest: Schema.String,
    cachedText: Schema.String,
    file: Schema.Struct({ kind: Schema.Literal('text'), path: Schema.String, text: Schema.String }),
    networkCalls: Schema.Number,
  }),
})
const Evidence = Schema.Struct({
  name: Schema.String,
  operationId: Schema.String,
  instance: Schema.String,
  testProcess: Schema.Number,
  messages: Schema.Array(Schema.Unknown),
})

const baseUrl = (url: string): string => url.replace(/\/+$/u, '')
/** Workerd eviction closes its HTTP connection; never reuse an earlier fixture's socket. */
const nativeFetch = (url: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers)
  headers.set('connection', 'close')
  return fetch(url, { ...init, headers })
}
/** The subagent tools among a request's tools. */
const offered = (tools: readonly string[] = []) => tools.filter((tool) => tool.startsWith('subagent'))

harness.test(
  'local workerd: composer rejects stale skills before model work and references a helper in the current conversation',
  stack.pipe(Effect.flatMap(({ url }) => composerCase(url))),
)

harness.test(
  'local workerd: routine definitions retain exact confirmations, replay IDs and revision fences',
  Effect.gen(function* () {
    const { url } = yield* stack
    const name = `routines-${yield* nextInt}`
    const response = yield* Effect.promise(() => nativeFetch(`${baseUrl(url)}/routines-probe?name=${name}`))
    expect(response.status).toBe(200)
    const result = yield* Effect.promise(() => response.json())
    expect(result).toMatchObject({
      replay: true,
      changedId: true,
      stale: true,
      foreign: true,
      cap: true,
      confirmationReplay: true,
      confirmed: 'activating',
      nextFire: Date.parse('2026-10-05T07:00:00Z'),
      editCleared: true,
      paused: 'paused',
      definitions: 1,
      operations: 4,
      emptyRunStores: [0, 0, 0, 0],
      settings: [{ id: 1, timezone: 'UTC', maxActive: 20, maxRunning: 2 }],
    })
  }),
)

function lifecycleEvidencePath(): FileURL {
  return new FileURL('../../.alchemy/goblin-native-lifecycle.json', import.meta.url)
}

const RoutineRecovery = Schema.Struct({
  instance: Schema.String,
  runId: Schema.String,
  sessionId: Schema.String,
  used: Schema.Number,
})
const RoutineRecovered = Schema.Struct({
  ...RoutineRecovery.fields,
  state: Schema.String,
  usedBefore: Schema.Number,
  replay: Schema.Boolean,
  reportAccepted: Schema.Boolean,
  retainedSchedules: Schema.Number,
})
const routineRecoveryPath = new FileURL('../../.alchemy/goblin-routine-reconstruction.json', import.meta.url)

harness.test(
  'local workerd: signed routine Events freeze metadata, dedupe and coalesce, recover gaps and retire revisions',
  stack.pipe(Effect.flatMap(({ url }) => routineEventsCase(url))),
)

harness.test(
  'local workerd: routine Telegram flag, frozen retries and remote receipt remain separate from Pi acceptance',
  Effect.gen(function* () {
    const { url } = yield* stack
    const response = yield* Effect.promise(() =>
      nativeFetch(`${baseUrl(url)}/routine-notifications?name=routine-notifications-${Date.now()}`),
    )
    expect(response.status).toBe(200)
    const result = yield* Effect.promise(() => response.json())
    expect(result).toMatchObject({
      offCalls: 0,
      frozenServer: 'mygram',
      retryState: 'pending',
      attempts: 2,
      stableBytes: true,
      accepted: 1,
      state: 'accepted',
      metadata: { id: 'fixture-remote-id', delivery: 'accepted' },
      scrubbed: 'Useful result <safe> [redacted]',
      reported: true,
    })
  }),
)

harness.test(
  'local workerd: routine question survives eviction with the same Pi session and one usage projection',
  Effect.gen(function* () {
    const { url } = yield* stack
    const name = `routine-recovery-${yield* nextInt}`
    const beforeResponse = yield* Effect.promise(() =>
      nativeFetch(`${baseUrl(url)}/routine-recovery-write?name=${name}`),
    )
    expect(beforeResponse.status).toBe(200)
    const before = yield* Schema.decodeUnknownEffect(RoutineRecovery)(
      yield* Effect.promise(() => beforeResponse.json()),
    )
    if (phase === 'write') {
      mkdirSync(new FileURL('./', routineRecoveryPath), { recursive: true })
      writeFileSync(routineRecoveryPath, JSON.stringify({ name, testProcess: process.pid, ...before }))
      return
    }
    yield* Effect.promise(() =>
      nativeFetch(`${baseUrl(url)}/routine-evict?name=${name}`).then(
        () => undefined,
        () => undefined,
      ),
    )
    const afterResponse = yield* Effect.promise(() => nativeFetch(`${baseUrl(url)}/routine-recovery-read?name=${name}`))
    expect(afterResponse.status).toBe(200)
    const after = yield* Schema.decodeUnknownEffect(RoutineRecovered)(yield* Effect.promise(() => afterResponse.json()))
    expect(after.instance).not.toBe(before.instance)
    expect(after).toMatchObject({
      runId: before.runId,
      sessionId: before.sessionId,
      usedBefore: before.used,
      used: 30,
      state: 'completed',
      replay: true,
      reportAccepted: true,
    })
    expect(after.retainedSchedules).toBeLessThanOrEqual(1)
  }),
)

if (phase === 'read')
  harness.test(
    'local workerd process two: routines recover the retained question and same Pi session',
    Effect.gen(function* () {
      const RecoveryEvidence = Schema.Struct({
        ...RoutineRecovery.fields,
        name: Schema.String,
        testProcess: Schema.Number,
      })
      const before = yield* Schema.decodeUnknownEffect(RecoveryEvidence)(
        JSON.parse(readFileSync(routineRecoveryPath, 'utf8')),
      )
      expect(process.pid).not.toBe(before.testProcess)
      const { url } = yield* stack
      const response = yield* Effect.promise(() =>
        nativeFetch(`${baseUrl(url)}/routine-recovery-read?name=${before.name}`),
      )
      expect(response.status).toBe(200)
      const after = yield* Schema.decodeUnknownEffect(RoutineRecovered)(yield* Effect.promise(() => response.json()))
      expect(after.instance).not.toBe(before.instance)
      expect(after).toMatchObject({
        runId: before.runId,
        sessionId: before.sessionId,
        usedBefore: 15,
        used: 30,
        state: 'completed',
        replay: true,
        reportAccepted: true,
      })
      expect(after.retainedSchedules).toBeLessThanOrEqual(1)
    }),
  )

harness.test(
  'local workerd: routines charge committed native compaction, dedupe UTC-day replay and bound cap overshoot',
  Effect.gen(function* () {
    const { url } = yield* stack
    const response = yield* Effect.promise(() =>
      nativeFetch(`${baseUrl(url)}/routine-usage?name=routine-usage-${Date.now()}`),
    )
    expect(response.status).toBe(200)
    const result = yield* Effect.promise(() => response.json())
    expect(result).toMatchObject({
      compactionStatus: 'completed',
      compactedTokens: 45,
      afterReplay: 45,
      nextDay: 0,
      capState: 'failed',
      overshoot: 10,
      capModelRequests: 1,
    })
  }),
)

harness.test(
  'local workerd: main Stop preserves executing routines, caps queue one trigger and archive stops owned work',
  Effect.gen(function* () {
    const { url } = yield* stack
    const response = yield* Effect.promise(() =>
      nativeFetch(`${baseUrl(url)}/routine-stop?name=routine-stop-${Date.now()}`),
    )
    expect(response.status).toBe(200)
    const result = yield* Effect.promise(() => response.json())
    expect(result).toMatchObject({
      currentConfirmation: 'active',
      mainStopPreserved: true,
      capped: true,
      noCapRun: true,
      onePending: true,
      suppressed: 2,
      archived: 'archived',
      archivedState: 'stopped',
      pendingCleared: true,
      secondSettled: 'completed',
      oneReport: true,
    })
  }),
)

harness.test(
  'local workerd: routine manual runs isolate native Pi sessions and dedupe passive reports',
  Effect.gen(function* () {
    const { url } = yield* stack
    const response = yield* Effect.promise(() =>
      nativeFetch(`${baseUrl(url)}/routine-execution?name=routine-run-${Date.now()}`),
    )
    expect(response.status).toBe(200)
    const result = yield* Effect.promise(() => response.json())
    expect(result).toMatchObject({
      duplicate: true,
      state: 'completed',
      registered: true,
      copiedCapabilities: 0,
      reportCount: 1,
      reportAccepted: true,
      tools: ['mcp_list', 'mcp_call', 'ask_user'],
      usage: { run: 15, day: 15 },
      skipped: 'skipped',
      skipOutcome: 'ResidentInactive',
      noSkippedModel: true,
    })
  }),
)

function lifecycleClient(url: string, name: string, operationId: string) {
  return <S extends Schema.Top>(path: string, schema: S) =>
    Effect.gen(function* () {
      const response = yield* Effect.promise(() =>
        nativeFetch(`${baseUrl(url)}/lifecycle${path}?name=${name}&operationId=${operationId}`),
      )
      expect(response.status).toBe(200)
      const raw: unknown = yield* Effect.promise(() => response.json())
      return yield* Schema.decodeUnknownEffect(schema)(raw)
    })
}

harness.test(
  'local workerd: routine questions release slots and resume only with correlated owner answers',
  Effect.gen(function* () {
    const { url } = yield* stack
    const response = yield* Effect.promise(() =>
      nativeFetch(`${baseUrl(url)}/routine-question?name=routine-question-${Date.now()}`),
    )
    expect(response.status).toBe(200)
    const result = yield* Effect.promise(() => response.json())
    expect(result).toMatchObject({
      mainStopPreserved: true,
      answered: true,
      replay: true,
      changedRejected: true,
      sameSession: true,
      answeredState: 'completed',
      answeredInteractions: ['answered'],
      lateRejected: true,
      expiredState: 'stopped',
    })
  }),
)

harness.test(
  'local workerd: native dated routine alarms dedupe and collapse cron downtime before rearming',
  stack.pipe(Effect.flatMap(({ url }) => routineSchedulingCase(url))),
)
harness.test(
  'local workerd: owner files keep small ones in SQLite, spill larger ones to R2 and erase them with the account',
  stack.pipe(Effect.flatMap(({ url }) => filesCase(url))),
)
harness.test(
  'local workerd: agent apps build, call with receipts, migrate, refuse a broken build, roll back and restore',
  stack.pipe(Effect.flatMap(({ url }) => appsCase(url))),
)
harness.test(
  'local workerd: a turn leaves its run ledger (turn, attempts, tool call) and a restart interrupts what was left started',
  stack.pipe(Effect.flatMap(({ url }) => telemetryCase(url))),
)
harness.test(
  'local workerd: Events discovery, challenge, signed Telegram, replay, gap, refresh, termination and cleanup',
  Effect.gen(function* () {
    const { url } = yield* stack
    const response = yield* Effect.promise(() => nativeFetch(`${baseUrl(url)}/events-probe?name=events-${Date.now()}`))
    expect(response.status).toBe(200)
    const result = yield* Effect.promise(() => response.json())
    expect(result).toMatchObject({
      discovered: true,
      received: 204,
      replayed: 204,
      bad: 400,
      old: 400,
      operations: ['telegram-tg-123', 'telegram-tg-124'],
      waiting: true,
      runs: {
        channel: [
          { kind: 'channel.received', status: 'ok', operationId: 'telegram-tg-123', message: 'tg:123' },
          { kind: 'channel.received', status: 'ok', operationId: 'telegram-tg-124', message: 'tg:124' },
          { kind: 'channel.reply', status: 'ok', operationId: 'telegram-tg-123', delivery: 'sent' },
        ],
        inbox: expect.any(Number),
      },
      refreshedEarly: true,
      terminated: 'terminated',
      cleanup: { retired: true, remoteCleanup: true },
      remainingRemote: 0,
      pollRecovered: true,
      sharedPreserved: true,
      scheduledRecovery: true,
      skills: { first: true, second: true, retained: true, dirty: 1, replayDirty: 1, refreshed: 1, terminated: true },
      recovery: { interrupted: true, pendingRetained: true, accepted: true, stableOperation: true, processed: true },
    })
  }),
)

harness.test(
  'local workerd: a corrupted skill cache row is rejected, refetched and repaired',
  Effect.gen(function* () {
    const { url } = yield* stack
    const name = `skills-cache-${yield* nextInt}`
    const response = yield* Effect.promise(() => nativeFetch(`${baseUrl(url)}/skills-cache?name=${name}`))
    expect(response.status).toBe(200)
    const result = yield* Schema.decodeUnknownEffect(SkillsCache)(yield* Effect.promise(() => response.json()))
    expect(result.firstBody).toContain('# Cache test')
    expect(result.secondBody).toContain('# Cache test')
    expect(result.reads).toBe(2)
    expect(result.repaired).toBe(true)
  }),
)

harness.test(
  'local workerd: a rejected learner draft is refreshed and never submitted again',
  Effect.gen(function* () {
    const { url } = yield* stack
    const name = `skills-learner-rejection-${yield* nextInt}`
    const response = yield* Effect.promise(() => nativeFetch(`${baseUrl(url)}/lifecycle/skills-rejection?name=${name}`))
    expect(response.status).toBe(200)
    const result = yield* Schema.decodeUnknownEffect(SkillsLearnerRejection)(
      yield* Effect.promise(() => response.json()),
    )
    expect(result).toEqual({
      first: 'drafted',
      second: 'duplicate',
      submitted: 1,
      statusCalls: 1,
      row: [{ status: 'rejected' }],
    })
  }),
)

harness.test(
  'local workerd: skill activation and verified bytes survive a Durable Object restart',
  Effect.gen(function* () {
    const { url } = yield* stack
    const name = `skills-restart-${yield* nextInt}`
    const get = lifecycleClient(url, name, 'unused')
    const before = yield* get('/skills-write', SkillsPersisted)
    yield* Effect.promise(() =>
      nativeFetch(`${baseUrl(url)}/lifecycle/skills-evict?name=${name}`).then(
        () => undefined,
        () => undefined,
      ),
    )
    const after = yield* get('/skills-read', SkillsPersisted)
    expect(after.instance).not.toBe(before.instance)
    expect(after.retained).toEqual(before.retained)
    expect(after.retained.networkCalls).toBe(0)
    expect(after.retained.cachedText).toContain('# Cache test')
    expect(after.retained.file.text).toBe(after.retained.cachedText)
    expect(after.retained.digest).toMatch(/^sha256:[a-f0-9]{64}$/u)
    const path = new FileURL('../../.alchemy/goblin-skills-restart.json', import.meta.url)
    mkdirSync(new FileURL('./', path), { recursive: true })
    writeFileSync(path, JSON.stringify({ environment: 'local-workerd-do-restart', before, after }, null, 2))
  }),
)

harness.test(
  'local workerd: actual PersonalAgent startup and additive app migration preserve vendor schemas',
  Effect.gen(function* () {
    const { url } = yield* stack
    const fixtureId = yield* nextInt
    const response = yield* Effect.promise(() => nativeFetch(`${baseUrl(url)}/probe?name=${fixtureId}`))
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
const Failure = Schema.Struct({ ok: Schema.Literal(false), error: Schema.Struct({ _tag: Schema.String }) })
const Rpc = Schema.Struct({
  first: Schema.Struct({ ok: Schema.Literal(true), value: Status }),
  revoked: Schema.Struct({ ok: Schema.Literal(true), value: Status }),
  afterOwnerRequest: Schema.Struct({ ok: Schema.Literal(true), value: Status }),
  enabled: Schema.Struct({ ok: Schema.Literal(true), value: Status }),
  servers: Schema.Struct({ ok: Schema.Literal(true), value: Schema.Array(Schema.Unknown) }),
  unknownServer: Schema.Struct({ ok: Schema.Literal(false), error: Schema.Struct({ _tag: Schema.String }) }),
  unknownApp: Schema.Struct({ ok: Schema.Literal(false), error: Schema.Struct({ _tag: Schema.String }) }),
  noConversation: Schema.Struct({ ok: Schema.Literal(true), value: Schema.Array(Schema.Unknown) }),
  threads: Ok(Schema.Array(Listed)),
  badBranch: Failure,
  unknownThread: Failure,
  closed: Ok(Listed),
  mainUntouchable: Failure,
  usage: Schema.Struct({
    ok: Schema.Literal(true),
    value: Schema.Struct({ used: Schema.Number, limit: Schema.Number, resetsAt: Schema.Number }),
  }),
  model: Schema.Struct({
    ok: Schema.Literal(true),
    value: Schema.Struct({ current: Schema.String, default: Schema.String, options: Schema.Array(Schema.Unknown) }),
  }),
  unknownModel: Schema.Struct({ ok: Schema.Literal(false), error: Schema.Struct({ _tag: Schema.String }) }),
  askWhileRevoked: Schema.Struct({ ok: Schema.Literal(false), error: Schema.Struct({ _tag: Schema.String }) }),
})

harness.test(
  'local workerd: owner RPC renews resident authority, gates threads, and revocation blocks client asks',
  Effect.gen(function* () {
    const { url } = yield* stack
    const name = `rpc-${yield* nextInt}`
    const response = yield* Effect.promise(() => nativeFetch(`${baseUrl(url)}/rpc?name=${name}`))
    expect(response.status).toBe(200)
    const raw: unknown = yield* Effect.promise(() => response.json())
    const result = yield* Schema.decodeUnknownEffect(Rpc)(raw)
    expect(result.first.value.state).toBe('active')
    expect(result.revoked.value.state).toBe('revoked')
    expect(result.afterOwnerRequest.value.state).toBe('revoked')
    expect(result.enabled.value.state).toBe('active')
    expect(result.servers.value).toEqual([])
    expect(result.unknownServer.error._tag).toBe('NotFound')
    expect(result.unknownApp.error._tag).toBe('NotFound')
    expect(result.noConversation.value).toEqual([])
    // Main is registered on first use; an empty thread joins it. Only registered conversations reach Pi.
    expect(result.threads.value.map(({ kind, closedAt }) => ({ kind, closed: closedAt !== undefined }))).toEqual([
      { kind: 'main', closed: false },
      { kind: 'thread', closed: false },
    ])
    expect(result.badBranch.error._tag).toBe('InvalidInput')
    expect(result.unknownThread.error._tag).toBe('NotFound')
    expect(result.closed.value).toMatchObject({ closedBy: 'owner', closedAt: expect.any(Number) })
    expect(result.mainUntouchable.error._tag).toBe('InvalidInput')
    // A fresh agent has spent nothing today; the budget table exists after migration.
    expect(result.usage.value).toMatchObject({ used: 0, limit: 300_000 })
    expect(result.usage.value.resetsAt % 86_400).toBe(0)
    // No pick yet: the deployment default; a model the deployment does not offer is refused (app_model_choice exists).
    expect(result.model.value).toMatchObject({ current: 'storage-only', default: 'storage-only' })
    expect(result.unknownModel.error._tag).toBe('InvalidInput')
    expect(result.askWhileRevoked.error._tag).toBe('ResidentInactive')
  }),
)

const Binding = Schema.Struct({
  first: Schema.Array(Schema.String),
  same: Schema.Array(Schema.String),
  kept: Schema.Struct({ credentials: Schema.Number, grants: Schema.Number, pending: Schema.Number }),
  moved: Schema.Array(Schema.String),
  after: Schema.Struct({ credentials: Schema.Number, grants: Schema.Number, pending: Schema.Number }),
  bound: Schema.Array(Schema.Struct({ serverId: Schema.String, endpoint: Schema.String, boundAt: Schema.Number })),
  removed: Schema.Struct({
    listed: Schema.Array(Schema.String),
    left: Schema.Number,
    after: Schema.Struct({ credentials: Schema.Number, grants: Schema.Number, pending: Schema.Number }),
    bound: Schema.Number,
  }),
})

harness.test(
  'local workerd: re-pointing a server drops the credentials, grants and pending state made for its old endpoint',
  Effect.gen(function* () {
    const { url } = yield* stack
    const name = `binding-${yield* nextInt}`
    const response = yield* Effect.promise(() => nativeFetch(`${baseUrl(url)}/binding?name=${name}`))
    expect(response.status).toBe(200)
    const raw: unknown = yield* Effect.promise(() => response.json())
    const result = yield* Schema.decodeUnknownEffect(Binding)(raw)
    expect(result.first).toEqual([])
    expect(result.same).toEqual([])
    expect(result.kept).toEqual({ credentials: 1, grants: 1, pending: 1 })
    expect(result.moved).toEqual(['notes'])
    expect(result.after).toEqual({ credentials: 0, grants: 0, pending: 0 })
    expect(result.bound).toEqual([{ serverId: 'notes', endpoint: 'https://b.test/mcp', boundAt: 3 }])
    expect(result.removed).toEqual({
      listed: ['extra'],
      left: 0,
      after: { credentials: 0, grants: 0, pending: 0 },
      bound: 1,
    })
  }),
)

const Destroy = Schema.Struct({
  submitted: Schema.Struct({ ok: Schema.Literal(true) }),
  before: Schema.Number,
  deleted: Schema.Unknown,
  after: Schema.Number,
  resident: Schema.Struct({ ok: Schema.Literal(true), value: Status }),
})

/** A transcript's turns, without the system prompt and memory view entries placed among them for the model. */
const turns = (lines: readonly string[]) =>
  lines.filter((line) => !line.startsWith('pi.system') && !line.startsWith('app.memory'))

const Activity = Schema.Struct({
  createdAt: Schema.Number,
  forkEntry: Schema.Number,
  replies: Schema.Number,
  lastReplyAt: Schema.optional(Schema.Number),
})
const Branch = Schema.Struct({
  thread: Schema.Struct({ kind: Schema.Literal('thread'), parent: Schema.Literal('1') }),
  settled: Schema.Struct({ status: Schema.Literal('done'), text: Schema.String }),
  main: Schema.Array(Schema.String),
  branch: Schema.Array(Schema.String),
  request: ModelRequest,
  forkedAt: Schema.Number,
  before: Activity,
  afterOne: Activity,
  afterTwo: Activity,
})

harness.test(
  'local workerd: a thread branched from main sees main up to the branch, and main never sees the thread',
  Effect.gen(function* () {
    const { url } = yield* stack
    const name = `branch-${yield* nextInt}`
    const response = yield* Effect.promise(() => nativeFetch(`${baseUrl(url)}/branch?name=${name}`))
    const result = yield* Schema.decodeUnknownEffect(Branch)(yield* Effect.promise(() => response.json()))
    expect(result.settled.text).toBe('echo: what was the word?')
    expect(turns(result.main)).toEqual([
      'pi.user: "remember the word lantern"',
      'pi.assistant: [{"type":"text","text":"echo: remember the word lantern"}]',
    ])
    expect(turns(result.branch)).toEqual([
      ...turns(result.main),
      'pi.user: "what was the word?"',
      'pi.assistant: [{"type":"text","text":"echo: what was the word?"}]',
    ])
    expect(requestTurns(result.request)).toEqual([
      'remember the word lantern',
      'echo: remember the word lantern',
      'what was the word?',
    ])
    // The thread list knows where the thread branched and counts only what was said in it.
    expect(result.before).toMatchObject({ forkEntry: result.forkedAt, replies: 0 })
    expect(result.before.lastReplyAt).toBeUndefined()
    expect(result.afterOne).toMatchObject({ forkEntry: result.forkedAt, replies: 2 })
    expect(result.afterOne.lastReplyAt).toBeGreaterThanOrEqual(result.afterOne.createdAt)
    expect(result.afterTwo.replies).toBe(4)
  }),
)

const Share = Schema.Struct({
  shared: Schema.Struct({ status: Schema.Literal('done'), text: Schema.String }),
  main: Schema.Array(Schema.String),
  mainRequest: ModelRequest,
  threadRequest: ModelRequest,
  title: Schema.String,
})

harness.test(
  'local workerd: a thread shares a note with main, which main sees as context without answering it',
  Effect.gen(function* () {
    const { url } = yield* stack
    const name = `share-${yield* nextInt}`
    const response = yield* Effect.promise(() => nativeFetch(`${baseUrl(url)}/share?name=${name}`))
    const result = yield* Schema.decodeUnknownEffect(Share)(yield* Effect.promise(() => response.json()))
    expect(result.shared.text).toBe('done: Shared with main.')
    const note = [
      { type: 'text', text: '[from thread (untitled)]' },
      { type: 'text', text: 'the word is lantern' },
    ]
    expect(turns(result.main)).toEqual([
      'pi.user: "remember the word lantern"',
      'pi.assistant: [{"type":"text","text":"echo: remember the word lantern"}]',
      `app.shared: ${JSON.stringify(note)}`,
      'pi.user: "what did the thread say?"',
      'pi.assistant: [{"type":"text","text":"echo: what did the thread say?"}]',
    ])
    // Main's background memory builder may compact the earlier exchange before this request.
    const requested = requestTurns(result.mainRequest)
    expect(requested.join('\n')).toContain('remember the word lantern')
    expect(requested.join('\n')).toContain('echo: remember the word lantern')
    expect(requested.slice(-2)).toEqual(['[from thread (untitled)]\nthe word is lantern', 'what did the thread say?'])
    expect(result.threadRequest.tools).toContain('share_back')
    expect(result.mainRequest.tools).not.toContain('share_back')
    // The cheap model (scripted: it echoes the last line) was asked to name the thread's latest exchange.
    expect(result.title).toBe('echo: Agent: done: Shared with main.')
  }),
)

const Announce = Schema.Struct({
  thread: Schema.String,
  title: Schema.String,
  first: Schema.Array(Schema.String),
  notes: Schema.Array(Schema.Unknown),
  main: Schema.Array(Schema.String),
  request: ModelRequest,
})

harness.test(
  'local workerd: a thread started with + tells main its name once, and a branched thread tells it nothing',
  Effect.gen(function* () {
    const { url } = yield* stack
    const name = `announce-${yield* nextInt}`
    const response = yield* Effect.promise(() => nativeFetch(`${baseUrl(url)}/announce?name=${name}`))
    const raw = yield* Effect.promise(() => response.json())
    expect(raw).toHaveProperty('thread')
    const result = yield* Schema.decodeUnknownEffect(Announce)(raw)
    const note = `[thread started: "${result.title}"]`
    expect(result.first).toEqual([`app.thread_started: ${JSON.stringify([{ type: 'text', text: note }])}`])
    // One note however often the thread answers, naming the thread; the branched thread added none.
    expect(result.notes).toEqual([{ thread: result.thread }])
    // The note started no run in main: the next line in main is the owner's own question.
    expect(turns(result.main).slice(2)).toEqual([
      `app.thread_started: ${JSON.stringify([{ type: 'text', text: note }])}`,
      'pi.user: "which threads did I start?"',
      'pi.assistant: [{"type":"text","text":"echo: which threads did I start?"}]',
    ])
    expect(requestTurns(result.request)).toContain(note)
  }),
)

harness.test(
  "local workerd: a thread copies its parent's switches and a subagent is bounded by every conversation above it",
  stack.pipe(Effect.flatMap(({ url }) => scopesCase(url))),
)

const View = Schema.Struct({
  thread: Schema.String,
  kind: Schema.String,
  servers: Schema.Array(
    Schema.Struct({
      serverId: Schema.String,
      label: Schema.String,
      on: Schema.Boolean,
      tools: Schema.Array(Schema.Struct({ name: Schema.String, on: Schema.Boolean })),
    }),
  ),
  skills: Schema.Array(Schema.Unknown),
  subagents: Schema.Boolean,
  sameAsParent: Schema.optional(Schema.Boolean),
})
const Tools = Schema.optional(Schema.Array(Schema.String))
/** The seeded `notes` server as a conversation shows it, `write` switched as given. */
const notes = (write: boolean) => [
  {
    serverId: 'notes',
    label: 'Notes',
    on: true,
    tools: [
      { name: 'read', on: true },
      { name: 'write', on: write },
    ],
  },
]
const CapabilityRun = Schema.Struct({
  mainBefore: Ok(View),
  mainAfter: Ok(View),
  freshView: Ok(View),
  branchedView: Ok(View),
  freshOn: Ok(View),
  reset: Ok(View),
  unknown: Refused,
  mainReset: Refused,
  tools: Schema.Struct({ main: Tools, thread: Tools, branch: Tools, reset: Tools }),
  off: Schema.Struct({ status: Schema.Literal('done'), text: Schema.String }),
  offDetails: Schema.Unknown,
  listed: Schema.Struct({ status: Schema.Literal('done'), text: Schema.String }),
})

harness.test(
  'local workerd: the owner switches a tool and subagents off in main, a new thread copies that, and Reset restores it',
  Effect.gen(function* () {
    const { url } = yield* stack
    const name = `capabilities-${yield* nextInt}`
    const response = yield* Effect.promise(() => nativeFetch(`${baseUrl(url)}/capabilities?name=${name}`))
    const result = yield* Schema.decodeUnknownEffect(CapabilityRun)(yield* Effect.promise(() => response.json()))
    expect(result.mainBefore.value).toMatchObject({ kind: 'main', servers: notes(true), skills: [], subagents: true })
    expect(result.mainBefore.value.sameAsParent).toBeUndefined()
    expect(result.mainAfter.value).toMatchObject({ servers: notes(false), subagents: false })
    for (const copied of [result.freshView.value, result.branchedView.value])
      expect(copied).toMatchObject({ kind: 'thread', servers: notes(false), subagents: false, sameAsParent: true })
    expect(result.freshOn.value).toMatchObject({ subagents: true, sameAsParent: false })
    expect(result.reset.value).toMatchObject({ servers: notes(false), subagents: false, sameAsParent: true })
    expect(result.unknown.error._tag).toBe('InvalidInput')
    expect(result.mainReset.error._tag).toBe('InvalidInput')
    // Pi's tool filter follows the switch: no subagent tool where subagents are off.
    expect(result.tools.main).toContain('mcp_call')
    expect(offered(result.tools.main)).toEqual([])
    expect(offered(result.tools.thread)).toEqual([
      'subagent_spawn',
      'subagent_send',
      'subagent_stop',
      'subagent_config',
      'subagent_status',
    ])
    expect(offered(result.tools.branch)).toEqual([])
    expect(offered(result.tools.reset)).toEqual([])
    // The switched-off tool ran nothing: the gate answered before the grant check or any connection to notes.test.
    expect(result.off.text).toContain('Off in this conversation: notes · write. Nothing ran.')
    expect(result.offDetails).toEqual({
      kind: 'capability-off',
      target: { kind: 'tool', serverId: 'notes', name: 'write' },
    })
    expect(result.listed.text).toBe('done: {"servers":[]}')
  }),
)

const MemoryRun = Schema.Struct({
  summarized: Schema.Number,
  request: ModelRequest,
  zoomed: Schema.Struct({ status: Schema.Literal('done'), text: Schema.String }),
  view: Schema.String,
  earlier: Schema.Array(Schema.String),
})

harness.test(
  'local workerd: main reads its earlier turns as a memory view, the newest verbatim, and zooms into it',
  Effect.gen(function* () {
    const { url } = yield* stack
    const name = `memory-${yield* nextInt}`
    const response = yield* Effect.promise(() => nativeFetch(`${baseUrl(url)}/memory?name=${name}`))
    const result = yield* Schema.decodeUnknownEffect(MemoryRun)(yield* Effect.promise(() => response.json()))
    expect(result.summarized).toBeGreaterThanOrEqual(2)
    // Messages are short here, so each is its own summary line, word for word (no model call).
    expect(requestTurns(result.request)).toEqual([
      '<memory>\n0+1|user: remember alpha\n1+1|talk: echo: remember alpha\n</memory>',
      'remember beta',
      'echo: remember beta',
      'what do you remember?',
    ])
    expect(result.request.tools).toContain('zoom')
    expect(result.zoomed.text).toBe('done: 0+1|user: remember alpha')
    expect(result.view).toBe('app.memory')
    expect(result.earlier).toContain('pi.user: "remember alpha"')
  }),
)

harness.test(
  'local workerd: each Topic Conversation remembers apart, with its view only there',
  stack.pipe(Effect.flatMap(({ url }) => topicMemoryCase(url))),
)

const SubagentRun = Schema.Struct({
  spawned: Schema.Struct({ status: Schema.Literal('done'), text: Schema.String }),
  main: Schema.Array(Schema.String),
  subagent: Schema.Struct({ kind: Schema.Literal('subagent'), title: Schema.String, parent: Schema.String }),
  child: Schema.Array(Schema.String),
  mainRequest: ModelRequest,
  childRequest: ModelRequest,
})

harness.test(
  'local workerd: a subagent works in the background and its answer is posted in main as a passive result main does not answer',
  Effect.gen(function* () {
    const { url } = yield* stack
    const name = `subagent-${yield* nextInt}`
    const response = yield* Effect.promise(() => nativeFetch(`${baseUrl(url)}/subagent?name=${name}`))
    const result = yield* Schema.decodeUnknownEffect(SubagentRun)(yield* Effect.promise(() => response.json()))
    expect(result.spawned.text).toBe('done: Started scout.')
    expect(result.subagent).toEqual({ kind: 'subagent', title: 'scout', parent: '1' })
    expect(turns(result.child)).toEqual([
      'pi.user: "find the word"',
      'pi.assistant: [{"type":"text","text":"echo: find the word"}]',
    ])
    const report = [
      { type: 'text', text: '[from subagent scout]' },
      { type: 'text', text: 'echo: find the word' },
    ]
    expect(turns(result.main).at(-1)).toBe(`app.delegate_result: ${JSON.stringify(report)}`)
    expect(turns(result.main).filter((line) => line.includes('echo: echo: find the word'))).toEqual([])
    expect(result.mainRequest.tools).toEqual(expect.arrayContaining(['subagent_spawn', 'ask_user', 'mcp_call']))
    expect(result.childRequest.tools).toEqual(expect.arrayContaining(['mcp_list', 'mcp_call', 'subagent_spawn']))
    expect(result.childRequest.tools).not.toContain('ask_user')
  }),
)

// The conversation tree and the workspace feed (`conversation-checks.ts`).
for (const [title, path, check] of [
  ['a thread branches from a thread, and Close shuts it with everything under it until Reopen', 'tree', treeChecks],
  ["a thread branched from a subagent is the owner's, and keeps it open", 'subagent-branch', subagentBranchChecks],
  ['the workspace feed sends a snapshot, then each change and what each is doing', 'feed', feedChecks],
  ["a subagent's subagent reports to it, and only the final answer reaches main", 'chain', chainChecks],
  ['the owner steers a busy subagent; the answer reports up once and the subagent stays open', 'owner', ownerChecks],
  [
    'Stop and Close reach subagents of subagents and report nothing; a closed one refuses its spawner',
    'close',
    closeChecks,
  ],
  [
    "a Delegate's result is passive unless the spawn asked for synthesis, which gets exactly one answer",
    'synthesis',
    synthesisChecks,
  ],
] as const)
  harness.test(
    `local workerd: ${title}`,
    Effect.gen(function* () {
      const { url } = yield* stack
      const name = `${path}-${yield* nextInt}`
      yield* Effect.promise(() => check(baseUrl(url), name))
    }),
  )

harness.test(
  'local workerd: deleting an agent erases its conversation and application state',
  Effect.gen(function* () {
    const { url } = yield* stack
    const name = `destroy-${yield* nextInt}`
    const response = yield* Effect.promise(() => nativeFetch(`${baseUrl(url)}/destroy?name=${name}`))
    expect(response.status).toBe(200)
    const raw: unknown = yield* Effect.promise(() => response.json())
    const result = yield* Schema.decodeUnknownEffect(Destroy)(raw)
    expect(result.before).toBeGreaterThan(0)
    // Either the result or the isolate abort that `Agent.destroy()` causes; nothing else is acceptable.
    expect(JSON.stringify(result.deleted)).toMatch(/"ok":true|destroyed/u)
    expect(result.after).toBe(0)
    // The revocation row was erased too: the owner request after deletion starts a fresh, active authority.
    expect(result.resident.value.state).toBe('active')
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
    expect(result).toMatchObject({
      operationId,
      session: '1',
      status: 'done',
      text: 'echo: persist this lifecycle fixture input',
    })
    const read = yield* get('/read', LifecycleRead)
    expect(read.messages).toHaveLength(2)
    expect(read.messages).toMatchObject([
      { kind: 'pi.user', model: [{ role: 'user', content: 'persist this lifecycle fixture input' }] },
      {
        kind: 'pi.assistant',
        model: [{ role: 'assistant', content: [{ type: 'text', text: 'echo: persist this lifecycle fixture input' }] }],
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
        new FileURL('../../.alchemy/goblin-native-reconstruction.json', import.meta.url),
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

harness.test(
  'local workerd: canonical host redirects preserve methods, path and query',
  Effect.gen(function* () {
    const { url } = yield* stack
    for (const method of ['GET', 'HEAD', 'POST']) {
      const response = yield* Effect.promise(() =>
        nativeFetch(`${baseUrl(url)}/canonical/path?q=a%2Fb`, {
          method,
          redirect: 'manual',
          ...(method === 'POST' ? { body: 'keep this body' } : {}),
        }),
      )
      expect(response.status).toBe(method === 'POST' ? 308 : 301)
      expect(response.headers.get('location')).toBe('https://goblin.surf/canonical/path?q=a%2Fb')
    }
  }),
)

harness.test(
  'local workerd: MCP custom-domain Origin passes and foreign Origin is refused',
  Effect.gen(function* () {
    const { url } = yield* stack
    const send = (origin: string) =>
      nativeFetch(`${baseUrl(url)}/inbound-host`, {
        method: 'POST',
        headers: {
          origin,
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          'mcp-protocol-version': '2025-06-18',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      })
    const valid = yield* Effect.promise(() => send('https://dev.goblin.surf'))
    expect(valid.status).toBe(200)
    expect(yield* Effect.promise(() => valid.text())).toContain('ask_agent')
    const foreign = yield* Effect.promise(() => send('https://attacker.example'))
    expect(foreign.status).toBe(403)
  }),
)

if (primaryProfile === 'permuted')
  harness.test(
    'local workerd: the stable primary chat writes only to its non-root Pi session',
    stack.pipe(Effect.flatMap(({ url }) => primaryBindingCase(url))),
  )
