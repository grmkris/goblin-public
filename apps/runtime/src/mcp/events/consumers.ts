import type { ChannelStatus } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import type { AppError } from '../../http/errors.ts'
import type { Events } from '../service.ts'

/** What the static consumers reach: the Telegram channel, the pull it schedules, and the skills libraries. */
export type EventConsumerPorts = {
  /** The Telegram channel's server and transport, or null while it is off. */
  readonly channel: Effect.Effect<ChannelStatus, AppError>
  readonly pull: Effect.Effect<void, AppError>
  /** Whether the owner takes skills from `connectionId`, and forgetting its listing (`unavailable` when it stopped). */
  readonly skills: {
    readonly enabled: (connectionId: string) => Effect.Effect<boolean, AppError>
    readonly invalidate: (connectionId: string, unavailable: boolean) => Effect.Effect<void, AppError>
  }
}

/** Installed static handlers never execute event text; Telegram pulls inbox, Skills persist invalidation. */
export const installEventConsumers = (
  events: Pick<Events['Service'], 'register'>,
  ports: EventConsumerPorts,
): Effect.Effect<void> =>
  Effect.andThen(
    events.register('telegram-inbox', ({ subscription, envelope }) =>
      Effect.gen(function* () {
        const status = yield* ports.channel
        if (status?.connectionId !== subscription.connectionId || status.transport !== 'events') return
        if ('type' in envelope && envelope.type === 'terminated') return
        yield* ports.pull
      }),
    ),
    events.register('skills-refresh', ({ subscription, envelope }) =>
      Effect.gen(function* () {
        if (!(yield* ports.skills.enabled(subscription.connectionId))) return
        yield* ports.skills.invalidate(subscription.connectionId, 'type' in envelope && envelope.type === 'terminated')
      }),
    ),
  )
