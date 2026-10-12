import { OnboardingStep, type OnboardingChange, type OnboardingStatus } from '@goblin/contracts'
import { eq } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { appOnboarding, appOnboardingConnects } from '../storage/onboarding.ts'

/** What the owner did with Start: its status, the steps they went through, and when they sent the kickoff. */
export type OnboardingRecord = {
  readonly status: OnboardingStatus
  readonly steps: readonly OnboardingStep[]
  readonly kickoffAt: number | undefined
}

const decodeSteps = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(OnboardingStep)))
const decodeStep = Schema.decodeUnknownOption(OnboardingStep)

/** Where a sign-in Start began comes back to, and whether to allow the server's recommended tools then. */
export type StartedConnect = { readonly step: OnboardingStep; readonly recommend: boolean }

/**
 * A sign-in noted longer ago than this (seconds) comes back to Connections, as any other does. An hour, as long as the
 * pending authorization lives: the wallet's consent includes its setup and funding, which can take a while.
 */
const CONNECT_FRESH = 60 * 60
const decodeStatus = Schema.decodeUnknownOption(Schema.Literals(['open', 'done', 'skipped']))

/** Start's one row (ADR 0048). Nothing is stored until the owner acts, so an untouched Start is derived instead. */
export class OnboardingStore {
  readonly #db: DrizzleSqliteDODatabase
  constructor(db: DrizzleSqliteDODatabase) {
    this.#db = db
  }

  get(): OnboardingRecord | undefined {
    const row = this.#db.select().from(appOnboarding).where(eq(appOnboarding.id, 1)).get()
    if (row === undefined) return undefined
    return {
      status: Option.getOrElse(decodeStatus(row.status), () => 'open' as const),
      steps: Option.getOrElse(decodeSteps(row.steps), () => []),
      kickoffAt: row.kickoffAt ?? undefined,
    }
  }

  /**
   * Applies the owner's change in one statement: a new status, a step they went through (kept once), the kickoff's
   * time (kept from the first). A change without a status keeps the current one, `open` when there was none.
   */
  apply(change: OnboardingChange, now: number): OnboardingRecord {
    const current = this.get()
    const steps = [...(current?.steps ?? [])]
    if (change.step !== undefined && !steps.includes(change.step)) steps.push(change.step)
    const next: OnboardingRecord = {
      status: change.status ?? current?.status ?? 'open',
      steps,
      kickoffAt: current?.kickoffAt ?? (change.kickoff === true ? now : undefined),
    }
    const values = { status: next.status, steps: JSON.stringify(next.steps), kickoffAt: next.kickoffAt ?? null }
    this.#db
      .insert(appOnboarding)
      .values({ id: 1, ...values, updatedAt: now })
      .onConflictDoUpdate({ target: appOnboarding.id, set: { ...values, updatedAt: now } })
      .run()
    return next
  }

  /** Notes that Start sent the owner to sign in to `connectionId`, replacing an earlier note for it. */
  noteConnect(connectionId: string, started: StartedConnect, now: number): void {
    const values = { step: started.step, recommend: started.recommend ? 1 : 0, createdAt: now }
    this.#db
      .insert(appOnboardingConnects)
      .values({ connectionId, ...values })
      .onConflictDoUpdate({ target: appOnboardingConnects.connectionId, set: values })
      .run()
  }

  /** Takes the note for `connectionId`: it is gone afterwards, and none comes back for one older than an hour. */
  takeConnect(connectionId: string, now: number): StartedConnect | undefined {
    const row = this.#db
      .delete(appOnboardingConnects)
      .where(eq(appOnboardingConnects.connectionId, connectionId))
      .returning()
      .get()
    if (row === undefined || now - row.createdAt > CONNECT_FRESH) return undefined
    return Option.getOrUndefined(Option.map(decodeStep(row.step), (step) => ({ step, recommend: row.recommend === 1 })))
  }
}
