import { and, desc, eq, inArray, lt, notInArray } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import * as Schema from 'effect/Schema'
import { Conflict, NotFound } from '../http/errors.ts'
import {
  appAgentApps,
  appAgentArtifacts,
  appAgentEvents,
  appAgentPowers,
  appAgentUsage,
  appAgentReceipts,
  appAgentReleases,
  appAgentSnapshots,
  appAgentState,
  appAgentViews,
} from '../storage/schema.ts'
import { type Manifest, type Power, requestedPowers } from './manifest.ts'
import { readFiles, storedJson, storedValue } from './stored.ts'

const readLibs = storedJson(Schema.Array(Schema.String), 'view libraries')
const readState = storedValue('app state')
const readSnapshot = storedValue('app snapshot')
const readReceipt = storedValue('app receipt')

type Db = DrizzleSqliteDODatabase
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/** How many of each an app keeps: events (a ring), snapshots, retired and failed releases; receipts' age in ms. */
const KEEP = { events: 200, snapshots: 10, retired: 20, failed: 10, receiptMs: 7 * 24 * 3600 * 1000 } as const

export type EventKind = (typeof appAgentEvents.$inferSelect)['kind']
export type AppRow = typeof appAgentApps.$inferSelect
export type ReleaseRow = typeof appAgentReleases.$inferSelect
export type StateRow = { readonly revision: number; readonly state: unknown; readonly release: string }
export type PowerRow = typeof appAgentPowers.$inferSelect
export type UsageKind = (typeof appAgentUsage.$inferSelect)['kind']

/** Whether the owner's answer to a power is yes now. */
export const isApproved = (row: PowerRow | undefined): boolean =>
  row?.approvedAt != null && (row.revokedAt == null || row.revokedAt < row.approvedAt)

/** The UTC day a time falls on, as usage counts it. */
const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10)

/** A release's view: its CommonJS module, its stylesheet, and the frame bundles it needs besides the core. */
export type AppViewCode = { readonly module: string; readonly css: string; readonly libs: readonly string[] }

/** A release to make active: its code and manifest, and the state the app has once it is. */
export type Activation = {
  readonly app: string
  readonly release: string
  readonly manifest: Manifest
  readonly source: Readonly<Record<string, string>>
  readonly modules: Readonly<Record<string, string>>
  readonly toolchain: string
  readonly note: string | null
  readonly session: string
  readonly callId: string | null
  /** The state after activation; `undefined` keeps the current state as it is. */
  readonly state: unknown
  /** Its view, when the app has one. */
  readonly view: AppViewCode | undefined
  readonly now: number
}

/**
 * Agent apps in the agent's SQLite (ADR 0021). Every write is one short transaction: never held across an isolate
 * call, a model call or any other wait.
 */
export class AgentAppStore {
  readonly #db: Db

  constructor(db: Db) {
    this.#db = db
  }

  app(name: string): AppRow | undefined {
    return this.#db.select().from(appAgentApps).where(eq(appAgentApps.name, name)).get()
  }

  /** Moves an app's home to another conversation. */
  setHome(name: string, session: string, now: number): void {
    this.#db.update(appAgentApps).set({ homeSession: session, updatedAt: now }).where(eq(appAgentApps.name, name)).run()
  }

  apps(): readonly AppRow[] {
    return this.#db.select().from(appAgentApps).orderBy(appAgentApps.createdAt).all()
  }

  release(id: string): ReleaseRow | undefined {
    return this.#db.select().from(appAgentReleases).where(eq(appAgentReleases.id, id)).get()
  }

  /** An app's releases, newest first. */
  releases(app: string, limit = 30): readonly ReleaseRow[] {
    return this.#db
      .select()
      .from(appAgentReleases)
      .where(eq(appAgentReleases.app, app))
      .orderBy(desc(appAgentReleases.createdAt), desc(appAgentReleases.id))
      .limit(limit)
      .all()
  }

  /** A release's modules, as the release isolate loads them. */
  modules(release: string): Readonly<Record<string, string>> | undefined {
    const row = this.#db
      .select({ content: appAgentArtifacts.content })
      .from(appAgentArtifacts)
      .where(and(eq(appAgentArtifacts.release, release), eq(appAgentArtifacts.kind, 'backend')))
      .get()
    return row === undefined ? undefined : readFiles(row.content)
  }

  /** A release's view, when it has one. */
  view(release: string): AppViewCode | undefined {
    const row = this.#db.select().from(appAgentViews).where(eq(appAgentViews.release, release)).get()
    return row === undefined ? undefined : { module: row.module, css: row.css, libs: readLibs(row.libs) }
  }

