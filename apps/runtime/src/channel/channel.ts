// The Telegram channel (ADR 0008): one MCP connection the owner chose, a myagent connection bound to the agent's own
// bot, carries Telegram both ways. myagent rings a doorbell (channel/doorbell.ts); the agent then reads `inbox` from
// its cursor and puts every new message from the owner into main, authored "Telegram". The answer to each of those
// turns, and to a subagent's report in main, goes back with `send_message`. The store keeps the connection, the cursor,
// the doorbell secret (sealed) and the turns whose answers are still to send.
import { type ChannelStatus } from '@goblin/contracts'
import type { ChatDirectory } from '../chats/directory.ts'
import { RunAttribute, type RunAttributes } from '@goblin/contracts/telemetry'
import { and, asc, eq, isNull } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import * as Schema from 'effect/Schema'
import { InvalidInput, UpstreamMcp } from '../http/errors.ts'
import type { CredentialCipher } from '../mcp/cipher.ts'
import type { McpConnectionManager } from '../mcp/connection.ts'
import { appChannel, appChannelReplies, appTelegramChannel } from '../storage/schema.ts'
import { nowMillis } from '../clock.ts'
import { failureAttributes } from '../telemetry/attributes.ts'
import type { RunTelemetry } from '../telemetry/events.ts'
import { expectedFailure, safeErrorType } from '../telemetry/safety.ts'

/** The tools a server must offer to carry the channel, all granted when the owner turns it on. */
export const CHANNEL_TOOLS = ['inbox', 'send_message'] as const
export const DOORBELL_TOOLS = ['subscribe', 'unsubscribe'] as const
/** Pages of 100 read at most per pull. */
const MAX_PAGES = 50
/** Pages of 100 read at most to find the end of the inbox when the channel is turned on. */
const MAX_HISTORY_PAGES = 200
/** How long a turn's answer is waited for before it is given up. */
const REPLY_DAYS = 1
/** Telegram's limit is 4096 characters of HTML; plain text is cut well below it so escaping cannot push it over. */
const CHUNK = 3500

const Message = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  direction: Schema.optional(Schema.String),
  delivery: Schema.optional(Schema.String),
  media: Schema.optional(Schema.Array(Schema.Struct({ kind: Schema.String, name: Schema.String }))),
})
const Inbox = Schema.Struct({ messages: Schema.Array(Message), nextCursor: Schema.String })
const Subscribed = Schema.Struct({ status: Schema.String, reason: Schema.optional(Schema.String) })
const decodeInbox = Schema.decodeUnknownSync(Inbox)
const decodeSubscribed = Schema.decodeUnknownSync(Subscribed)

/** What the channel needs from the agent: the channel server's tools, main, and the end of a turn. */
export interface ChannelPorts {
  /** A tool of the channel server; its structured result. */
  readonly call: (name: string, args: Record<string, unknown>) => Promise<unknown>
  /** Put the owner's Telegram message into main (idempotent by operation id). */
  readonly submit: (text: string, operationId: string) => Promise<void>
  /** The answer of a turn in main once it ended, or undefined while it runs. */
  readonly answer: (operationId: string) => Promise<string | undefined>
}

const AAD = 'channel:secret'

/** An operation id myagent accepts (letters, digits, `_` and `-`, at most 100). */
const myagentId = (prefix: string, id: string) => `${prefix}-${id.replaceAll(/[^\w-]/gu, '-')}`.slice(0, 100)

/** Plain text as Telegram HTML. */
const escapeHtml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

/** `text` in pieces Telegram accepts, split at paragraph or line breaks where it can. */
export function chunks(text: string): readonly string[] {
  const pieces: string[] = []
  let rest = text.trim()
  while (rest.length > CHUNK) {
    const window = rest.slice(0, CHUNK)
    const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'))
    const at = cut > CHUNK / 2 ? cut : CHUNK
    pieces.push(rest.slice(0, at).trim())
    rest = rest.slice(at).trim()
  }
  if (rest !== '') pieces.push(rest)
  return pieces
}

/** An inbox entry as the words main receives: its text, then its attachments by kind and name (untrusted names). */
const messageText = (message: typeof Message.Type) =>
  [message.text, ...(message.media ?? []).map((media) => `[attachment: ${media.kind} ${JSON.stringify(media.name)}]`)]
    .filter((part) => part !== '')
    .join('\n')

/** One line when a pull or a delivery fails: the step and the error's tag, never message content. */
export function logChannelFailure(step: 'pull' | 'replies', error: unknown): void {
  const tag = safeErrorType(error)
  const line = JSON.stringify({ level: expectedFailure(tag) ? 'info' : 'warn', event: 'channel', step, error: tag })
  if (expectedFailure(tag)) console.log(line)
  else console.warn(line)
}

