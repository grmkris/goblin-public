// The Telegram channel (ADR 0008): one MCP connection the owner chose, a myagent connection bound to the agent's own
// bot, carries Telegram both ways. myagent rings a doorbell (channel/doorbell.ts), or the server's Events deliver; the
// agent then reads `inbox` from its cursor and puts every new message from the owner into main, authored "Telegram".
// The answer to each of those turns, and to a subagent's report in main, goes back with `send_message`. The rows are
// channel/store.ts: the connection, the cursor, the doorbell secret (sealed) and the turns whose answers are to send.
import { type ChannelStatus } from '@goblin/contracts'
import { RunAttribute, type RunAttributes } from '@goblin/contracts/telemetry'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as Semaphore from 'effect/Semaphore'
import type { ChatDirectory } from '../chats/directory.ts'
import { type AppError, InvalidInput, UpstreamMcp, attempt, toAppError } from '../http/errors.ts'
import type { CredentialCipher } from '../mcp/cipher.ts'
import type { McpConnections } from '../mcp/service.ts'
import { writeLine } from '../observability/logger.ts'
import { failureAttributes, outcomeOf } from '../telemetry/attributes.ts'
import type { RunTelemetry } from '../telemetry/events.ts'
import { expectedFailure } from '../telemetry/safety.ts'
import { Channel } from './service.ts'
import {
  carries,
  channelStatus,
  checkpoint,
  disableChannel,
  enableDoorbell,
  enableEvents,
  inboxCursor,
  markDelivered,
  pendingReplies,
  sealedSecret,
  storedCursor,
  trackReply,
} from './store.ts'

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
type Message = typeof Message.Type
const Inbox = Schema.Struct({ messages: Schema.Array(Message), nextCursor: Schema.String })
const Subscribed = Schema.Struct({ status: Schema.String, reason: Schema.optional(Schema.String) })

/** A tool of the channel server as an Effect (`channelTool`): its structured result; an error result fails. */
export type ChannelCall = (name: string, args: Record<string, unknown>) => Effect.Effect<unknown, AppError>

/** What the channel needs from the agent: the channel server's tools, main, and the end of a turn. */
export interface ChannelPorts {
  /** A tool of the channel server; its structured result. */
  readonly call: ChannelCall
  /** Put the owner's Telegram message into main (idempotent by operation id). */
  readonly submit: (text: string, operationId: string) => Effect.Effect<void, AppError>
  /** The answer of a turn in main once it ended, or undefined while it runs. */
  readonly answer: (operationId: string) => Effect.Effect<string | undefined, AppError>
}

/** One answer's delivery to Telegram: the turn's operation id, how many messages it took, and why it failed if it did. */
export type DeliveredReply = { readonly operationId: string; readonly pieces: number; readonly errorType?: string }

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
const messageText = (message: Message) =>
  [message.text, ...(message.media ?? []).map((media) => `[attachment: ${media.kind} ${JSON.stringify(media.name)}]`)]
    .filter((part) => part !== '')
    .join('\n')

/** One line when a pull or a delivery fails: the alarm's step and the error's type, never message content. */
export function reportChannelFailure(step: 'pull' | 'replies', error: unknown): void {
  const tag = outcomeOf(error)
  writeLine(expectedFailure(tag) ? 'info' : 'warn', { event: 'wake', task: `channel.${step}`, 'error.type': tag })
}

/**
 * A tool of the channel server through the MCP connections, called for the agent itself: the owner's exact grant
 * applies as for any call of the model. Its structured result; an error result fails.
 */
export const channelTool = (connections: typeof McpConnections.Service, serverId: string): ChannelCall =>
  Effect.fn('Channel.tool')(function* (name: string, args: Record<string, unknown>) {
    const result = yield* connections.callTool(serverId, name, args, { caller: 'model' })
    if (result.isError === true) return yield* new UpstreamMcp({ serverId, reason: 'remote-rpc' })
    return result.structuredContent
  })

const decodeInbox = (value: unknown) => Schema.decodeUnknownEffect(Inbox)(value).pipe(Effect.mapError(toAppError))
const decodeSubscribed = (value: unknown) =>
  Schema.decodeUnknownEffect(Subscribed)(value).pipe(Effect.mapError(toAppError))

