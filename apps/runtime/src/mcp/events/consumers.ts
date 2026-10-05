import type { TelegramChannel } from '../../channel/channel.ts'
import type { SkillLibrary } from '../../skills/library.ts'
import type { McpEvents } from '../events.ts'

/** Installed static handlers never execute event text; Telegram pulls inbox, Skills persist invalidation. */
export function installEventConsumers(
  events: McpEvents,
  channel: TelegramChannel,
  skills: SkillLibrary,
  pull: () => Promise<void>,
): void {
  events.register('telegram-inbox', async ({ subscription, envelope }) => {
    const status = channel.status()
    if (status?.serverId !== subscription.serverId || status.transport !== 'events') return
    if ('type' in envelope && envelope.type === 'terminated') return
    await pull()
  })
  events.register('skills-refresh', async ({ subscription, envelope }) => {
    if (!skills.enabled(subscription.serverId)) return
    skills.invalidate(subscription.serverId, 'type' in envelope && envelope.type === 'terminated')
  })
}