/**
 * A tool of the channel server, called for the agent itself: the owner's exact grant applies as for any call of the
 * model. Its structured result; an error result fails.
 */
export const channelCall =
  (manager: McpConnectionManager, serverId: string): ChannelPorts['call'] =>
  async (name, args) => {
    const result = await manager.callTool(serverId, name, args, { caller: 'model' })
    if (result.isError === true) throw new UpstreamMcp({ serverId, reason: 'remote-rpc' })
    return result.structuredContent
  }

export class TelegramChannel {
  readonly #chats: ChatDirectory
  readonly #db: DrizzleSqliteDODatabase
  readonly #cipher: CredentialCipher
  /** Asks the agent to send the answers that are ready (a schedule of its own). */
  readonly #wake: () => void
  readonly #telemetry: RunTelemetry | undefined
  constructor(
    db: DrizzleSqliteDODatabase,
    cipher: CredentialCipher,
    wake: () => void,
    telemetry: RunTelemetry | undefined,
    chats: ChatDirectory,
  ) {
    this.#db = db
    this.#chats = chats
    this.#cipher = cipher
    this.#wake = wake
    this.#telemetry = telemetry
  }

  /** One message in, one answer out, in the run ledger (ADR 0024), by the turn's operation id. */
  #record(kind: 'channel.received' | 'channel.reply', operationId: string, startedAt: number, extra: RunAttributes) {
    this.#telemetry?.record({
      id: `${kind === 'channel.received' ? 'channel' : 'reply'}:${operationId}`,
      kind,
      status: RunAttribute.errorType in extra ? 'error' : 'ok',
      conversationId:
        this.#chats.operation(this.#chats.primary(), operationId) ?? this.#chats.session(this.#chats.primary()),
      operationId,
      startedAt,
      endedAt: nowMillis(),
      attributes: { [RunAttribute.channel]: 'telegram', ...extra },
    })
  }

  status(): ChannelStatus {
    const events = this.#db.select().from(appTelegramChannel).get()
    if (events !== undefined) return { serverId: events.serverId, enabledAt: events.enabledAt, transport: 'events' }
    const row = this.#db
      .select({ serverId: appChannel.serverId, enabledAt: appChannel.enabledAt })
      .from(appChannel)
      .get()
    return row === undefined ? null : { ...row, transport: 'doorbell' }
  }

  async startCursor(serverId: string, call: ChannelPorts['call']): Promise<string> {
    const active = this.status()
    if (active?.serverId === serverId) {
      return (
        this.#db.select().from(appTelegramChannel).get()?.inboxCursor ??
        this.#db.select().from(appChannel).get()?.cursor ??
        ''
      )
    }
    let cursor: string | undefined
    for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
      const inbox = decodeInbox(await call('inbox', { ...(cursor === undefined ? {} : { cursor }), limit: 100 }))
      cursor = inbox.nextCursor
      if (inbox.messages.length === 0) return cursor
    }
    throw new InvalidInput({ reason: 'the inbox is too long to start from its end' })
  }

  /** Called only after both Events leases are confirmed. Historical cursor writers are fenced by this row. */
  enableEvents(serverId: string, inboxCursor: string, now: number): ChannelStatus {
    const row = { id: 1, serverId, inboxCursor, enabledAt: now }
    this.#db
      .insert(appTelegramChannel)
      .values(row)
      .onConflictDoUpdate({ target: appTelegramChannel.id, set: row })
      .run()
    return this.status()
  }

  /**
   * Turn the channel on for `serverId`: read to the end of its inbox (older messages are history, not new turns),
   * subscribe the doorbell at `url` with a fresh secret, then store all three.
   */
  async enable(serverId: string, url: string, call: ChannelPorts['call'], now: number): Promise<ChannelStatus> {
    const cursor = await this.startCursor(serverId, call)
    const secret = btoa(String.fromCodePoint(...crypto.getRandomValues(new Uint8Array(32))))
    const subscribed = decodeSubscribed(await call('subscribe', { url, secret }))
    if (subscribed.status !== 'subscribed')
      throw new InvalidInput({ reason: `the doorbell was refused: ${subscribed.reason ?? subscribed.status}` })
    const row = {
      id: 1,
      serverId,
      cursor: cursor ?? '',
      secret: await this.#cipher.encrypt(secret, AAD),
      enabledAt: now,
    }
    this.#db.insert(appChannel).values(row).onConflictDoUpdate({ target: appChannel.id, set: row }).run()
    this.#db.delete(appTelegramChannel).run()
    return this.status()
  }

  /** Turn the channel off; answers still to send are dropped. */
  disable(): void {
    this.#db.delete(appTelegramChannel).run()
    this.#db.delete(appChannel).run()
    this.#db.delete(appChannelReplies).run()
  }

  /** The doorbell secret, when the channel is on. */
  async secret(): Promise<string | undefined> {
    if (this.status()?.transport === 'events') return undefined
    const row = this.#db.select({ secret: appChannel.secret }).from(appChannel).get()
    return row === undefined ? undefined : this.#cipher.decrypt(row.secret, AAD)
  }

  /** Remember a turn of main whose answer goes to Telegram. */
  track(operationId: string, now: number): void {
    if (this.status() === null) return
    this.#db.insert(appChannelReplies).values({ operationId, createdAt: now }).onConflictDoNothing().run()
    this.#wake()
  }

  #cursor(transport: 'events' | 'doorbell' | undefined): string | undefined {
    return transport === 'events'
      ? this.#db.select().from(appTelegramChannel).get()?.inboxCursor
      : this.#db.select().from(appChannel).get()?.cursor
  }
  #checkpoint(status: NonNullable<ChannelStatus>, cursor: string): void {
    if (status.transport === 'events')
      this.#db
        .update(appTelegramChannel)
        .set({ inboxCursor: cursor })
        .where(eq(appTelegramChannel.serverId, status.serverId))
        .run()
    else if (this.status()?.transport === 'doorbell')
      this.#db.update(appChannel).set({ cursor }).where(eq(appChannel.serverId, status.serverId)).run()
  }
  #current(status: NonNullable<ChannelStatus>): boolean {
    const current = this.status()
    return current?.serverId === status.serverId && current?.transport === status.transport
  }

  /** Read the inbox from the cursor and put each new message from the owner into main; the cursor follows each page. */
  async pull(ports: ChannelPorts, now: number): Promise<void> {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const status = this.status()
      if (status === null) return
      const cursor = this.#cursor(status.transport)
      if (cursor === undefined) return
      const inbox = decodeInbox(await ports.call('inbox', { cursor, limit: 100 }))
      if (!this.#current(status)) return
      for (const message of inbox.messages)
        if (message.direction === 'in' && message.delivery !== 'archive') await this.#receive(ports, message, now)
      this.#checkpoint(status, inbox.nextCursor)
      if (inbox.messages.length === 0) return
    }
  }

  /** One message from the owner into main as a turn, tracked for its answer and recorded (ADR 0024). */
  async #receive(ports: ChannelPorts, message: typeof Message.Type, now: number): Promise<void> {
    const operationId = myagentId('telegram', message.id)
    const startedAt = nowMillis()
    const attributes = { [RunAttribute.channelMessage]: message.id }
    await ports.submit(messageText(message), operationId).catch((error: unknown) => {
      this.#record('channel.received', operationId, startedAt, { ...attributes, ...failureAttributes(error) })
      throw error
    })
    this.#record('channel.received', operationId, startedAt, attributes)
    this.track(operationId, now)
  }

  /** Send every answer that is ready; true while some are still running. */
  async deliver(ports: ChannelPorts, now: number): Promise<boolean> {
    const pending = this.#db
      .select()
      .from(appChannelReplies)
      .where(isNull(appChannelReplies.deliveredAt))
      .orderBy(asc(appChannelReplies.createdAt))
      .all()
    let waiting = false
    for (const { operationId, createdAt } of pending) {
      const text = await ports.answer(operationId)
      if (text === undefined && now - createdAt < REPLY_DAYS * 86_400) {
        waiting = true
        continue
      }
      const pieces = chunks(text ?? '')
      const reply = {
        [RunAttribute.delivery]: text === undefined ? 'given_up' : 'sent',
        [RunAttribute.pieces]: pieces.length,
      }
      const sent = async () => {
        for (const [index, piece] of pieces.entries())
          await ports.call('send_message', {
            operationId: myagentId(`reply-${index}`, operationId),
            text: escapeHtml(piece),
          })
      }
      await sent().catch((error: unknown) => {
        this.#record('channel.reply', operationId, createdAt * 1000, { ...reply, ...failureAttributes(error) })
        throw error
      })
      this.#record('channel.reply', operationId, createdAt * 1000, reply)
      this.#db
        .update(appChannelReplies)
        .set({ deliveredAt: now })
        .where(and(eq(appChannelReplies.operationId, operationId), isNull(appChannelReplies.deliveredAt)))
        .run()
    }
    return waiting
  }
}
