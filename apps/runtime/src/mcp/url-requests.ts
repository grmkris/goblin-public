import { and, eq, lt, sql } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import type { CallToolResult } from '@modelcontextprotocol/client'
import type { JsonObject } from '@goblin/contracts'
import * as Schema from 'effect/Schema'
import { appMcpUrlRequests as requests } from '../storage/mcp-url-requests.ts'
import { Conflict, NotFound, PayloadTooLarge } from '../http/errors.ts'
import type { CredentialCipher } from './cipher.ts'
import { argumentsHash } from './approvals.ts'
import type { UrlPrompt } from './types.ts'

// URL requests (ADR 0042): a model's MCP call the server answered "input required: open this URL", kept until the
// owner finishes or cancels it. Sealing and every other wait run outside SQLite transactions.

export type UrlRequestRow = typeof requests.$inferSelect

/** A model's call held as a URL request. */
export type HeldUrlRequest = UrlPrompt & {
  readonly id: string
  readonly sessionId: string
  readonly sourceCallId: string
  readonly taskId: string
  readonly connectionId: string
  readonly name: string
  readonly endpoint: string
  readonly arguments: Record<string, unknown>
  readonly expiresAt: number
}

/** The longest request state goblin keeps for a server; one beyond it is refused, never cut. */
export const MAX_REQUEST_STATE = 65_536
/** How many URL requests may wait on the owner at once. */
const MAX_PENDING = 32

const decodeArguments = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))
const Prompt = Schema.Struct({ url: Schema.String, message: Schema.String })
const decodePrompt = Schema.decodeUnknownSync(Schema.fromJsonString(Prompt))

/** A URL request id: one per model call. */
export const urlRequestId = (session: string, callId: string): string => `mcp-url:${session}:${callId}`

const matches = (row: UrlRequestRow, input: HeldUrlRequest, hash: string) =>
  row.argumentsHash === hash &&
  row.sessionId === input.sessionId &&
  row.sourceCallId === input.sourceCallId &&
  row.taskId === input.taskId &&
  row.connectionId === input.connectionId &&
  row.name === input.name &&
  row.endpoint === input.endpoint

/** Application-owned URL requests, sealed with the credential key. */
export class McpUrlRequestStore {
  readonly #db: DrizzleSqliteDODatabase
  readonly #cipher: CredentialCipher
  constructor(db: DrizzleSqliteDODatabase, cipher: CredentialCipher) {
    this.#db = db
    this.#cipher = cipher
  }

  /**
   * At start: a retry that was under way may have reached the server, so it is `uncertain` and never sent again; a
   * request past its time is `expired`; one expired a month ago is forgotten.
   */
  recover(now: number): void {
    this.#db
      .delete(requests)
      .where(lt(requests.expiresAt, now - 30 * 86_400_000))
      .run()
    this.#db.update(requests).set({ state: 'uncertain', updatedAt: now }).where(eq(requests.state, 'retrying')).run()
    this.#db
      .update(requests)
      .set({ state: 'expired', updatedAt: now })
      .where(and(eq(requests.state, 'pending'), sql`${requests.expiresAt} <= ${now}`))
      .run()
  }

