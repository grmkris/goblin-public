import type { PiHarness } from 'agents/harness/pi'
import * as Effect from 'effect/Effect'
import type { Applied } from '../agent-model.ts'
import { nowSeconds } from '../clock.ts'
import { toAppError } from '../http/errors.ts'
import { KeyedLock } from '../observability/lock.ts'
import type { RunProgram } from '../runtime/bridge.ts'
import { type ChannelPorts, type TelegramChannel, reportChannelFailure } from './channel.ts'
import { onChannel } from './turns.ts'

type Ports = {
  readonly harness: PiHarness
  readonly applied: Applied
  readonly run: RunProgram
  /** Schedules `channelReplies` again in `seconds`. */
  readonly again: (seconds: number) => Promise<unknown>
}

/** The agent's one Telegram pull at a time, in arrival order (`KeyedLock` is FIFO). */
const PULL_LOCK = 'channel.pull'

/** The Telegram channel's alarms: `channelPull`, one pull at a time in arrival order, and `channelReplies`. */
export class ChannelWakes {
  readonly #ports: Ports
  constructor(ports: Ports) {
    this.#ports = ports
  }
  async #onChannel<T>(work: (channel: TelegramChannel, ports: ChannelPorts) => Promise<T>): Promise<T | undefined> {
    return onChannel(this.#ports.harness, this.#ports.applied, this.#ports.run, work)
  }
  async pull(): Promise<void> {
    const pull = Effect.tryPromise({
      try: () => this.#onChannel((channel, ports) => channel.pull(ports, nowSeconds())),
      catch: toAppError,
    })
    await this.#ports
      .run(KeyedLock.use((locks) => locks.withLock(PULL_LOCK)(Effect.asVoid(pull))))
      .catch((error: unknown) => reportChannelFailure('pull', error))
  }
  async replies(): Promise<void> {
    const again = await this.#onChannel(async (channel, ports) =>
      (await channel.deliver(ports, nowSeconds())) ? 15 : undefined,
    ).catch((error: unknown) => {
      reportChannelFailure('replies', error)
      return 300
    })
    if (again !== undefined) await this.#ports.again(again)
  }
}
