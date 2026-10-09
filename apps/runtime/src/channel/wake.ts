import type { PiHarness } from 'agents/harness/pi'
import type { Applied } from '../agent-model.ts'
import { nowSeconds } from '../clock.ts'
import type { RunProgram } from '../runtime/bridge.ts'
import { type ChannelPorts, type TelegramChannel, logChannelFailure } from './channel.ts'
import { onChannel } from './turns.ts'

type Ports = {
  readonly harness: PiHarness
  readonly applied: Applied
  readonly run: RunProgram
  /** Schedules `channelReplies` again in `seconds`. */
  readonly again: (seconds: number) => Promise<unknown>
}

/** The Telegram channel's alarms: `channelPull`, one pull at a time in arrival order, and `channelReplies`. */
export class ChannelWakes {
  readonly #ports: Ports
  /** The Telegram pull in progress: one at a time (channelPull). */
  #pulling: Promise<void> = Promise.resolve()
  constructor(ports: Ports) {
    this.#ports = ports
  }
  async #onChannel<T>(work: (channel: TelegramChannel, ports: ChannelPorts) => Promise<T>): Promise<T | undefined> {
    return onChannel(this.#ports.harness, this.#ports.applied, this.#ports.run, work)
  }
  async pull(): Promise<void> {
    this.#pulling = this.#pulling
      .then(() => this.#onChannel((channel, ports) => channel.pull(ports, nowSeconds())))
      .then(() => undefined)
      .catch((error: unknown) => logChannelFailure('pull', error))
    await this.#pulling
  }
  async replies(): Promise<void> {
    const again = await this.#onChannel(async (channel, ports) =>
      (await channel.deliver(ports, nowSeconds())) ? 15 : undefined,
    ).catch((error: unknown) => {
      logChannelFailure('replies', error)
      return 300
    })
    if (again !== undefined) await this.#ports.again(again)
  }
}
