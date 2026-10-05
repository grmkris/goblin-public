import { and, eq } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import { Schema } from 'effect'
import type { QuestionSpec } from '@purrable/contracts'
import { appInteractions } from '../storage/routines.ts'
import { Conflict, Forbidden, NotFound } from '../http/errors.ts'
import type { MemberPrincipal } from '../env.ts'
import type { CredentialCipher } from '../mcp/cipher.ts'

export const hash = async (text: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')

/** Questions and owner approvals share durable, actor-bound, expiring, one-use receipts. */
export class MemberInteractions {
  readonly #db: DrizzleSqliteDODatabase
  readonly #cipher: CredentialCipher
  readonly #owner: string
  constructor(db: DrizzleSqliteDODatabase, cipher: CredentialCipher, owner: string) {
    this.#db = db
    this.#cipher = cipher
    this.#owner = owner
  }
  async create(input: {
    readonly session: string
    readonly callId: string
    readonly principal: MemberPrincipal
    readonly kind: 'question' | 'approval' | 'access'
    readonly intent: {
      readonly questions?: readonly QuestionSpec[]
      readonly tool?: unknown
      readonly message?: string
    }
    readonly answerer: 'requester' | 'owner'
  }) {
    const { session, callId, principal, kind, intent, answerer } = input
    const id = `mi:${session}:${callId}`
    const bytes = JSON.stringify({
      requester: principal.userId,
      memberId: principal.memberId,
      version: principal.memberVersion,
      session,
      kind,
      intent,
      answerer,
    })
    const requestHash = await hash(bytes)
    const sealed = await this.#cipher.encrypt(bytes, id)
    const previous = this.#db.select().from(appInteractions).where(eq(appInteractions.id, id)).get()
    if (previous !== undefined) {
      if (previous.requestHash !== requestHash) throw new Conflict({ reason: 'interaction call reused' })
      return previous
    }
    this.#db
      .insert(appInteractions)
      .values({
        id,
        sessionId: session,
        callId,
        requesterUserId: principal.userId,
        answererUserId: answerer === 'owner' ? this.#owner : principal.userId,
        memberId: principal.memberId,
        memberVersion: principal.memberVersion,
        approvalKind: kind,
        intent: sealed,
        requestHash,
        state: 'pending',
        expiresAt: Date.now() + (kind === 'approval' ? 3_600_000 : 86_400_000),
      })
      .run()
    return this.#db.select().from(appInteractions).where(eq(appInteractions.id, id)).get()
  }
  async list(userId: string) {
    const rows = this.#db
      .select({
        id: appInteractions.id,
        session: appInteractions.sessionId,
        kind: appInteractions.approvalKind,
        requesterUserId: appInteractions.requesterUserId,
        answererUserId: appInteractions.answererUserId,
        requestHash: appInteractions.requestHash,
        expiresAt: appInteractions.expiresAt,
      })
      .from(appInteractions)
      .where(and(eq(appInteractions.answererUserId, userId), eq(appInteractions.state, 'pending')))
      .all()
      .filter((row) => row.expiresAt > Date.now() && row.kind !== null)
    return Promise.all(
      rows.map(async (row) => {
        const stored = this.require(row.id)
        const decoded = Schema.decodeUnknownSync(Schema.Struct({ intent: Schema.Unknown }))(
          JSON.parse(await this.#cipher.decrypt(stored.intent, row.id)),
        )
        return { ...row, intent: decoded.intent }
      }),
    )
  }
  async tool(row: ReturnType<MemberInteractions['require']>) {
    const decoded = Schema.decodeUnknownSync(
      Schema.Struct({
        intent: Schema.Struct({
          tool: Schema.Struct({
            serverId: Schema.String,
            name: Schema.String,
            arguments: Schema.Record(Schema.String, Schema.Unknown),
          }),
        }),
      }),
    )(JSON.parse(await this.#cipher.decrypt(row.intent, row.id)))
    return decoded.intent.tool
  }
  require(id: string) {
    const row = this.#db.select().from(appInteractions).where(eq(appInteractions.id, id)).get()
    if (row === undefined || row.memberId === null) throw new NotFound({ what: 'interaction' })
    return row
  }
  /** Consume before continuation; retries return the original decision and cannot dispatch a second effect. */
  consume(id: string, actor: string, operationId: string, expectedHash: string, decisionHash: string) {
    return this.#db.transaction(() => {
      const row = this.require(id)
      if (row.answererUserId !== actor) throw new Forbidden({ reason: 'interaction answerer' })
      if (row.requestHash !== expectedHash) throw new Conflict({ reason: 'interaction hash' })
      if (row.decisionOperationId === operationId) {
        if (row.decisionHash !== decisionHash) throw new Conflict({ reason: 'decision replay mismatch' })
        return { row, replay: true }
      }
      if (row.state !== 'pending' || row.expiresAt <= Date.now())
        throw new Conflict({ reason: 'interaction expired or consumed' })
      this.#db
        .update(appInteractions)
        .set({ state: 'consumed', consumedAt: Date.now(), decisionOperationId: operationId, decisionHash })
        .where(eq(appInteractions.id, id))
        .run()
      return { row, replay: false }
    })
  }
  cancel(memberId: string, memberVersion: number): void {
    this.#db
      .update(appInteractions)
      .set({ state: 'cancelled' })
      .where(
        and(
          eq(appInteractions.memberId, memberId),
          eq(appInteractions.memberVersion, memberVersion),
          eq(appInteractions.state, 'pending'),
        ),
      )
      .run()
  }
}
