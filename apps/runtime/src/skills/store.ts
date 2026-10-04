import { and, count, eq, gte, inArray } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import * as Schema from 'effect/Schema'
import { appSkillActivations, appSkillDrafts, appSkillFiles, appSkillSources } from '../storage/schema.ts'
import { SkillEntry } from './protocol.ts'

/** A file is cached only up to this size: a Durable Object SQLite row stays well under its 2 MB limit. */
export const MAX_CACHED_FILE_BYTES = 1_048_576

/** What one conversation activated: the server, and the entry exactly as it was loaded. */
export type Activation = { readonly serverId: string; readonly entry: SkillEntry; readonly activatedAt: number }

/** The skills state the Agent DO keeps: owner switches, per-conversation activations, verified bytes. */
export interface SkillState {
  /** Whether the owner uses skills from this server. */
  enabled(serverId: string): boolean
  sources(): readonly string[]
  setEnabled(serverId: string, enabled: boolean, now: number): void
  activation(sessionId: string, serverId: string, uri: string): Activation | undefined
  activations(sessionId: string): readonly Activation[]
  activate(sessionId: string, activation: Activation): void
  /** Cached bytes by digest; the caller verifies them again before use. */
  file(digest: string): Uint8Array | undefined
  storeFile(digest: string, bytes: Uint8Array, now: number): void
}

const encodeEntry = Schema.encodeSync(Schema.fromJsonString(SkillEntry))
const decodeEntry = Schema.decodeUnknownSync(Schema.fromJsonString(SkillEntry))
const toBase64 = (bytes: Uint8Array) => btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0))

export class SqliteSkillState implements SkillState {
  readonly #db: DrizzleSqliteDODatabase
  constructor(db: DrizzleSqliteDODatabase) {
    this.#db = db
  }

  enabled(serverId: string): boolean {
    return (
      this.#db
        .select({ serverId: appSkillSources.serverId })
        .from(appSkillSources)
        .where(eq(appSkillSources.serverId, serverId))
        .get() !== undefined
    )
  }

  sources(): readonly string[] {
    return this.#db
      .select({ serverId: appSkillSources.serverId })
      .from(appSkillSources)
      .all()
      .map((row) => row.serverId)
  }

  setEnabled(serverId: string, enabled: boolean, now: number): void {
    if (enabled) {
      this.#db.insert(appSkillSources).values({ serverId, enabledAt: now }).onConflictDoNothing().run()
      return
    }
    this.#db.delete(appSkillSources).where(eq(appSkillSources.serverId, serverId)).run()
  }

  activation(sessionId: string, serverId: string, uri: string): Activation | undefined {
    const row = this.#db
      .select()
      .from(appSkillActivations)
      .where(
        and(
          eq(appSkillActivations.sessionId, sessionId),
          eq(appSkillActivations.serverId, serverId),
          eq(appSkillActivations.uri, uri),
        ),
      )
      .get()
    return row === undefined ? undefined : { serverId, entry: decodeEntry(row.entry), activatedAt: row.activatedAt }
  }

  activations(sessionId: string): readonly Activation[] {
    return this.#db
      .select()
      .from(appSkillActivations)
      .where(eq(appSkillActivations.sessionId, sessionId))
      .all()
      .map((row) => ({ serverId: row.serverId, entry: decodeEntry(row.entry), activatedAt: row.activatedAt }))
  }

  activate(sessionId: string, activation: Activation): void {
    const values = {
      sessionId,
      serverId: activation.serverId,
      uri: activation.entry.uri,
      entry: encodeEntry(activation.entry),
      activatedAt: activation.activatedAt,
    }
    this.#db
      .insert(appSkillActivations)
      .values(values)
      .onConflictDoUpdate({
        target: [appSkillActivations.sessionId, appSkillActivations.serverId, appSkillActivations.uri],
        set: { entry: values.entry, activatedAt: values.activatedAt },
      })
      .run()
  }

