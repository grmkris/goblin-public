/** Fixture-only observations; every statement still executes against native D1. */
import { drizzle } from 'drizzle-orm/d1'
import { and, eq, like, sql } from 'drizzle-orm'
import { Schema } from 'effect'
import type { RuntimeEnv } from '../../src/env.ts'
import { requireUserSession } from '../../src/auth/service.ts'
import { readJson } from '../../src/http/body.ts'
import { failureResponse } from '../../src/http/respond.ts'
import { ownerWorkspace, sessionOwnerWorkspace, workspaceState } from '../../src/workspaces/resolution.ts'
import { admissions, rateLimits } from '../../src/workspaces/schema.ts'
import runtime from '../../src/worker.ts'

const Observation = Schema.Struct({ mode: Schema.Literals(['state', 'browser', 'owner']) })
export async function observeWorkspace(request: Request, env: RuntimeEnv): Promise<Response> {
  const { mode } = await readJson(request, Observation)
  // Authenticate before observing, so identity/session reads are outside the workspace query budget.
  const session = await requireUserSession(request, env)
  let reads = 0
  let writes = 0
  const database: D1Database = {
    prepare: (query) => {
      if (/^\s*select\b/iu.test(query)) reads++
      else writes++
      return env.AUTH_DB.prepare(query)
    },
    batch: (statements) => env.AUTH_DB.batch(statements),
    exec: (query) => env.AUTH_DB.exec(query),
    withSession: (constraint) => env.AUTH_DB.withSession(constraint),
    // oxlint-disable-next-line typescript/no-deprecated -- The fixture must implement D1Database's legacy dump member; workspace code never calls it.
    dump: () => env.AUTH_DB.dump(),
  }
  const observed = { ...env, AUTH_DB: database }
  try {
    const result =
      mode === 'state'
        ? await workspaceState(observed, session)
        : mode === 'browser'
          ? await sessionOwnerWorkspace(observed, session, request.headers.get('x-purrable-workspace') ?? undefined)
          : await ownerWorkspace(observed, session.userId)
    return Response.json({ reads, writes, status: 200, result })
  } catch (cause) {
    return Response.json({ reads, writes, status: failureResponse(cause, '/__test/members/queries', 'fixture').status })
  }
}

export async function maintenanceCase(request: Request, env: RuntimeEnv): Promise<Response> {
  const { invitationId } = await readJson(request, Schema.Struct({ invitationId: Schema.String }))
  const db = drizzle(env.AUTH_DB)
  const prefix = `maintenance-${crypto.randomUUID()}-`
  const now = Date.now()
  // These fixtures sort before retained expired rows, making the 1000-row sweep bound observable.
  for (let start = 0; start < 1001; start += 50) {
    const statements = Array.from({ length: Math.min(50, 1001 - start) }, (_, index) => {
      const key = `${prefix}${start + index}`
      return [
        db.insert(admissions).values({
          proofHash: key,
          invitationId,
          invitationVersion: 1,
          email: 'fixture@example.test',
          state: 'active',
          expiresAt: -now,
        }),
        db.insert(rateLimits).values({ key, windowStart: -now, attempts: 5 }),
      ]
    }).flat()
    const [first, ...remaining] = statements
    if (first !== undefined) await db.batch([first, ...remaining])
  }
  await db.batch([
    db.insert(admissions).values({
      proofHash: `${prefix}live`,
      invitationId,
      invitationVersion: 1,
      email: 'fixture@example.test',
      state: 'active',
      expiresAt: now + 60_000,
    }),
    db.insert(admissions).values({
      proofHash: `${prefix}used`,
      invitationId,
      invitationVersion: 1,
      email: 'fixture@example.test',
      state: 'used',
      expiresAt: now + 60_000,
    }),
    db.insert(rateLimits).values({ key: `${prefix}hour`, windowStart: now - 1_800_000, attempts: 20 }),
    db.insert(rateLimits).values({ key: `${prefix}minute`, windowStart: now, attempts: 5 }),
  ])
  const counts = async () => {
    const result = await db.batch([
      db
        .select({ total: sql<number>`count(*)` })
        .from(admissions)
        .where(like(admissions.proofHash, `${prefix}%`)),
      db
        .select({ total: sql<number>`count(*)` })
        .from(rateLimits)
        .where(like(rateLimits.key, `${prefix}%`)),
    ])
    return { admissions: result[0][0]?.total, rates: result[1][0]?.total }
  }
  // Exercise the deployed scheduled entry point with Dodo explicitly unconfigured.
  const withoutBilling = { ...env, DODO_PAYMENTS_API_KEY: '', DODO_PAYMENTS_WEBHOOK_KEY: '' }
  const controller: ScheduledController = { scheduledTime: now, cron: '17 * * * *', noRetry: () => undefined }
  const before = await counts()
  await runtime.scheduled(controller, withoutBilling)
  const first = await counts()
  await runtime.scheduled(controller, withoutBilling)
  const second = await counts()
  await runtime.scheduled(controller, withoutBilling)
  const repeated = await counts()
  const retained = await db
    .select()
    .from(rateLimits)
    .where(and(like(rateLimits.key, `${prefix}%`), eq(rateLimits.attempts, 20)))
    .get()
  return Response.json({ before, first, second, repeated, retainedAttempts: retained?.attempts })
}
