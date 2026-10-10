import { and, eq, lt, sql } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import type { CallToolResult } from '@modelcontextprotocol/client'
import type { ApprovalView, JsonObject } from '@goblin/contracts'
import * as Schema from 'effect/Schema'
import { appMcpApprovals as approvals } from '../storage/mcp-approvals.ts'
import { Conflict, NotFound, PayloadTooLarge } from '../http/errors.ts'
import { CredentialCipher } from './cipher.ts'
import type { ApprovedDispatch, McpCaller } from './types.ts'
import { redactSecretFields } from './redaction.ts'
import { sha256Hex } from '../runtime/digest.ts'

export type ApprovalRow = typeof approvals.$inferSelect
export type HeldCall = {
  readonly id: string
  readonly caller: McpCaller
  readonly sessionId?: string
  readonly sourceCallId?: string
  readonly taskId?: string
  readonly serverId: string
  readonly name: string
  readonly endpoint: string
  readonly grantVersion: string
  readonly arguments: Record<string, unknown>
}
const decodeArguments = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))
const matches = (row: ApprovalRow, input: HeldCall, hash: string) =>
  row.argumentsHash === hash &&
  row.serverId === input.serverId &&
  row.name === input.name &&
  row.endpoint === input.endpoint &&
  row.grantVersion === input.grantVersion &&
  row.caller === input.caller &&
  row.sessionId === (input.sessionId ?? null) &&
  row.sourceCallId === (input.sourceCallId ?? null) &&
  row.taskId === (input.taskId ?? null)

/** Application-owned approvals. Encryption and external work never run inside a SQLite transaction. */
export class McpApprovalStore {
  readonly #db: DrizzleSqliteDODatabase
  readonly cipher: CredentialCipher
  constructor(db: DrizzleSqliteDODatabase, cipher: CredentialCipher) {
    this.#db = db
    this.cipher = cipher
  }

  /** An isolate cannot know whether a previously dispatching call took effect. Never replay it. */
  recover(now: number): void {
    this.#db
      .delete(approvals)
      .where(lt(approvals.expiresAt, now - 30 * 86_400_000))
      .run()
    this.#db
      .update(approvals)
      .set({ state: 'uncertain', updatedAt: now })
      .where(eq(approvals.state, 'dispatching'))
      .run()
    this.#db.update(approvals).set({ state: 'failed', updatedAt: now }).where(eq(approvals.state, 'approved')).run()
  }

