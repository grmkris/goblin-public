import type { ChannelStatus } from '@goblin/contracts'
import type { McpEvents } from '../events.ts'

/** What the static consumers reach: the Telegram channel, the pull it schedules, and the skills libraries. */
export type EventConsumerPorts = {
  /** The Telegram channel's server and transport, or null while it is off. */
  readonly channel: () => Promise<ChannelStatus>
  readonly pull: () => Promise<void>
  /** Whether the owner takes skills from `serverId`, and forgetting its listing (`unavailable` when it stopped). */
  readonly skills: {
    readonly enabled: (serverId: string) => Promise<boolean>
    readonly invalidate: (serverId: string, unavailable: boolean) => Promise<void>
  }
}

/** Installed static handlers never execute event text; Telegram pulls inbox, Skills persist invalidation. */
export function installEventConsumers(events: McpEvents, ports: EventConsumerPorts): void {
  events.register('telegram-inbox', async ({ subscription, envelope }) => {
    const status = await ports.channel()
    if (status?.serverId !== subscription.serverId || status.transport !== 'events') return
    if ('type' in envelope && envelope.type === 'terminated') return
    await ports.pull()
  })
  events.register('skills-refresh', async ({ subscription, envelope }) => {
    if (!(await ports.skills.enabled(subscription.serverId))) return
    await ports.skills.invalidate(subscription.serverId, 'type' in envelope && envelope.type === 'terminated')
  })
}