/** Reads the inbox from its start to its end, a page of 100 at a time: the cursor after the last message. */
const readToEnd = Effect.fn('Channel.readToEnd')(function* (call: ChannelCall) {
  let cursor: string | undefined
  for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
    const inbox = yield* decodeInbox(yield* call('inbox', { ...(cursor === undefined ? {} : { cursor }), limit: 100 }))
    cursor = inbox.nextCursor
    if (inbox.messages.length === 0) return cursor
  }
  return yield* new InvalidInput({ reason: 'the inbox is too long to start from its end' })
})

/** What the channel is made over: the agent's database and credential cipher, main's directory and its ledger. */
export interface ChannelInput {
  readonly db: DrizzleSqliteDODatabase
  readonly cipher: CredentialCipher
  readonly chats: ChatDirectory
  readonly telemetry: RunTelemetry | undefined
  /** Asks the agent to send the answers that are ready (a schedule of its own). */
  readonly wake: () => void
}

/** One message in, one answer out, in the run ledger (ADR 0024), by the turn's operation id. */
const recorder =
  ({ chats, telemetry }: ChannelInput) =>
  (kind: 'channel.received' | 'channel.reply', operationId: string, startedAt: number, extra: RunAttributes) =>
    Effect.flatMap(Clock.currentTimeMillis, (endedAt) =>
      Effect.sync(() =>
        telemetry?.record({
          id: `${kind === 'channel.received' ? 'channel' : 'reply'}:${operationId}`,
          kind,
          status: RunAttribute.errorType in extra ? 'error' : 'ok',
          conversationId: chats.operation(chats.primary(), operationId) ?? chats.session(chats.primary()),
          operationId,
          startedAt,
          endedAt,
          attributes: { [RunAttribute.channel]: 'telegram', ...extra },
        }),
      ),
    )
type Recorder = ReturnType<typeof recorder>

/** Where to start reading `serverId`'s inbox: the stored cursor when it already carries the channel, else its end. */
const startCursor = (db: DrizzleSqliteDODatabase, serverId: string, call: ChannelCall) =>
  Effect.suspend(() =>
    channelStatus(db)?.serverId === serverId ? Effect.sync(() => storedCursor(db)) : readToEnd(call),
  )

/**
 * Turns the channel on for `serverId`'s doorbell at `url`: reads to the end of its inbox (older messages are history,
 * not new turns), subscribes the doorbell with a fresh secret, then stores all three.
 */
const enable = ({ db, cipher }: ChannelInput, serverId: string, url: string, call: ChannelCall, now: number) =>
  Effect.gen(function* () {
    const cursor = yield* startCursor(db, serverId, call)
    const secret = btoa(String.fromCodePoint(...crypto.getRandomValues(new Uint8Array(32))))
    const subscribed = yield* decodeSubscribed(yield* call('subscribe', { url, secret }))
    if (subscribed.status !== 'subscribed')
      return yield* new InvalidInput({ reason: `the doorbell was refused: ${subscribed.reason ?? subscribed.status}` })
    const sealed = yield* attempt(() => cipher.encrypt(secret, AAD))
    return yield* Effect.sync(() => enableDoorbell(db, { serverId, cursor, secret: sealed, enabledAt: now }))
  })

/** One message from the owner into main as a turn, tracked for its answer and recorded (ADR 0024). */
const receive = (input: ChannelInput, record: Recorder, ports: ChannelPorts, message: Message, now: number) =>
  Effect.gen(function* () {
    const operationId = myagentId('telegram', message.id)
    const startedAt = yield* Clock.currentTimeMillis
    const attributes = { [RunAttribute.channelMessage]: message.id }
    yield* ports
      .submit(messageText(message), operationId)
      .pipe(
        Effect.tapError((error) =>
          record('channel.received', operationId, startedAt, { ...attributes, ...failureAttributes(error) }),
        ),
      )
    yield* record('channel.received', operationId, startedAt, attributes)
    if (trackReply(input.db, operationId, now)) input.wake()
  })

