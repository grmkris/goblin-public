import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import * as Schema from 'effect/Schema'
import { RoutineDefinition, RoutineRunView } from '@goblin/contracts'
import { Conflict, NotFound } from '../http/errors.ts'
import {
  appRoutines,
  appRoutineRuns,
  appRoutineUsage,
  appSubmissionOrigins,
  appInteractions,
  appRoutineAnswers,
} from '../storage/routines.ts'
import type { CredentialCipher } from '../mcp/cipher.ts'
import type { QuestionSpec } from '@goblin/contracts'
import { appUsageDaily } from '../storage/schema.ts'
import { RoutineStore } from './store.ts'
import { routineSummary } from './summary.ts'

export type RoutineRun = typeof appRoutineRuns.$inferSelect
export type Firing = {
  readonly routineId: string
  readonly revision: number
  readonly operationId: string
  readonly source: RoutineRun['source']
  readonly firedAt: number
  readonly schedule?: { expectedAt: number; nextAt: number | null; missed: number } | undefined
  readonly event?:
    | {
        readonly eventId: string
        readonly subscriptionId: string
        readonly webhookId: string
        readonly dataSealed: string
      }
    | undefined
}
export const definitionOf = (run: RoutineRun): RoutineDefinition =>
  Schema.decodeUnknownSync(RoutineDefinition)(JSON.parse(run.definitionJson))
export const runView = (run: RoutineRun): RoutineRunView => Schema.decodeUnknownSync(RoutineRunView)(run)
const LIVE = ['admitted', 'running', 'waiting_owner'] as const

function requireSameFiring(previous: RoutineRun, firing: Firing): void {
  const sameEvent =
    firing.source === 'event' &&
    previous.source === 'event' &&
    previous.routineId === firing.routineId &&
    previous.eventId === firing.event?.eventId
  if (
    !sameEvent &&
    (previous.routineId !== firing.routineId ||
      previous.revision !== firing.revision ||
      previous.source !== firing.source)
  )
    throw new Conflict({ reason: 'run operation id reused' })
}

function newRun(firing: Firing, id: string, skip: string | undefined, at: number, definitionJson: string): RoutineRun {
  const definition = Schema.decodeUnknownSync(RoutineDefinition)(JSON.parse(definitionJson))
  return {
    id,
    routineId: firing.routineId,
    revision: firing.revision,
    operationId: firing.operationId,
    source: firing.source,
    firedAt: firing.firedAt,
    eventId: firing.event?.eventId ?? null,
    subscriptionId: firing.event?.subscriptionId ?? null,
    webhookId: firing.event?.webhookId ?? null,
    definitionJson,
    eventDataSealed: firing.event?.dataSealed ?? null,
    sessionId: null,
    admittedAt: at,
    deadlineAt: at + definition.budget.runtimeSeconds * 1000,
    state: skip === undefined ? 'admitted' : 'skipped',
    outcome: skip ?? null,
    summary: skip ?? null,
    reportRequestId: `routine-report:${id}`,
    reportAcceptedAt: null,
    notificationText: skip === undefined ? null : `Routine skipped: ${skip}`,
    notificationState: 'none',
    notificationReceipt: null,
    notificationServerId: null,
    notificationAttempts: 0,
    notificationNextAt: 0,
    createdAt: at,
    updatedAt: at,
  }
}

/** Application metadata only: Pi owns the run task and conversation. No transaction spans an await. */
export class RoutineRunStore {
  readonly db: DrizzleSqliteDODatabase
  readonly owner: string
  constructor(db: DrizzleSqliteDODatabase, owner: string) {
    this.db = db
    this.owner = owner
  }

