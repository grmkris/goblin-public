// The owner's one Telegram channel: a server with Telegram's tools can carry it, and only one does at a time.
import { useCallback, useEffect, useId, useState } from 'react'
import { Schema } from 'effect'
import { ChannelStatus, type ToolView } from '@purrable/contracts'
import { Switch } from '@purrable/ui'
import { failureText, request } from '../lib/boundary.ts'

const decodeChannel = Schema.decodeUnknownSync(ChannelStatus)
const TELEGRAM_TOOLS = ['inbox', 'send_message']

export const hasTelegramTools = (tools: readonly ToolView[]): boolean =>
  TELEGRAM_TOOLS.every((name) => tools.some((tool) => tool.name === name))

const channelDate = (seconds: number): string => new Date(seconds * 1000).toLocaleDateString()

/** One Telegram channel for the owner, shared by every server card. */
export function useTelegramChannel(onMessage: (message: string) => void) {
  const [status, setStatus] = useState<ChannelStatus>()
  const [pending, setPending] = useState(false)
  const load = useCallback(async (): Promise<void> => {
    try {
      setStatus(decodeChannel(await request('/api/agent/channel')))
    } catch (error) {
      onMessage(failureText(error))
    }
  }, [onMessage])
  useEffect(() => void load(), [load])
  async function change(serverId: string | null): Promise<void> {
    setPending(true)
    try {
      const data =
        serverId === null
          ? await request('/api/agent/channel', { method: 'DELETE' })
          : await request('/api/agent/channel', { method: 'PUT', body: { serverId } })
      setStatus(decodeChannel(data))
    } catch (error) {
      onMessage(failureText(error))
    } finally {
      await load()
      setPending(false)
    }
  }
  return { status, pending, change }
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
          Messages to your bot come into Main, and the answers go back to Telegram.
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
        onCheckedChange={(checked) => void change(checked ? serverId : null)}
      />
    </div>
  )
}
