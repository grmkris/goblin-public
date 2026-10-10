// The Telegram channel's view of the agent (ADR 0009): main as the owner's Telegram, and how its turns end.
import { TELEGRAM_AUTHOR } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { settledWithin } from '../chats/instance.ts'
import { ChatOperations, Chats } from '../chats/service.ts'
import { authoredContent } from '../pi/content.ts'
import { askedText, cutOff } from '../pi/transcript.ts'
import { type AppError, toAppError } from '../http/errors.ts'
import { type PiFailure, PiSessions } from '../pi/sessions.ts'
import { McpConnections, requireResident } from '../mcp/service.ts'
import type { RunProgram } from '../runtime/bridge.ts'
import { type ChannelPorts, channelTool } from './channel.ts'
import { Channel } from './service.ts'

/** What the ports' programs read; whoever runs them provides these (the bridge provides every agent service). */
type PortServices = Chats | ChatOperations | PiSessions
type PortRun = <A>(program: Effect.Effect<A, AppError, PortServices>) => Promise<A>

/** What Telegram adds to an answer that reached the output limit, as the web transcript's receipt says. */
const CUT_OFF = '(Cut off at the output limit. Ask it to continue.)'

/** The session operation `operationId` went to in main, admitting it there when nothing did yet. */
const mainSession = (operationId: string) =>
  Effect.gen(function* () {
    const chats = yield* Chats
    const operations = yield* ChatOperations
    const found = yield* operations.operation(chats.primary, operationId)
    if (Option.isSome(found)) return found.value
    return (yield* operations.record(chats.primary, operationId, { kind: 'telegram', origin: 'telegram' })).session
  })

/**
 * How a turn of main ended, as Telegram should hear it: its final text, or what it asked the owner when it stopped on
 * a question, and whether it was cut off; none while it runs (it has not settled within 200 ms).
 */
const answerOf = (operationId: string) =>
  Effect.gen(function* () {
    // Retained reply rows predate the ledger; their original session is still the current primary at migration.
    const session = yield* mainSession(operationId)
    const settled = yield* settledWithin(session, operationId, 200)
    if (Option.isNone(settled)) return undefined
    const result = settled.value
    if (result.status === 'unanswered') return `(No answer: ${result.reason ?? 'the turn ended without one'}.)`
    const entries = yield* (yield* PiSessions).messages(session).pipe(Effect.catchTag('PiFailure', piFailure))
    const final = result.text?.trim() ?? ''
    const text = final === '' ? askedText(entries) : final
    if (!cutOff(entries)) return text
    return text === '' ? CUT_OFF : `${text}\n\n${CUT_OFF}`
  })

/** A Pi call's failure as the programs take one: Pi's own error through `toAppError`. */
const piFailure = (failure: PiFailure) => Effect.fail(toAppError(failure.cause))

/**
 * The owner's Telegram message into main through the one admission sequence (`ChatOperations.send`): within the
 * budget, admitted under main's lock, the session put on the owner's model, then submitted. The same operation id is
 * the same message.
 */
const telegramSubmit = (text: string, operationId: string) =>
  Effect.gen(function* () {
    const chats = yield* Chats
    yield* (yield* ChatOperations).send({
      chat: chats.primary,
      operationId,
      receipt: { kind: 'telegram', origin: 'telegram' },
      flow: { flow: 'telegram', via: 'telegram', actor: 'owner' },
      content: authoredContent(TELEGRAM_AUTHOR, text),
    })
  })

/**
 * The ports of the channel: the channel server's tools (`call`), main, where an owner's Telegram message becomes a
 * turn within the budget on the owner's model, and the end of each turn. Each port runs its program through the
 * bridge, at the port's Promise boundary.
 */
export const channelPorts = (call: ChannelPorts['call'], run: PortRun): ChannelPorts => ({
  call,
  submit: (text, operationId) => run(telegramSubmit(text, operationId)),
  answer: (operationId) => run(answerOf(operationId)),
})

/**
 * Runs `work` on the Telegram channel and its ports while the channel is on and resident authority is current; none
 * when the channel is off. The ports' Promise calls run through the bridge, at the port's boundary.
 */
export const onChannel = <A, E, R>(
  run: RunProgram,
  work: (channel: typeof Channel.Service, ports: ChannelPorts) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    yield* requireResident
    const channel = yield* Channel
    const status = yield* channel.status
    if (status === null) return Option.none<A>()
    const tool = channelTool(yield* McpConnections, status.serverId)
    const call: ChannelPorts['call'] = (name, args) => run(tool(name, args))
    return Option.some(yield* work(channel, channelPorts(call, run)))
  })
