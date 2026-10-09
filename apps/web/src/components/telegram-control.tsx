// The owner's one Telegram channel: a server with Telegram's tools can carry it, and only one does at a time.
import { useEffect, useId } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ToolView } from '@goblin/contracts'
import { Switch } from '@goblin/ui'
import { changeChannelMutation, channelQuery } from '../agent/queries.ts'
import { messageOf } from '../lib/query/app-error.ts'

const TELEGRAM_TOOLS = ['inbox', 'send_message']

export const hasTelegramTools = (tools: readonly ToolView[]): boolean =>
  TELEGRAM_TOOLS.every((name) => tools.some((tool) => tool.name === name))

const channelDate = (seconds: number): string => new Date(seconds * 1000).toLocaleDateString()

/** One Telegram channel for the owner, shared by every server card. */
export function useTelegramChannel(onMessage: (message: string) => void) {
  const queryClient = useQueryClient()
  const read = useQuery(channelQuery)
  const move = useMutation(changeChannelMutation(queryClient))
  useEffect(() => {
    if (read.error !== null) onMessage(messageOf(read.error, 'read the Telegram channel'))
  }, [read.error, onMessage])
  const change = (serverId: string | null): void =>
    move.mutate(serverId, { onError: (error) => onMessage(messageOf(error, 'change the Telegram channel')) })
  return { status: read.data, pending: move.isPending, change }
}

export type TelegramChannel = ReturnType<typeof useTelegramChannel>

/** Whether this server carries the Telegram channel; turning it on here moves it from any other. */
export function TelegramControl({
  serverId,
  channel,
}: {
  readonly serverId: string
  readonly channel: TelegramChannel
}) {
  const id = useId()
  const { status, pending, change } = channel
  if (status === undefined) return null
  const here = status !== null && status.serverId === serverId
  return (
    <div className="setting-row" aria-busy={pending}>
      <span className="grant-text">
        <span id={id} className="grant-name">
          Telegram
        </span>
        <span className="grant-about">
          Messages to your bot come into #Personal, and the answers go back to Telegram.
          {here && (
            <>
              {' '}
              On since{' '}
              <time dateTime={new Date(status.enabledAt * 1000).toISOString()}>{channelDate(status.enabledAt)}</time>,
              {status.transport === 'events' ? ' through Events.' : ' through the older doorbell.'}
            </>
          )}
        </span>
      </span>
      <Switch
        checked={here}
        disabled={pending}
        aria-labelledby={id}
        onCheckedChange={(checked) => change(checked ? serverId : null)}
      />
    </div>
  )
}