  async ask(
    session: string,
    callId: string,
    questions: readonly QuestionSpec[],
    cipher: CredentialCipher,
    at: number,
  ): Promise<void> {
    const run = this.session(session)
    if (run === undefined) throw new NotFound({ what: 'routine run' })
    const id = `routine-question:${run.id}:${callId}`
    const intent = await cipher.encrypt(JSON.stringify(questions), id)
    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(questions))),
    )
    const requestHash = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
    this.db.transaction(() => {
      const current = this.get(run.id)
      if (current.deadlineAt <= at || !LIVE.some((state) => state === current.state))
        throw new Conflict({ reason: 'routine question arrived after settlement' })
      const previous = this.db.select().from(appInteractions).where(eq(appInteractions.id, id)).get()
      if (previous !== undefined) {
        if (previous.requestHash !== requestHash) throw new Conflict({ reason: 'routine question call id reused' })
        return
      }
      this.db
        .insert(appInteractions)
        .values({
          id,
          sessionId: session,
          runId: run.id,
          callId,
          requesterUserId: this.owner,
          answererUserId: this.owner,
          intent,
          requestHash,
          state: 'pending',
          expiresAt: Math.min(at + 86_400_000, run.deadlineAt),
          decisionOperationId: null,
        })
        .onConflictDoNothing()
        .run()
      this.db
        .update(appRoutineRuns)
        .set({ state: 'waiting_owner', updatedAt: at })
        .where(eq(appRoutineRuns.id, run.id))
        .run()
    })
  }
  resume(session: string, operationId: string, at: number, answerHash: string): RoutineRun | undefined {
    const run = this.session(session)
    if (run === undefined) return undefined
    const requestJson = JSON.stringify({ session, answerHash })
    const receipt = this.db
      .select()
      .from(appRoutineAnswers)
      .where(and(eq(appRoutineAnswers.runId, run.id), eq(appRoutineAnswers.operationId, operationId)))
      .get()
    if (receipt !== undefined) {
      if (receipt.requestJson !== requestJson) throw new Conflict({ reason: 'answer operation id reused' })
      return run
    }
    if (run.deadlineAt <= at) throw new Conflict({ reason: 'routine deadline expired' })
    const answered = this.db
      .select()
      .from(appInteractions)
      .where(and(eq(appInteractions.runId, run.id), eq(appInteractions.decisionOperationId, operationId)))
      .get()
    if (answered !== undefined) return run
    if (run.state !== 'waiting_owner') throw new Conflict({ reason: 'routine run is settled' })
    const question = this.db
      .select()
      .from(appInteractions)
      .where(and(eq(appInteractions.runId, run.id), eq(appInteractions.state, 'pending')))
      .get()
    if (question === undefined || question.expiresAt <= at) throw new Conflict({ reason: 'routine question expired' })
    if (
      this.live().filter((live) => live.state !== 'waiting_owner').length >=
      new RoutineStore(this.db, this.owner).settings().maxRunning
    )
      throw new Conflict({ reason: 'running routine limit' })
    this.db.transaction(() => {
      this.db
        .insert(appRoutineAnswers)
        .values({ runId: run.id, operationId, requestJson, interactionId: question.id })
        .run()
      this.db
        .update(appInteractions)
        .set({ state: 'answered', decisionOperationId: operationId })
        .where(eq(appInteractions.id, question.id))
        .run()
      this.db.update(appRoutineRuns).set({ state: 'running', updatedAt: at }).where(eq(appRoutineRuns.id, run.id)).run()
    })
    return this.get(run.id)
  }

  get(id: string): RoutineRun {
    const row = this.db.select().from(appRoutineRuns).where(eq(appRoutineRuns.id, id)).get()
    if (row === undefined) throw new NotFound({ what: 'routine run' })
    return row
  }
  session(session: string): RoutineRun | undefined {
    return this.db.select().from(appRoutineRuns).where(eq(appRoutineRuns.sessionId, session)).get()
  }
  list(routineId: string): RoutineRunView[] {
    new RoutineStore(this.db, this.owner).get(routineId)
    return this.db
      .select()
      .from(appRoutineRuns)
      .where(eq(appRoutineRuns.routineId, routineId))
      .orderBy(desc(appRoutineRuns.createdAt))
      .limit(50)
      .all()
      .map(runView)
  }
  live(): RoutineRun[] {
    return this.db.select().from(appRoutineRuns).where(inArray(appRoutineRuns.state, LIVE)).limit(100).all()
  }
  unfinishedReports(): RoutineRun[] {
    return this.db
      .select()
      .from(appRoutineRuns)
      .where(
        and(
          inArray(appRoutineRuns.state, ['completed', 'failed', 'skipped', 'stopped']),
          sql`${appRoutineRuns.reportAcceptedAt} IS NULL`,
        ),
      )
      .limit(100)
      .all()
  }
  claim(
    firing: Firing,
    id: string,
    skip: string | undefined,
    at: number,
  ): { readonly run: RoutineRun; readonly created: boolean } {
    return this.db.transaction(() => {
      const previous = this.db
        .select()
        .from(appRoutineRuns)
        .where(eq(appRoutineRuns.operationId, firing.operationId))
        .get()
      if (previous !== undefined) {
        requireSameFiring(previous, firing)
        return { run: previous, created: false }
      }
      const routine = new RoutineStore(this.db, this.owner).get(firing.routineId)
      if (routine.revision !== firing.revision || routine.state !== 'active' || routine.confirmedAt === null)
        throw new Conflict({ reason: 'routine is not active at this revision' })
      if (skip === undefined) {
        this.#requireSlot(routine.id)
        if (firing.source === 'event') this.#requireEventSpacing(at)
      }
      const run = newRun(firing, id, skip, at, routine.definitionJson)
      this.db.insert(appRoutineRuns).values(run).run()
      if (firing.schedule !== undefined)
        new RoutineStore(this.db, this.owner).advance(
          { id: routine.id, revision: routine.revision, ...firing.schedule },
          at,
        )
      this.db
        .update(appRoutines)
        .set({ lastFireAt: firing.firedAt, updatedAt: at })
        .where(eq(appRoutines.id, routine.id))
        .run()
      return { run, created: true }
    })
  }
  #requireEventSpacing(at: number): void {
    const latest = this.db
      .select({ at: sql<number | null>`MAX(${appRoutineRuns.admittedAt})` })
      .from(appRoutineRuns)
      .where(and(eq(appRoutineRuns.source, 'event'), sql`${appRoutineRuns.state} != 'skipped'`))
      .get()?.at
    if (latest !== null && latest !== undefined && latest > at - 60_000)
      throw new Conflict({ reason: 'event run spacing limit' })
  }
  #requireSlot(routineId: string): void {
    const live = this.live()
    if (live.some((run) => run.routineId === routineId)) throw new Conflict({ reason: 'routine already running' })
    if (
      live.filter((run) => run.state !== 'waiting_owner').length >=
      new RoutineStore(this.db, this.owner).settings().maxRunning
    )
      throw new Conflict({ reason: 'running routine limit' })
  }
  bind(id: string, sessionId: string, at: number): void {
    this.db.transaction(() => {
      const before = this.get(id)
      if (!LIVE.some((state) => state === before.state)) return
      if (before.sessionId !== null && before.sessionId !== sessionId)
        throw new Conflict({ reason: 'routine session changed' })
      this.db
        .update(appRoutineRuns)
        .set({ sessionId, state: before.state === 'admitted' ? 'running' : before.state, updatedAt: at })
        .where(eq(appRoutineRuns.id, id))
        .run()
      const run = this.get(id)
      this.db
        .insert(appSubmissionOrigins)
        .values({
          sessionId,
          operationId: run.operationId,
          principalUserId: this.owner,
          role: 'owner',
          source: 'routine',
          createdAt: at,
        })
        .onConflictDoNothing()
        .run()
    })
  }
  settle(id: string, state: 'completed' | 'failed' | 'stopped' | 'skipped', summary: string, at: number): void {
    const run = this.get(id)
    if (!LIVE.some((value) => value === run.state)) return
    const safeSummary = routineSummary(summary)
    this.db
      .update(appRoutineRuns)
      .set({
        state,
        outcome: state,
        summary: safeSummary,
        notificationText: `Routine ${state}: ${safeSummary.slice(0, 500)}`,
        notificationState: definitionOf(run).notifyTelegram && state !== 'skipped' ? 'pending' : 'none',
        updatedAt: at,
      })
      .where(eq(appRoutineRuns.id, id))
      .run()
    this.db
      .update(appInteractions)
      .set({ state: 'expired' })
      .where(and(eq(appInteractions.runId, id), eq(appInteractions.state, 'pending')))
      .run()
  }
  reported(id: string, at: number): void {
    this.db.update(appRoutineRuns).set({ reportAcceptedAt: at }).where(eq(appRoutineRuns.id, id)).run()
  }
  notifications(at: number): RoutineRun[] {
    return this.db
      .select()
      .from(appRoutineRuns)
      .where(
        and(
          eq(appRoutineRuns.notificationState, 'pending'),
          sql`${appRoutineRuns.notificationNextAt} <= ${at}`,
          sql`${appRoutineRuns.reportAcceptedAt} IS NOT NULL`,
        ),
      )
      .limit(100)
      .all()
  }
  notification(
    id: string,
    values: { state: string; serverId: string | null; receipt: string | null; nextAt: number; attempt: number },
  ): void {
    this.db
      .update(appRoutineRuns)
      .set({
        notificationState: values.state,
        notificationServerId: values.serverId,
        notificationReceipt: values.receipt,
        notificationNextAt: values.nextAt,
      })
      .where(and(eq(appRoutineRuns.id, id), eq(appRoutineRuns.notificationAttempts, values.attempt)))
      .run()
  }
  claimNotification(id: string, attempts: number, serverId: string | null, at: number): boolean {
    return (
      this.db
        .update(appRoutineRuns)
        .set({
          notificationServerId: serverId,
          notificationAttempts: attempts + 1,
          notificationNextAt: at + 30_000,
        })
        .where(
          and(
            eq(appRoutineRuns.id, id),
            eq(appRoutineRuns.notificationState, 'pending'),
            eq(appRoutineRuns.notificationAttempts, attempts),
            sql`${appRoutineRuns.notificationNextAt} <= ${at}`,
          ),
        )
        .returning({ id: appRoutineRuns.id })
        .all().length === 1
    )
  }
  used(id: string, at: number): { readonly run: number; readonly day: number } {
    const run = this.get(id)
    const utcDay = new Date(at).toISOString().slice(0, 10)
    const totals = this.db
      .select({
        run: sql<number>`COALESCE(SUM(CASE WHEN ${appRoutineUsage.runId} = ${id} THEN ${appRoutineUsage.tokens} ELSE 0 END), 0)`,
        day: sql<number>`COALESCE(SUM(CASE WHEN ${appRoutineUsage.utcDay} = ${utcDay} THEN ${appRoutineUsage.tokens} ELSE 0 END), 0)`,
      })
      .from(appRoutineUsage)
      .innerJoin(appRoutineRuns, eq(appRoutineUsage.runId, appRoutineRuns.id))
      .where(eq(appRoutineRuns.routineId, run.routineId))
      .get()
    return totals ?? { run: 0, day: 0 }
  }
  /** Committed usage deltas have stable receipt keys; retries never charge the run or account twice. */
  recordUsage(id: string, key: string, tokens: number, weight: number, at: number): void {
    if (!Number.isFinite(tokens) || tokens <= 0) return
    this.db.transaction(() => {
      const exists = this.db
        .select()
        .from(appRoutineUsage)
        .where(and(eq(appRoutineUsage.runId, id), eq(appRoutineUsage.sourceKey, key)))
        .get()
      if (exists !== undefined) return
      const utcDay = new Date(at).toISOString().slice(0, 10)
      this.db
        .insert(appRoutineUsage)
        .values({ runId: id, sourceKey: key, utcDay, tokens: Math.ceil(tokens * weight), committedAt: at })
        .run()
      this.db
        .insert(appUsageDaily)
        .values({ day: utcDay, tokens: Math.ceil(tokens * weight), updatedAt: Math.floor(at / 1000) })
        .onConflictDoUpdate({
          target: appUsageDaily.day,
          set: { tokens: sql`${appUsageDaily.tokens} + ${Math.ceil(tokens * weight)}` },
        })
        .run()
    })
  }
}