  async #sealPrompt(id: string, prompt: UrlPrompt) {
    if (
      prompt.requestState !== undefined &&
      new TextEncoder().encode(prompt.requestState).byteLength > MAX_REQUEST_STATE
    )
      throw new PayloadTooLarge({ limit: MAX_REQUEST_STATE })
    return {
      inputKey: prompt.inputKey,
      stateSealed:
        prompt.requestState === undefined
          ? null
          : await this.#cipher.encrypt(prompt.requestState, `mcp-url:${id}:state`),
      promptSealed: await this.#cipher.encrypt(
        JSON.stringify({ url: prompt.url, message: prompt.message }),
        `mcp-url:${id}:prompt`,
      ),
    }
  }

  /**
   * Keeps the call `input` as a URL request, or finds it kept before: a pending one takes the server's newer prompt.
   * A different call under the same id is a conflict.
   */
  async hold(input: HeldUrlRequest, now: number): Promise<UrlRequestRow> {
    const json = JSON.stringify(decodeArguments(input.arguments))
    if (new TextEncoder().encode(json).byteLength > 65_536) throw new PayloadTooLarge({ limit: 65_536 })
    const hash = await argumentsHash(input.arguments)
    const sealedArguments = await this.#cipher.encrypt(json, `mcp-url:${input.id}:arguments`)
    const prompt = await this.#sealPrompt(input.id, input)
    const previous = this.find(input.id)
    if (previous !== undefined) {
      if (!matches(previous, input, hash)) throw new Conflict({ reason: 'url request call id reused' })
      this.#db
        .update(requests)
        .set({ ...prompt, updatedAt: now })
        .where(and(eq(requests.id, input.id), eq(requests.state, 'pending')))
        .run()
      return this.get(input.id)
    }
    const pending =
      this.#db
        .select({ count: sql<number>`COUNT(*)` })
        .from(requests)
        .where(and(eq(requests.state, 'pending'), sql`${requests.expiresAt} > ${now}`))
        .get()?.count ?? 0
    if (pending >= MAX_PENDING) throw new Conflict({ reason: 'too many open URL requests' })
    this.#db
      .insert(requests)
      .values({
        id: input.id,
        sessionId: input.sessionId,
        sourceCallId: input.sourceCallId,
        taskId: input.taskId,
        connectionId: input.connectionId,
        name: input.name,
        endpoint: input.endpoint,
        argumentsSealed: sealedArguments,
        argumentsHash: hash,
        ...prompt,
        state: 'pending',
        expiresAt: input.expiresAt,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run()
    const row = this.get(input.id)
    if (!matches(row, input, hash)) throw new Conflict({ reason: 'url request call id reused' })
    return row
  }

  find(id: string): UrlRequestRow | undefined {
    return this.#db.select().from(requests).where(eq(requests.id, id)).get()
  }
  get(id: string): UrlRequestRow {
    const row = this.find(id)
    if (row === undefined) throw new NotFound({ what: 'URL request' })
    return row
  }

  /**
   * Claims the one retry of a pending request, before any I/O: `changed` is false when it was not pending (already
   * retried or answered) or its time is up, which also marks it `expired`.
   */
  claim(id: string, now: number): { readonly row: UrlRequestRow; readonly changed: boolean } {
    const row = this.get(id)
    if (row.state !== 'pending') return { row, changed: false }
    const state = row.expiresAt <= now ? 'expired' : 'retrying'
    const updated = this.#db
      .update(requests)
      .set({ state, updatedAt: now })
      .where(and(eq(requests.id, id), eq(requests.state, 'pending')))
      .returning({ id: requests.id })
      .all()
    return { row: this.get(id), changed: updated.length === 1 && state === 'retrying' }
  }

  /** The server is still waiting on the owner: the request is pending again, with the server's newer prompt. */
  async again(id: string, prompt: UrlPrompt, now: number): Promise<void> {
    const sealed = await this.#sealPrompt(id, prompt)
    this.#db
      .update(requests)
      .set({ ...sealed, state: 'pending', updatedAt: now })
      .where(and(eq(requests.id, id), eq(requests.state, 'retrying')))
      .run()
  }

  /** The server answered the retry: its result, kept sealed for the turn that asked. */
  async finish(id: string, state: 'completed' | 'declined', result: CallToolResult, now: number): Promise<void> {
    const sealed = await this.#cipher.encrypt(JSON.stringify(result), `mcp-url:${id}:result`)
    this.#db
      .update(requests)
      .set({ state, resultSealed: sealed, updatedAt: now })
      .where(and(eq(requests.id, id), eq(requests.state, 'retrying')))
      .run()
  }

  /** A retry that did not complete: `uncertain` once it may have reached the server. */
  fail(id: string, state: 'failed' | 'uncertain', now: number): void {
    this.#db
      .update(requests)
      .set({ state, updatedAt: now })
      .where(and(eq(requests.id, id), eq(requests.state, 'retrying')))
      .run()
  }

  /** The owner cancelled it: declined, whether or not the server heard the decline. */
  decline(id: string, now: number): void {
    this.#db
      .update(requests)
      .set({ state: 'declined', updatedAt: now })
      .where(and(eq(requests.id, id), sql`${requests.state} IN ('pending', 'retrying')`))
      .run()
  }

  async arguments(id: string): Promise<JsonObject> {
    const row = this.get(id)
    // SAFETY: the arguments are decoded as a JSON object before sealing and again here.
    return decodeArguments(
      JSON.parse(await this.#cipher.decrypt(row.argumentsSealed, `mcp-url:${id}:arguments`)),
    ) as JsonObject
  }

  /** What the server asked, unsealed. */
  async prompt(id: string): Promise<UrlPrompt> {
    const row = this.get(id)
    const { url, message } = decodePrompt(await this.#cipher.decrypt(row.promptSealed, `mcp-url:${id}:prompt`))
    const requestState =
      row.stateSealed === null ? undefined : await this.#cipher.decrypt(row.stateSealed, `mcp-url:${id}:state`)
    return { inputKey: row.inputKey, requestState, url, message }
  }

  /** The retry's result once the server answered it. */
  async result(id: string): Promise<CallToolResult | undefined> {
    const row = this.get(id)
    if (row.resultSealed === null) return undefined
    // SAFETY: only an SDK-validated CallToolResult is sealed in finish().
    return JSON.parse(await this.#cipher.decrypt(row.resultSealed, `mcp-url:${id}:result`)) as CallToolResult
  }
}