  state(app: string): StateRow | undefined {
    const row = this.#db.select().from(appAgentState).where(eq(appAgentState.app, app)).get()
    return row === undefined ? undefined : { revision: row.revision, state: readState(row.state), release: row.release }
  }

  /** The revision a committed operation wrote, when there is one. */
  receipt(op: string): { readonly revision: number } | undefined {
    const row = this.#db
      .select({ result: appAgentReceipts.result })
      .from(appAgentReceipts)
      .where(eq(appAgentReceipts.op, op))
      .get()
    if (row === undefined) return undefined
    const result = readReceipt(row.result)
    const revision = typeof result === 'object' && result !== null && 'revision' in result ? result.revision : undefined
    return typeof revision === 'number' ? { revision } : undefined
  }

  /** Every power the app asked for, with the owner's answers. */
  powers(app: string): readonly PowerRow[] {
    return this.#db.select().from(appAgentPowers).where(eq(appAgentPowers.app, app)).all()
  }

  /** Whether the owner approved this power of the app, and has not revoked it. */
  approved(app: string, power: Power): boolean {
    return isApproved(
      this.#db
        .select()
        .from(appAgentPowers)
        .where(
          and(
            eq(appAgentPowers.app, app),
            eq(appAgentPowers.kind, power.kind),
            eq(appAgentPowers.target, power.target),
          ),
        )
        .get(),
    )
  }

  /** The owner approves or revokes a power the app asked for. */
  answer(app: string, power: Power, allowed: boolean, now: number): PowerRow {
    const [row] = this.#db
      .update(appAgentPowers)
      .set(allowed ? { approvedAt: now, revokedAt: null } : { revokedAt: now })
      .where(
        and(eq(appAgentPowers.app, app), eq(appAgentPowers.kind, power.kind), eq(appAgentPowers.target, power.target)),
      )
      .returning()
      .all()
    if (row === undefined) throw new NotFound({ what: `${app} never asked for ${power.kind} ${power.target}` })
    return row
  }

