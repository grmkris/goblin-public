// One of the owner's MCP servers: its name, where it stands, its actions, and once connected, the events, skills,
// Telegram channel and tools it offers. A server's title and description are its own claims.
import { useCallback, useEffect, useId, useState } from 'react'
import { Schema } from 'effect'
import { type ServerView, ToolView } from '@goblin/contracts'
import {
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Switch,
} from '@goblin/ui'
import { EllipsisIcon, RefreshCwIcon, Trash2Icon, UnplugIcon } from 'lucide-react'
import { failureText, record, request } from '../lib/boundary.ts'
import { serverStatus, serverTitle } from '../lib/labels.ts'
import { EventsHealth } from './event-health.tsx'
import { AppTile } from './apps/app-tile.tsx'
import { StatusLabel } from './status-label.tsx'
import { type TelegramChannel, TelegramControl, hasTelegramTools } from './telegram-control.tsx'
import { ToolGrants } from './tool-grants.tsx'

const decodeTools = Schema.decodeUnknownSync(Schema.Array(ToolView))
const path = (serverId: string, action: string): string => `/api/mcp/${encodeURIComponent(serverId)}/${action}`

/** The endpoint without its scheme, which is always https for an added server. */
function shortEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint)
    return `${url.host}${url.pathname === '/' ? '' : url.pathname}`
  } catch {
    return endpoint
  }
}

/** The server's discovered tools: loaded once connected, reloaded on demand, updated in place as grants change. */
function useServerTools(server: ServerView, onMessage: (message: string) => void) {
  const [tools, setTools] = useState<readonly ToolView[]>()
  const loadTools = useCallback(
    async (refresh: boolean): Promise<void> => {
      try {
        setTools(decodeTools(await request(path(server.serverId, `tools${refresh ? '?refresh=1' : ''}`))))
      } catch (error) {
        onMessage(failureText(error))
      }
    },
    [server.serverId, onMessage],
  )
  useEffect(() => {
    if (server.status === 'connected') void loadTools(false)
  }, [server.status, loadTools])
  const update = (change: (current: readonly ToolView[]) => readonly ToolView[]) =>
    setTools((current) => (current === undefined ? current : change(current)))
  return { tools, loadTools, update }
}

/**
 * Whether the agent follows this server's skills. A skill is a procedure the agent reads and acts on, so this is for a
 * library the owner trusts; a skill still never allows a tool by itself.
 */
function SkillsSwitch({
  server,
  onMessage,
  onChanged,
}: {
  readonly server: ServerView
  readonly onMessage: (message: string) => void
  readonly onChanged: () => void
}) {
  const id = useId()
  const [enabled, setEnabled] = useState(server.skillsEnabled === true)
  const [pending, setPending] = useState(false)
  async function toggle(next: boolean): Promise<void> {
    setPending(true)
    try {
      await request('/api/mcp/skills', { method: 'PUT', body: { serverId: server.serverId, enabled: next } })
      setEnabled(next)
      onChanged()
    } catch (error) {
      onMessage(failureText(error))
    } finally {
      setPending(false)
    }
  }
  return (
    <div className="setting-row">
      <span className="grant-text">
        <span id={id} className="grant-name">
          Use its skills
        </span>
        <span className="grant-about">
          Skills are procedures your agent follows. Turn this on only for a skills library you trust, such as MySkills.
          A skill never allows a tool by itself.
        </span>
      </span>
      <Switch
        checked={enabled}
        disabled={pending}
        aria-busy={pending}
        aria-labelledby={id}
        onCheckedChange={(checked) => void toggle(checked)}
      />
    </div>
  )
}

type Action = 'connect' | 'disconnect' | 'refresh'

