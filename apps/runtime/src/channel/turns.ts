// The Telegram channel's view of the agent (ADR 0009): main as the owner's Telegram, and how its turns end.
import { TELEGRAM_AUTHOR } from '@goblin/contracts'
import type { PiHarness } from 'agents/harness/pi'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { useModel, type Applied } from '../agent-model.ts'
import type { Budget } from '../budget.ts'
import { instanceCall, withinBudget } from '../chats/instance.ts'
import { ChatOperations, Chats } from '../chats/service.ts'
import { authoredContent } from '../pi/content.ts'
import { askedText, cutOff } from '../pi/transcript.ts'
import type { AppError } from '../http/errors.ts'
import type { Models } from '../models.ts'
import { McpConnections, Resident } from '../mcp/service.ts'
import type { RunProgram } from '../runtime/bridge.ts'
import { type ChannelPorts, channelTool } from './channel.ts'
import { Channel } from './service.ts'

/** What the ports' programs read; whoever runs them provides these (the bridge provides every agent service). */
type PortServices = Budget | Chats | ChatOperations | Models
type PortRun = <A>(program: Effect.Effect<A, AppError, PortServices>) => Promise<A>

/** What Telegram adds to an answer that reached the output limit, as the web transcript's receipt says. */
const CUT_OFF = '(Cut off at the output limit. Ask it to continue.)'

/** The session operation `operationId` went to in main, admitting it there when nothing did yet. */
const mainSession = (operationId: string) =>
  Effect.gen(function* () {
    const chats = yield* Chats
    const operations = yield* ChatOperations
    const found = yield* operations.operation(chats.primary, operationId)
    return Option.isSome(found) ? found.value : (yield* operations.admit(chats.primary, operationId)).session
  })

/**
 * How a turn of main ended, as Telegram should hear it: its final text, or what it asked the owner when it stopped on
 * a question, and whether it was cut off; undefined while it runs.
 */
async function answerOf(harness: PiHarness, operationId: string, run: PortRun): Promise<string | undefined> {
  // Retained reply rows predate the ledger; their original session is still the current primary at migration.
  const session = await run(mainSession(operationId))
  const result = await harness
    .wait(operationId, { session, signal: AbortSignal.timeout(200) })
    // Wave 3 (C3) stops this also swallowing a wait that failed for another reason.
    // expected: a wait that outlives its 200 ms means the turn is still running.
    .catch(() => undefined)
  if (result === undefined) return undefined
  if (result.status === 'unanswered') return `(No answer: ${result.reason ?? 'the turn ended without one'}.)`
  const entries = await harness.messages({ session })
  const final = result.text?.trim() ?? ''
  const text = final === '' ? askedText(entries) : final
  if (!cutOff(entries)) return text
  return text === '' ? CUT_OFF : `${text}\n\n${CUT_OFF}`
}

/**
 * The owner's Telegram message into main, within the budget: admitted under main's lock, the session put on the
 * owner's model, then submitted. The same operation id is the same message.
 */
const telegramSubmit = (harness: PiHarness, applied: Applied, text: string, operationId: string) =>
  Effect.gen(function* () {
    yield* withinBudget
    const chats = yield* Chats
    const operations = yield* ChatOperations
    yield* operations.withChat(
      chats.primary,
      Effect.gen(function* () {
        const { session } = yield* operations.admit(chats.primary, operationId)
        yield* useModel(harness, applied, session)
        yield* instanceCall(() => harness.submit(authoredContent(TELEGRAM_AUTHOR, text), { session, operationId }))
      }),
    )
  })

/**
 * The ports of the channel: the channel server's tools (`call`), main, where an owner's Telegram message becomes a
 * turn within the budget on the owner's model, and the end of each turn. Each port runs its program through the
 * bridge, at the port's Promise boundary.
 */
export const channelPorts = (
  harness: PiHarness,
  call: ChannelPorts['call'],
  run: PortRun,
  applied: Applied,
): ChannelPorts => ({
  call,
  submit: (text, operationId) => run(telegramSubmit(harness, applied, text, operationId)),
  answer: (operationId) => answerOf(harness, operationId, run),
})

/**
 * Runs `work` on the Telegram channel and its ports while the channel is on and resident authority is current; none
 * when the channel is off. The ports' Promise calls run through the bridge, at the port's boundary.
 */
export const onChannel = <A, E, R>(
  harness: PiHarness,
  applied: Applied,
  run: RunProgram,
  work: (channel: typeof Channel.Service, ports: ChannelPorts) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    yield* (yield* Resident).require()
    const channel = yield* Channel
    const status = yield* channel.status
    if (status === null) return Option.none<A>()
    const tool = channelTool(yield* McpConnections, status.serverId)
    const call: ChannelPorts['call'] = (name, args) => run(tool(name, args))
    return Option.some(yield* work(channel, channelPorts(harness, call, run, applied)))
  })
