// The Telegram channel's view of the agent (ADR 0009): main as the owner's Telegram, and how its turns end.
import { MAIN_THREAD, TELEGRAM_AUTHOR } from '@goblin/contracts'
import type { PiHarness } from 'agents/harness/pi'
import * as Effect from 'effect/Effect'
import type { AppError } from '../http/errors.ts'
import { authoredContent } from '../pi/content.ts'
import { askedText } from '../pi/transcript.ts'
import { type AgentServices, attempt, requireBudget } from '../services.ts'
import type { ChannelPorts } from './channel.ts'

type Run = <A>(program: Effect.Effect<A, AppError, AgentServices>) => Promise<A>

/**
 * How a turn of main ended, as Telegram should hear it: its final text, or what it asked the owner when it stopped on
 * a question; undefined while it runs.
 */
async function answerOf(harness: PiHarness, operationId: string): Promise<string | undefined> {
  const session = MAIN_THREAD
  const result = await harness.wait(operationId, { session, signal: AbortSignal.timeout(200) }).catch(() => undefined)
  if (result === undefined) return undefined
  if (result.status === 'unanswered') return `(No answer: ${result.reason ?? 'the turn ended without one'}.)`
  const text = result.text?.trim() ?? ''
  return text === '' ? askedText(await harness.messages({ session })) : text
}

/**
 * The ports of the channel: the channel server's tools (`call`), main, where an owner's Telegram message becomes a
 * turn within the budget on the owner's model (`useModel`), and the end of each turn.
 */
export const channelPorts = (
  harness: PiHarness,
  call: ChannelPorts['call'],
  run: Run,
  useModel: Effect.Effect<void, AppError, AgentServices>,
): ChannelPorts => ({
  call,
  submit: (text, operationId) =>
    run(
      Effect.gen(function* () {
        yield* requireBudget
        yield* useModel
        yield* attempt(() =>
          harness.submit(authoredContent(TELEGRAM_AUTHOR, text), { session: MAIN_THREAD, operationId }),
        )
      }),
    ),
  answer: (operationId) => answerOf(harness, operationId),
})