/** Refresh, Disconnect and Remove, kept behind one button so the card's face stays calm. */
function ServerMenu({
  server,
  busy,
  onAct,
  onRemove,
}: {
  readonly server: ServerView
  readonly busy: boolean
  readonly onAct: (action: Action) => void
  readonly onRemove: () => void
}) {
  const connected = server.status === 'connected'
  if (!connected && server.source !== 'added') return null
  const name = serverTitle(server)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button type="button" size="icon-sm" variant="ghost" aria-label={`More for ${name}`} pending={busy} />}
      >
        <EllipsisIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {connected && (
          <>
            <DropdownMenuItem onClick={() => onAct('refresh')}>
              <RefreshCwIcon aria-hidden />
              Look for new tools
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onAct('disconnect')}>
              <UnplugIcon aria-hidden />
              Disconnect
            </DropdownMenuItem>
          </>
        )}
        {connected && server.source === 'added' && <DropdownMenuSeparator />}
        {server.source === 'added' && (
          <DropdownMenuItem variant="destructive" onClick={onRemove}>
            <Trash2Icon aria-hidden />
            Remove…
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Remove asks first: the server's sign-in and every tool grant go with it. */
function RemoveConfirm({
  server,
  onRemoved,
  onCancel,
  onMessage,
}: {
  readonly server: ServerView
  readonly onRemoved: () => void
  readonly onCancel: () => void
  readonly onMessage: (message: string) => void
}) {
  const [pending, setPending] = useState(false)
  async function remove(): Promise<void> {
    setPending(true)
    try {
      await request(path(server.serverId, 'remove'), { body: {} })
      onRemoved()
    } catch (error) {
      onMessage(failureText(error))
      setPending(false)
    }
  }
  return (
    <div className="inline-confirm" role="alertdialog" aria-label={`Remove ${serverTitle(server)}?`}>
      <span>Remove it? Its sign-in and the tools you allowed go with it.</span>
      <Button size="sm" variant="destructive" pending={pending} onClick={() => void remove()}>
        Remove
      </Button>
      <Button size="sm" variant="ghost" disabled={pending} onClick={onCancel}>
        Cancel
      </Button>
    </div>
  )
}

/** What a connected server offers: its events, skills and Telegram channel, then its tools. */
function ServerBody({
  server,
  tools,
  update,
  onReload,
  onMessage,
  channel,
}: ServerCardProps & {
  readonly tools: readonly ToolView[] | undefined
  readonly update: (change: (current: readonly ToolView[]) => readonly ToolView[]) => void
}) {
  const settings = server.skillsOffered === true || server.skillsEnabled === true || hasTelegramTools(tools ?? [])
  return (
    <CardContent>
      <div className="server-body">
        <EventsHealth events={server.eventHealth ?? []} />
        {settings && (
          <section className="server-part" aria-label="Settings">
            {(server.skillsOffered === true || server.skillsEnabled === true) && (
              <SkillsSwitch server={server} onMessage={onMessage} onChanged={onReload} />
            )}
            {tools !== undefined && hasTelegramTools(tools) && (
              <TelegramControl serverId={server.serverId} channel={channel} />
            )}
          </section>
        )}
        {tools === undefined ? (
          <p className="server-note" role="status">
            Loading its tools…
          </p>
        ) : (
          <ToolGrants serverId={server.serverId} tools={tools} setTools={update} onMessage={onMessage} />
        )}
      </div>
    </CardContent>
  )
}

type ServerCardProps = {
  readonly server: ServerView
  readonly onReload: () => void
  readonly onMessage: (message: string) => void
  readonly channel: TelegramChannel
}

export function ServerCard({ server, onReload, onMessage, channel }: ServerCardProps) {
  const { tools, loadTools, update } = useServerTools(server, onMessage)
  const [pending, setPending] = useState<Action>()
  const [removing, setRemoving] = useState(false)
  const loaded = tools !== undefined
  // Loading tools opens the connection; reload once so what it declares (skills) shows.
  useEffect(() => {
    if (loaded && !server.live) onReload()
  }, [loaded, server.live, onReload])
  async function act(action: Action): Promise<void> {
    setPending(action)
    try {
      if (action === 'refresh') return await loadTools(true)
      const next = record(await request(path(server.serverId, action), { body: {} }))?.authorizationUrl
      if (typeof next === 'string') window.location.assign(next)
      else onReload()
    } catch (error) {
      onMessage(failureText(error))
    } finally {
      setPending(undefined)
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <span className="server-title">
            <AppTile origin={server.serverId} />
            {serverTitle(server)}
          </span>
        </CardTitle>
        <CardDescription>{shortEndpoint(server.endpoint)}</CardDescription>
        <CardAction>
          <div className="server-actions">
            <StatusLabel label={serverStatus(server.status)} />
            {server.status !== 'connected' && (
              <Button size="sm" pending={pending === 'connect'} onClick={() => void act('connect')}>
                {server.status === 'needs_auth' ? 'Sign in again' : 'Connect'}
              </Button>
            )}
            <ServerMenu
              server={server}
              busy={pending !== undefined && pending !== 'connect'}
              onAct={(action) => void act(action)}
              onRemove={() => setRemoving(true)}
            />
          </div>
        </CardAction>
      </CardHeader>
      {(server.description !== undefined || removing) && (
        <CardContent>
          <div className="server-body">
            {server.description !== undefined && (
              <p className="server-claim">
                <span>The server says:</span> {server.description}
              </p>
            )}
            {removing && (
              <RemoveConfirm
                server={server}
                onRemoved={onReload}
                onCancel={() => setRemoving(false)}
                onMessage={onMessage}
              />
            )}
          </div>
        </CardContent>
      )}
      {server.status === 'connected' && (
        <ServerBody
          server={server}
          tools={tools}
          update={update}
          onReload={onReload}
          onMessage={onMessage}
          channel={channel}
        />
      )}
    </Card>
  )
}
