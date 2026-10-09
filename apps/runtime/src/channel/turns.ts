// The Telegram channel's view of the agent (ADR 0009): main as the owner's Telegram, and how its turns end.
import { TELEGRAM_AUTHOR } from '@goblin/contracts'
import type { PiHarness } from 'agents/harness/pi'
import * as Effect from 'effect/Effect'
import type { AppError } from '../http/errors.ts'
import { authoredContent } from '../pi/content.ts'
import { askedText, cutOff } from '../pi/transcript.ts'
import {
  type AgentServices,
  Budget,
  Channel,
  Chats,
  Mcp,
  Models,
  attempt,
  nowSecondsEffect,
  requireBudget,
  requireResident,
} from '../services.ts'
import { useModel, type Applied } from '../agent-model.ts'
import { type ChannelPorts, type TelegramChannel, channelCall } from './channel.ts'

type Run = <A>(program: Effect.Effect<A, AppError, Budget | Chats | Models>) => Promise<A>

/** What Telegram adds to an answer that reached the output limit, as the web transcript's receipt says. */
const CUT_OFF = '(Cut off at the output limit. Ask it to continue.)'

/**
 * How a turn of main ended, as Telegram should hear it: its final text, or what it asked the owner when it stopped on
 * a question, and whether it was cut off; undefined while it runs.
 */
async function answerOf(harness: PiHarness, operationId: string, run: Run): Promise<string | undefined> {
  // Retained reply rows predate the ledger; their original session is still the current primary at migration.
  const session = await run(
    Effect.gen(function* () {
      const chats = yield* Chats
      const now = yield* nowSecondsEffect
      return chats.operation(chats.primary(), operationId) ?? chats.admit(chats.primary(), operationId, now).session
    }),
  )
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
 * The ports of the channel: the channel server's tools (`call`), main, where an owner's Telegram message becomes a
 * turn within the budget on the owner's model (`useModel`), and the end of each turn.
 */
export const channelPorts = (
  harness: PiHarness,
  call: ChannelPorts['call'],
  run: Run,
  applied: Applied,
): ChannelPorts => ({
  call,
  submit: (text, operationId) =>
    run(
      Effect.gen(function* () {
        yield* requireBudget
        const chats = yield* Chats
        const now = yield* nowSecondsEffect
        yield* attempt(() =>
          chats.withChat(chats.primary(), async () => {
            const { session } = chats.admit(chats.primary(), operationId, now)
            await run(useModel(harness, applied, session))
            await harness.submit(authoredContent(TELEGRAM_AUTHOR, text), { session, operationId })
          }),
        )
      }),
    ),
  answer: (operationId) => answerOf(harness, operationId, run),
})

type AgentRun = <A>(program: Effect.Effect<A, AppError, AgentServices>) => Promise<A>

/**
 * Runs `work` on the Telegram channel and its ports while the channel is on and resident authority is current;
 * undefined when the channel is off.
 */
export async function onChannel<T>(
  harness: PiHarness,
  applied: Applied,
  run: AgentRun,
  work: (channel: TelegramChannel, ports: ChannelPorts) => Promise<T>,
): Promise<T | undefined> {
  const { mcp, channel } = await run(
    Effect.gen(function* () {
      yield* requireResident
      return { mcp: yield* Mcp, channel: yield* Channel }
    }),
  )
  const status = channel.status()
  if (status === null) return undefined
  return work(channel, channelPorts(harness, channelCall(mcp.manager, status.serverId), run, applied))
}
