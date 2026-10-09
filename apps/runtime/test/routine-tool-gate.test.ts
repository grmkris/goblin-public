import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { Entitlements } from '../src/billing/gates.ts'
import type { AccountPlan } from '../src/billing/reconcile.ts'
import { Budget } from '../src/budget.ts'
import { type AppError, Internal, NotFound, ResidentInactive, SubscriptionRequired } from '../src/http/errors.ts'
import { Resident } from '../src/mcp/service.ts'
import { routineToolVerdict } from '../src/pi/routine-budget.ts'
import type { RoutineRun } from '../src/routines/runs.ts'
import { RoutineRuns, RoutineUsage } from '../src/routines/service.ts'

const PLAN: AccountPlan = {
  active: true,
  source: 'override',
  until: null,
  dailyCredits: 800,
  status: 'active',
  hasCustomer: false,
  cancelAtPeriodEnd: false,
}
const DEFINITION = JSON.stringify({
  title: 'Daily',
  prompt: 'Report.',
  trigger: { kind: 'cron', expression: '0 9 * * *' },
  timezone: 'UTC',
  notifyTelegram: false,
  allowedTools: [],
  budget: { tokensPerRun: 1000, tokensPerDay: 2000, runtimeSeconds: 60 },
})

/** A stand-in implementing only the members the gate reaches. */
const fake = <T>(members: Partial<T>): T =>
  // SAFETY: each fake below is given every member requireRoutine and the verdict call on it.
  members as T

type Gate = {
  readonly plan?: Effect.Effect<AccountPlan, Internal | SubscriptionRequired>
  readonly resident?: Effect.Effect<void, AppError>
  readonly run?: Effect.Effect<RoutineRun, AppError>
  readonly used?: number
}

/** The gate's services: a running routine in session `s1`, and whatever `gate` changes. */
const services = (gate: Gate = {}) => {
  const run = fake<RoutineRun>({ id: 'rr_1', state: 'running', deadlineAt: Number.MAX_SAFE_INTEGER, sessionId: null })
  const runWithDefinition = { ...run, definitionJson: DEFINITION }
  return Layer.mergeAll(
    Layer.succeed(Entitlements, {
      state: () => Effect.succeed(PLAN),
      require: () => gate.plan ?? Effect.succeed(PLAN),
    }),
    Layer.succeed(Resident, fake<typeof Resident.Service>({ require: () => gate.resident ?? Effect.void })),
    Layer.succeed(
      RoutineRuns,
      fake<typeof RoutineRuns.Service>({
        session: (session) => Effect.succeed(session === 's1' ? runWithDefinition : undefined),
        get: () => gate.run ?? Effect.succeed(runWithDefinition),
        used: () => Effect.succeed({ run: gate.used ?? 0, day: gate.used ?? 0 }),
      }),
    ),
    Layer.succeed(RoutineUsage, fake<typeof RoutineUsage.Service>({ snapshot: () => Effect.void })),
    Layer.succeed(Budget, fake<typeof Budget.Service>({ require: () => Effect.void })),
  )
}

const verdict = (session: string, gate?: Gate) => routineToolVerdict(session).pipe(Effect.provide(services(gate)))

describe("a routine's tool gate (R2)", () => {
  it.effect('lets a running routine with budget left call a tool', () =>
    Effect.gen(function* () {
      expect(yield* verdict('s1')).toBe('open')
    }),
  )

  it.effect("refuses on the routine's own limits and authority, and outside a routine run", () =>
    Effect.gen(function* () {
      expect(yield* verdict('other')).toBe('refused')
      expect(yield* verdict('s1', { used: 1000 })).toBe('refused')
      expect(yield* verdict('s1', { plan: Effect.fail(new SubscriptionRequired({ subscribe: '/subscribe' })) })).toBe(
        'refused',
      )
      expect(yield* verdict('s1', { resident: Effect.fail(new ResidentInactive({ state: 'revoked' })) })).toBe(
        'refused',
      )
    }),
  )

  it.effect('blocks as a failed check, not a refusal, when storage or auth D1 fails', () =>
    Effect.gen(function* () {
      expect(yield* verdict('s1', { plan: Effect.fail(new Internal({ reason: 'billing storage unavailable' })) })).toBe(
        'failed',
      )
      expect(yield* verdict('s1', { run: Effect.fail(new NotFound({ what: 'routine run' })) })).toBe('failed')
      expect(yield* verdict('s1', { run: Effect.die(new Error('SQLITE_BUSY')) })).toBe('failed')
    }),
  )
})