  file(digest: string): Uint8Array | undefined {
    const row = this.#db
      .select({ content: appSkillFiles.content })
      .from(appSkillFiles)
      .where(eq(appSkillFiles.digest, digest))
      .get()
    return row === undefined ? undefined : fromBase64(row.content)
  }

  storeFile(digest: string, bytes: Uint8Array, now: number): void {
    if (bytes.byteLength > MAX_CACHED_FILE_BYTES) return
    this.#db
      .insert(appSkillFiles)
      .values({ digest, content: toBase64(bytes), storedAt: now })
      .onConflictDoNothing()
      .run()
  }
}

export type DraftStatus = 'open' | 'accepted' | 'rejected'
/** A draft the agent proposed: its content hash, the library, the skill it names or improves, and its review. */
export type DraftRecord = {
  readonly contentHash: string
  readonly serverId: string
  readonly name: string
  readonly baseUri: string | undefined
  readonly draftId: string | undefined
  readonly status: DraftStatus
}

/** The learner's record of the drafts it proposed (skills/learner.ts). */
export interface DraftLog {
  /** Drafts proposed since `since` (ms). */
  countSince(since: number): number
  /** A draft with this content was proposed before. */
  known(contentHash: string): boolean
  /** A draft for this skill waits for review, or one for the same base was rejected. */
  blocked(serverId: string, name: string, baseUri: string | undefined): boolean
  open(limit: number): readonly DraftRecord[]
  add(record: DraftRecord, now: number): void
  update(contentHash: string, change: { readonly draftId?: string; readonly status: DraftStatus }, now: number): void
  forget(contentHash: string): void
}

export class SqliteDraftLog implements DraftLog {
  readonly #db: DrizzleSqliteDODatabase
  constructor(db: DrizzleSqliteDODatabase) {
    this.#db = db
  }

  countSince(since: number): number {
    return (
      this.#db.select({ n: count() }).from(appSkillDrafts).where(gte(appSkillDrafts.createdAt, since)).get()?.n ?? 0
    )
  }

  known(contentHash: string): boolean {
    return (
      this.#db
        .select({ hash: appSkillDrafts.contentHash })
        .from(appSkillDrafts)
        .where(eq(appSkillDrafts.contentHash, contentHash))
        .get() !== undefined
    )
  }

  blocked(serverId: string, name: string, baseUri: string | undefined): boolean {
    return this.#db
      .select({ status: appSkillDrafts.status, baseUri: appSkillDrafts.baseUri })
      .from(appSkillDrafts)
      .where(
        and(
          eq(appSkillDrafts.serverId, serverId),
          eq(appSkillDrafts.name, name),
          inArray(appSkillDrafts.status, ['open', 'rejected']),
        ),
      )
      .all()
      .some((row) => row.status === 'open' || row.baseUri === (baseUri ?? null))
  }

  open(limit: number): readonly DraftRecord[] {
    return this.#db
      .select()
      .from(appSkillDrafts)
      .where(eq(appSkillDrafts.status, 'open'))
      .limit(limit)
      .all()
      .map((row) => ({
        contentHash: row.contentHash,
        serverId: row.serverId,
        name: row.name,
        baseUri: row.baseUri ?? undefined,
        draftId: row.draftId ?? undefined,
        status: row.status,
      }))
  }

  add(record: DraftRecord, now: number): void {
    this.#db
      .insert(appSkillDrafts)
      .values({
        ...record,
        baseUri: record.baseUri ?? null,
        draftId: record.draftId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .run()
  }

  update(contentHash: string, change: { readonly draftId?: string; readonly status: DraftStatus }, now: number): void {
    this.#db
      .update(appSkillDrafts)
      .set({ ...change, updatedAt: now })
      .where(eq(appSkillDrafts.contentHash, contentHash))
      .run()
  }

  forget(contentHash: string): void {
    this.#db.delete(appSkillDrafts).where(eq(appSkillDrafts.contentHash, contentHash)).run()
  }
}