  async hold(input: HeldCall, now: number, expiresAt = now + 600_000): Promise<ApprovalRow> {
    const json = JSON.stringify(decodeArguments(input.arguments))
    if (new TextEncoder().encode(json).byteLength > 65_536) throw new PayloadTooLarge({ limit: 65_536 })
    const hash = await sha256Hex(json)
    const sealed = await this.cipher.encrypt(json, `mcp-approval:${input.id}:arguments`)
    const previous = this.find(input.id)
    if (previous !== undefined) {
      if (!matches(previous, input, hash)) throw new Conflict({ reason: 'approval call id reused' })
      return previous
    }
    const pending =
      this.#db
        .select({ count: sql<number>`COUNT(*)` })
        .from(approvals)
        .where(and(eq(approvals.state, 'pending'), sql`${approvals.expiresAt} > ${now}`))
        .get()?.count ?? 0
    if (pending >= 32) throw new Conflict({ reason: 'too many pending tool approvals' })
    this.#db
      .insert(approvals)
      .values({
        id: input.id,
        caller: input.caller,
        sessionId: input.sessionId ?? null,
        sourceCallId: input.sourceCallId ?? null,
        taskId: input.taskId ?? null,
        serverId: input.serverId,
        name: input.name,
        endpoint: input.endpoint,
        grantVersion: input.grantVersion,
        argumentsHash: hash,
        argumentsSealed: sealed,
        state: 'pending',
        expiresAt,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run()
    const row = this.get(input.id)
    if (!matches(row, input, hash)) throw new Conflict({ reason: 'approval call id reused' })
    return row
  }

  find(id: string): ApprovalRow | undefined {
    return this.#db.select().from(approvals).where(eq(approvals.id, id)).get()
  }
  get(id: string): ApprovalRow {
    const row = this.find(id)
    if (row === undefined) throw new NotFound({ what: 'MCP approval' })
    return row
  }

  /** Claim the owner's exact decision once, before any I/O. A repeated click cannot start another dispatch. */
  decide(id: string, allowed: boolean, now: number): { row: ApprovalRow; changed: boolean } {
    const row = this.get(id)
    if (row.state !== 'pending') return { row, changed: false }
    const state = row.expiresAt <= now ? 'expired' : allowed ? 'approved' : 'refused'
    const updated = this.#db
      .update(approvals)
      .set({ state, updatedAt: now })
      .where(and(eq(approvals.id, id), eq(approvals.state, 'pending')))
      .returning()
      .all()
    return { row: this.get(id), changed: updated.length === 1 }
  }

  /** Atomically turn an approved decision into a dispatch intent. */
  claim(id: string, now: number): boolean {
    return (
      this.#db
        .update(approvals)
        .set({ state: 'dispatching', updatedAt: now })
        .where(and(eq(approvals.id, id), eq(approvals.state, 'approved')))
        .returning({ id: approvals.id })
        .all().length === 1
    )
  }

  async assert(input: {
    readonly id: string
    readonly call: ApprovedDispatch
    readonly version: () => string | undefined
    readonly now: number
    readonly dispatch: boolean
    readonly authorize?: () => Promise<void>
  }): Promise<void> {
    const { id, call, version, now, dispatch, authorize } = input
    const hash = await sha256Hex(JSON.stringify(decodeArguments(call.arguments)))
    await authorize?.()
    const row = this.get(id)
    const context = call.approvalContext
    if (
      row.state !== 'approved' ||
      row.expiresAt <= now ||
      row.grantVersion !== version() ||
      row.endpoint !== call.endpoint ||
      row.serverId !== call.serverId ||
      row.name !== call.name ||
      row.caller !== call.caller ||
      row.argumentsHash !== hash ||
      row.sessionId !== (context?.sessionId ?? null) ||
      row.sourceCallId !== (context?.sourceCallId ?? null) ||
      row.taskId !== (context?.taskId ?? null)
    )
      throw new Conflict({ reason: 'held call no longer has its reviewed authority' })
    if (dispatch && !this.claim(id, now)) throw new Conflict({ reason: 'approval was already dispatched' })
  }

  async finish(id: string, result: CallToolResult, now: number): Promise<void> {
    const sealed = await this.cipher.encrypt(JSON.stringify(result), `mcp-approval:${id}:result`)
    this.#db
      .update(approvals)
      .set({ state: 'completed', resultSealed: sealed, updatedAt: now })
      .where(and(eq(approvals.id, id), eq(approvals.state, 'dispatching')))
      .run()
  }
  fail(id: string, state: 'failed' | 'uncertain', now: number): void {
    this.#db
      .update(approvals)
      .set({ state, updatedAt: now })
      .where(and(eq(approvals.id, id), sql`${approvals.state} IN ('approved', 'dispatching')`))
      .run()
  }

  async arguments(id: string): Promise<JsonObject> {
    const row = this.get(id)
    // SAFETY: approval arguments are decoded as a JSON object before encryption and again here.
    return decodeArguments(
      JSON.parse(await this.cipher.decrypt(row.argumentsSealed, `mcp-approval:${id}:arguments`)),
    ) as JsonObject
  }
  async result(id: string): Promise<CallToolResult | undefined> {
    const row = this.get(id)
    if (row.state !== 'completed' || row.resultSealed === null) return undefined
    // SAFETY: only the official SDK-validated CallToolResult is encrypted in finish().
    return JSON.parse(await this.cipher.decrypt(row.resultSealed, `mcp-approval:${id}:result`)) as CallToolResult
  }
  async view(id: string, now: number): Promise<ApprovalView> {
    const row = this.get(id)
    return {
      id,
      serverId: row.serverId,
      name: row.name,
      arguments: decodeArguments(redactSecretFields(await this.arguments(id))),
      state: row.state === 'pending' && row.expiresAt <= now ? 'expired' : row.state,
      expiresAt: row.expiresAt,
      ...(row.sessionId === null ? {} : { conversation: row.sessionId }),
    }
  }
}