/** Reads the inbox from the cursor and puts each new message from the owner into main; the cursor follows each page. */
const pullPages = (input: ChannelInput, record: Recorder, ports: ChannelPorts, now: number) =>
  Effect.gen(function* () {
    const { db } = input
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const status: ChannelStatus = channelStatus(db)
      if (status === null) return
      const cursor = inboxCursor(db, status.transport)
      if (cursor === undefined) return
      const inbox = yield* decodeInbox(yield* ports.call('inbox', { cursor, limit: 100 }))
      if (!carries(db, status)) return
      for (const message of inbox.messages)
        if (message.direction === 'in' && message.delivery !== 'archive')
          yield* receive(input, record, ports, message, now)
      checkpoint(db, status, inbox.nextCursor)
      if (inbox.messages.length === 0) return
    }
  })

/**
 * One turn's answer to Telegram, in pieces it accepts: recorded and heard by `delivered`, sent or failed, before the
 * next answer is tried. A failed send fails the delivery; the answer stays to be sent again.
 */
const sendAnswer = (
  { db }: ChannelInput,
  record: Recorder,
  ports: ChannelPorts,
  turn: {
    readonly operationId: string
    readonly createdAt: number
    readonly text: string | undefined
    readonly now: number
  },
  delivered: (reply: DeliveredReply) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const { operationId, createdAt, text, now } = turn
    const pieces = chunks(text ?? '')
    const reply = {
      [RunAttribute.delivery]: text === undefined ? 'given_up' : 'sent',
      [RunAttribute.pieces]: pieces.length,
    }
    yield* Effect.forEach(
      pieces.entries(),
      ([index, piece]) =>
        ports.call('send_message', { operationId: myagentId(`reply-${index}`, operationId), text: escapeHtml(piece) }),
      { discard: true },
    ).pipe(
      Effect.tapError((error) =>
        Effect.andThen(
          record('channel.reply', operationId, createdAt * 1000, { ...reply, ...failureAttributes(error) }),
          delivered({ operationId, pieces: pieces.length, errorType: outcomeOf(error) }),
        ),
      ),
    )
    yield* record('channel.reply', operationId, createdAt * 1000, reply)
    markDelivered(db, operationId, now)
    yield* delivered({ operationId, pieces: pieces.length })
  })

/** Sends every answer that is ready; true while some are still running. */
const deliver = (
  input: ChannelInput,
  record: Recorder,
  ports: ChannelPorts,
  now: number,
  delivered: (reply: DeliveredReply) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    let waiting = false
    for (const { operationId, createdAt } of pendingReplies(input.db)) {
      const text = yield* ports.answer(operationId)
      if (text === undefined && now - createdAt < REPLY_DAYS * 86_400) waiting = true
      else yield* sendAnswer(input, record, ports, { operationId, createdAt, text, now }, delivered)
    }
    return waiting
  })

/**
 * The agent's Telegram channel over its rows (channel/store.ts): turning it on and off, the answers it owes, and the
 * pull, which is serialised by the channel's own `Semaphore(1)` (order does not matter: each pull reads from the
 * stored cursor). Nothing here holds a lock across another program.
 */
export const telegramChannel = (input: ChannelInput): Effect.Effect<Channel['Service']> =>
  Effect.map(Semaphore.make(1), (pulling) => {
    const { db } = input
    const record = recorder(input)
    return Channel.of({
      status: Effect.sync(() => channelStatus(db)),
      startCursor: (serverId, call) => startCursor(db, serverId, call).pipe(Effect.withSpan('Channel.startCursor')),
      enableEvents: (serverId, cursor, now) => Effect.sync(() => enableEvents(db, serverId, cursor, now)),
      enable: (serverId, url, call, now) =>
        enable(input, serverId, url, call, now).pipe(Effect.withSpan('Channel.enable')),
      disable: Effect.sync(() => disableChannel(db)),
      secret: Effect.suspend(() => {
        const sealed = sealedSecret(db)
        return sealed === undefined ? Effect.succeed(undefined) : attempt(() => input.cipher.decrypt(sealed, AAD))
      }),
      track: (operationId, now) =>
        Effect.sync(() => {
          if (trackReply(db, operationId, now)) input.wake()
        }),
      pull: (ports, now) =>
        pulling.withPermit(pullPages(input, record, ports, now)).pipe(Effect.withSpan('Channel.pull')),
      deliver: (ports, now, delivered = () => Effect.void) =>
        deliver(input, record, ports, now, delivered).pipe(Effect.withSpan('Channel.deliver')),
    })
  })
