import type { PiHarness } from 'agents/harness/pi'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import type { Applied } from '../agent-model.ts'
import { nowSeconds } from '../clock.ts'
import { FlowEvents } from '../observability/flows.ts'
import { KeyedLock } from '../observability/lock.ts'
import type { RunProgram } from '../runtime/bridge.ts'
import { type DeliveredReply, reportChannelFailure } from './channel.ts'
import { onChannel } from './turns.ts'

type Ports = {
  readonly harness: PiHarness
  readonly applied: Applied
  readonly run: RunProgram
  /** Schedules `channelReplies` again in `seconds`. */
  readonly again: (seconds: number) => Promise<unknown>
}

/** One answer's delivery to Telegram as a flow (ADR 0024): its turn, how many messages it took, and its failure. */
const deliveryFlow = (reply: DeliveredReply) =>
  FlowEvents.record({
    flow: 'telegram_delivery',
    via: 'telegram',
    actor: 'agent',
    operationId: reply.operationId,
    count: reply.pieces,
    status: reply.errorType === undefined ? 'ok' : 'error',
    ...(reply.errorType === undefined ? {} : { errorType: reply.errorType }),
  })

/** The agent's one Telegram pull at a time, in arrival order (`KeyedLock` is FIFO). */
const PULL_LOCK = 'channel.pull'

/** The Telegram channel's alarms: `channelPull`, one pull at a time in arrival order, and `channelReplies`. */
export class ChannelWakes {
  readonly #ports: Ports
  constructor(ports: Ports) {
    this.#ports = ports
  }
  async pull(): Promise<void> {
    const { run } = this.#ports
    const pull = onChannel(run, (channel, ports) => channel.pull(ports, nowSeconds()))
    await run(KeyedLock.use((locks) => locks.withLock(PULL_LOCK)(Effect.asVoid(pull)))).catch((error: unknown) =>
      reportChannelFailure('pull', error),
    )
  }
  async replies(): Promise<void> {
    // A flow that cannot be recorded never holds up, or repeats, a delivery.
    const delivered = (reply: DeliveredReply) =>
      this.#ports.run(deliveryFlow(reply)).catch((error: unknown) => reportChannelFailure('replies', error))
    const { run } = this.#ports
    const more = onChannel(run, (channel, ports) => channel.deliver(ports, nowSeconds(), delivered))
    const again = await run(
      Effect.map(more, (running) => (Option.getOrElse(running, () => false) ? 15 : undefined)),
    ).catch((error: unknown) => {
      reportChannelFailure('replies', error)
      return 300
    })
    if (again !== undefined) await this.#ports.again(again)
  }
}