  /** Counts `amount` of today's `kind` for the app unless that passes `cap`; false (and nothing counted) when it would. */
  spend(app: string, kind: UsageKind, amount: number, cap: number, now: number): boolean {
    return this.#db.transaction((tx) => {
      const day = dayOf(now)
      const where = and(eq(appAgentUsage.app, app), eq(appAgentUsage.day, day), eq(appAgentUsage.kind, kind))
      const spent = tx.select({ amount: appAgentUsage.amount }).from(appAgentUsage).where(where).get()?.amount ?? 0
      if (spent + amount > cap) return false
      tx.insert(appAgentUsage)
        .values({ app, day, kind, amount: spent + amount })
        .onConflictDoUpdate({
          target: [appAgentUsage.app, appAgentUsage.day, appAgentUsage.kind],
          set: { amount: spent + amount },
        })
        .run()
      return true
    })
  }

  /** Today's usage of each kind, for the app's detail. */
  usage(app: string, now: number): Readonly<Partial<Record<UsageKind, number>>> {
    return Object.fromEntries(
      this.#db
        .select({ kind: appAgentUsage.kind, amount: appAgentUsage.amount })
        .from(appAgentUsage)
        .where(and(eq(appAgentUsage.app, app), eq(appAgentUsage.day, dayOf(now))))
        .all()
        .map((row) => [row.kind, row.amount]),
    )
  }

  events(app: string, limit = 20): readonly { kind: EventKind; detail: string; createdAt: number }[] {
    return this.#db
      .select({ kind: appAgentEvents.kind, detail: appAgentEvents.detail, createdAt: appAgentEvents.createdAt })
      .from(appAgentEvents)
      .where(eq(appAgentEvents.app, app))
      .orderBy(desc(appAgentEvents.id))
      .limit(limit)
      .all()
      .toReversed()
  }

  snapshots(app: string): readonly { release: string; revision: number; state: unknown }[] {
    return this.#db
      .select()
      .from(appAgentSnapshots)
      .where(eq(appAgentSnapshots.app, app))
      .orderBy(desc(appAgentSnapshots.id))
      .all()
      .map((row) => ({ release: row.release, revision: row.revision, state: readSnapshot(row.state) }))
  }

  event(app: string, kind: EventKind, detail: string, now: number): void {
    this.#db.transaction((tx) => this.#event(tx, app, kind, detail, now))
  }

  /** A build that failed: its sources and why, kept so the same sources fail fast and the agent can read them. */
  failed(input: {
    readonly app: string
    readonly release: string
    readonly source: Readonly<Record<string, string>>
    readonly toolchain: string
    readonly diagnostics: readonly unknown[]
    readonly note: string | null
    readonly session: string
    readonly callId: string | null
    readonly now: number
  }): void {
    this.#db.transaction((tx) => {
      tx.insert(appAgentReleases)
        .values({
          id: input.release,
          app: input.app,
          status: 'failed',
          source: JSON.stringify(input.source),
          toolchain: input.toolchain,
          diagnostics: JSON.stringify(input.diagnostics),
          note: input.note,
          session: input.session,
          callId: input.callId,
          createdAt: input.now,
        })
        .onConflictDoNothing()
        .run()
      this.#event(
        tx,
        input.app,
        'failed',
        `${input.release}: ${String(input.diagnostics.length)} problem(s)`,
        input.now,
      )
      this.#prune(tx, input.app, 'failed', KEEP.failed)
    })
  }

  /**
   * Makes a release active: the previous one retires, the state as it was is snapshotted, and the app's state becomes
   * `activation.state` (unless that is `undefined`). Returns the release's number.
   */
  activate(activation: Activation): number {
    return this.#db.transaction((tx) => {
      const { app, release, now } = activation
      const current = tx.select().from(appAgentState).where(eq(appAgentState.app, app)).get()
      const seq =
        tx
          .select({ seq: appAgentReleases.seq })
          .from(appAgentReleases)
          .where(eq(appAgentReleases.app, app))
          .all()
          .reduce((top, row) => Math.max(top, row.seq ?? 0), 0) + 1
      tx.update(appAgentReleases)
        .set({ status: 'retired' })
        .where(and(eq(appAgentReleases.app, app), eq(appAgentReleases.status, 'active')))
        .run()
      tx.delete(appAgentReleases).where(eq(appAgentReleases.id, release)).run()
      tx.insert(appAgentReleases)
        .values({
          id: release,
          app,
          seq,
          status: 'active',
          manifest: JSON.stringify(activation.manifest),
          source: JSON.stringify(activation.source),
          toolchain: activation.toolchain,
          note: activation.note,
          session: activation.session,
          callId: activation.callId,
          createdAt: now,
        })
        .run()
      tx.insert(appAgentArtifacts)
        .values({ release, kind: 'backend', content: JSON.stringify(activation.modules) })
        .onConflictDoUpdate({
          target: [appAgentArtifacts.release, appAgentArtifacts.kind],
          set: { content: JSON.stringify(activation.modules) },
        })
        .run()
      if (activation.view !== undefined) this.#saveView(tx, release, activation.view)
      this.#ask(tx, app, release, requestedPowers(activation.manifest))
      if (current !== undefined)
        tx.insert(appAgentSnapshots)
          .values({ app, release: current.release, revision: current.revision, state: current.state, createdAt: now })
          .run()
      const nextState = activation.state === undefined ? (current?.state ?? 'null') : JSON.stringify(activation.state)
      const revision = (current?.revision ?? 0) + (activation.state === undefined && current !== undefined ? 0 : 1)
      tx.insert(appAgentState)
        .values({ app, revision, state: nextState, release, updatedAt: now })
        .onConflictDoUpdate({ target: appAgentState.app, set: { revision, state: nextState, release, updatedAt: now } })
        .run()
      tx.insert(appAgentApps)
        .values({
          name: app,
          title: activation.manifest.title,
          description: activation.manifest.description,
          homeSession: activation.session,
          activeRelease: release,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: appAgentApps.name,
          set: {
            title: activation.manifest.title,
            description: activation.manifest.description,
            activeRelease: release,
            updatedAt: now,
          },
        })
        .run()
      this.#event(tx, app, 'build', `v${String(seq)} ${release} active`, now)
      this.#pruneSnapshots(tx, app)
      this.#prune(tx, app, 'retired', KEEP.retired)
      return seq
    })
  }

  /**
   * Commits `state` as the next revision if the state is still at `revision`, with the receipt of `op`. A changed
   * revision is a conflict: nothing is written.
   */
  commit(input: {
    readonly app: string
    readonly revision: number
    readonly state: unknown
    readonly release: string
    readonly op: string
    readonly result: unknown
    readonly event: string
    readonly now: number
  }): void {
    this.#db.transaction((tx) => {
      const moved = tx
        .update(appAgentState)
        .set({ revision: input.revision + 1, state: JSON.stringify(input.state), updatedAt: input.now })
        .where(
          and(
            eq(appAgentState.app, input.app),
            eq(appAgentState.revision, input.revision),
            eq(appAgentState.release, input.release),
          ),
        )
        .returning({ revision: appAgentState.revision })
        .all()
      if (moved.length === 0) throw new Conflict({ reason: 'the app changed during the call' })
      tx.insert(appAgentReceipts)
        .values({ op: input.op, app: input.app, result: JSON.stringify(input.result), createdAt: input.now })
        .run()
      tx.delete(appAgentReceipts)
        .where(lt(appAgentReceipts.createdAt, input.now - KEEP.receiptMs))
        .run()
      this.#event(tx, input.app, 'call', input.event, input.now)
    })
  }

  /** Makes a retired release active again with `state` as the next revision (or the state kept as it is). */
  rollback(input: {
    readonly app: string
    readonly release: string
    readonly state: unknown
    readonly now: number
  }): void {
    this.#db.transaction((tx) => {
      const current = tx.select().from(appAgentState).where(eq(appAgentState.app, input.app)).get()
      if (current === undefined) throw new Conflict({ reason: 'the app has no state' })
      tx.insert(appAgentSnapshots)
        .values({
          app: input.app,
          release: current.release,
          revision: current.revision,
          state: current.state,
          createdAt: input.now,
        })
        .run()
      tx.update(appAgentReleases)
        .set({ status: 'retired' })
        .where(and(eq(appAgentReleases.app, input.app), eq(appAgentReleases.status, 'active')))
        .run()
      tx.update(appAgentReleases).set({ status: 'active' }).where(eq(appAgentReleases.id, input.release)).run()
      const state = input.state === undefined ? current.state : JSON.stringify(input.state)
      const revision = current.revision + (input.state === undefined ? 0 : 1)
      tx.update(appAgentState)
        .set({ revision, state, release: input.release, updatedAt: input.now })
        .where(eq(appAgentState.app, input.app))
        .run()
      tx.update(appAgentApps)
        .set({ activeRelease: input.release, updatedAt: input.now })
        .where(eq(appAgentApps.name, input.app))
        .run()
      this.#event(tx, input.app, 'rollback', `${input.release} active again`, input.now)
      this.#pruneSnapshots(tx, input.app)
    })
  }

  /** Records the powers a release asks for; the owner's earlier answers stand. */
  #ask(tx: Tx, app: string, release: string, powers: readonly Power[]): void {
    for (const power of powers)
      tx.insert(appAgentPowers)
        .values({ app, kind: power.kind, target: power.target, requestedBy: release })
        .onConflictDoUpdate({
          target: [appAgentPowers.app, appAgentPowers.kind, appAgentPowers.target],
          set: { requestedBy: release },
        })
        .run()
  }

  #saveView(tx: Tx, release: string, code: AppViewCode): void {
    const view = { ...code, libs: JSON.stringify(code.libs) }
    tx.insert(appAgentViews)
      .values({ release, ...view })
      .onConflictDoUpdate({ target: appAgentViews.release, set: view })
      .run()
  }

  #event(tx: Tx, app: string, kind: EventKind, detail: string, now: number): void {
    tx.insert(appAgentEvents)
      .values({ app, kind, detail: detail.slice(0, 2000), createdAt: now })
      .run()
    const kept = tx
      .select({ id: appAgentEvents.id })
      .from(appAgentEvents)
      .where(eq(appAgentEvents.app, app))
      .orderBy(desc(appAgentEvents.id))
      .limit(KEEP.events)
      .all()
      .map((row) => row.id)
    tx.delete(appAgentEvents)
      .where(and(eq(appAgentEvents.app, app), notInArray(appAgentEvents.id, kept)))
      .run()
  }

  #pruneSnapshots(tx: Tx, app: string): void {
    const kept = tx
      .select({ id: appAgentSnapshots.id })
      .from(appAgentSnapshots)
      .where(eq(appAgentSnapshots.app, app))
      .orderBy(desc(appAgentSnapshots.id))
      .limit(KEEP.snapshots)
      .all()
      .map((row) => row.id)
    tx.delete(appAgentSnapshots)
      .where(and(eq(appAgentSnapshots.app, app), notInArray(appAgentSnapshots.id, kept)))
      .run()
  }

  /** Keeps an app's newest `keep` releases of `status`, with their code. */
  #prune(tx: Tx, app: string, status: 'retired' | 'failed', keep: number): void {
    const old = tx
      .select({ id: appAgentReleases.id })
      .from(appAgentReleases)
      .where(and(eq(appAgentReleases.app, app), eq(appAgentReleases.status, status)))
      .orderBy(desc(appAgentReleases.createdAt))
      .limit(1000)
      .offset(keep)
      .all()
      .map((row) => row.id)
    if (old.length === 0) return
    tx.delete(appAgentArtifacts).where(inArray(appAgentArtifacts.release, old)).run()
    tx.delete(appAgentViews).where(inArray(appAgentViews.release, old)).run()
    tx.delete(appAgentReleases).where(inArray(appAgentReleases.id, old)).run()
  }
}
