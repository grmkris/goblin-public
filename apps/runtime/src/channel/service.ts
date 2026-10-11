import type { ChannelStatus } from '@goblin/contracts'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type { AppError } from '../http/errors.ts'
import type { ChannelCall, ChannelPorts, DeliveredReply } from './channel.ts'

/**
 * The Telegram channel (ADR 0009): the one connection the owner chose to carry Telegram, its inbox cursor, the doorbell
 * secret, and the answers still to send. Instants are epoch seconds. Built once, by start step 11 (`telegramChannel`).
 */
export class Channel extends Context.Service<
  Channel,
  {
    /** The connection that carries the channel, or null when it is off. */
    readonly status: Effect.Effect<ChannelStatus>
    /** Where to start reading `connectionId`'s inbox: the stored cursor when it already carries the channel, else its end. */
    readonly startCursor: (connectionId: string, call: ChannelCall) => Effect.Effect<string, AppError>
    /** Carries the channel through `connectionId`'s Events, from `inboxCursor`. Only after both leases are confirmed. */
    readonly enableEvents: (connectionId: string, inboxCursor: string, now: number) => Effect.Effect<ChannelStatus>
    /** Carries the channel through `connectionId`'s doorbell at `url`, subscribed with a fresh secret. */
    readonly enable: (
      connectionId: string,
      url: string,
      call: ChannelCall,
      now: number,
    ) => Effect.Effect<ChannelStatus, AppError>
    /** Turns the channel off; answers still to send are dropped. */
    readonly disable: Effect.Effect<void>
    /** The doorbell secret, when the doorbell carries the channel. */
    readonly secret: Effect.Effect<string | undefined, AppError>
    /** Remembers a turn of main whose answer goes to Telegram. */
    readonly track: (operationId: string, now: number) => Effect.Effect<void>
    /** Reads the inbox from the cursor and puts each new message from the owner into main, one pull at a time. */
    readonly pull: (ports: ChannelPorts, now: number) => Effect.Effect<void, AppError>
    /** Sends every answer that is ready, telling `delivered` about each; true while some are still running. */
    readonly deliver: (
      ports: ChannelPorts,
      now: number,
      delivered?: (reply: DeliveredReply) => Effect.Effect<void>,
    ) => Effect.Effect<boolean, AppError>
  }
>()('goblin/channel/Channel') {}
