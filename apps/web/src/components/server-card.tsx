// One of the owner's MCP servers: its name, where it stands, its actions, and once connected, the events, skills,
// Telegram channel and tools it offers. A server's title and description are its own claims.
import { useEffect, useId, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { ServerView, ToolView } from '@goblin/contracts'
import { Button, Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle, Switch } from '@goblin/ui'
import {
  connectMutation,
  connectedToolsQuery,
  disconnectMutation,
  refreshToolsMutation,
  setSkillsMutation,
} from '../mcp/queries.ts'
import { messageOf } from '../lib/query/app-error.ts'
import { QueryError } from '../lib/query/query-boundary.tsx'
import { serverStatus, serverTitle } from '../lib/labels.ts'
import { EventsHealth } from './event-health.tsx'
import { AppTile } from './apps/app-tile.tsx'
import { StatusLabel } from './status-label.tsx'
import { type TelegramChannel, TelegramControl, hasTelegramTools } from './telegram-control.tsx'
import { type Action, RemoveConfirm, ServerMenu } from './server-menu.tsx'
import { ToolGrants } from './tool-grants.tsx'

/** The endpoint without its scheme, which is always https for an added server. */
function shortEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint)
    return `${url.host}${url.pathname === '/' ? '' : url.pathname}`
  } catch {
    // expected: an endpoint the URL parser refuses is shown as it was stored
    return endpoint
  }
}

/** The server's discovered tools, from the Query cache once it is connected; grant changes update them there. */
function useServerTools(server: ServerView) {
  const read = useQuery(connectedToolsQuery(server.connectionId, server.status === 'connected'))
  return { tools: read.data, error: read.error, retry: () => void read.refetch() }
}

/**
 * Whether the agent follows this server's skills. A skill is a procedure the agent reads and acts on, so this is for a
 * library the owner trusts; a skill still never allows a tool by itself.
 */
function SkillsSwitch({
  server,
  onMessage,
}: {
  readonly server: ServerView
  readonly onMessage: (message: string) => void
}) {
  const id = useId()
  const toggle = useMutation(setSkillsMutation)
  const pending = toggle.isPending
  const enabled = pending ? toggle.variables.enabled : server.skillsEnabled === true
  const change = (next: boolean) =>
    toggle.mutate(
      { connectionId: server.connectionId, enabled: next },
      { onError: (error) => onMessage(messageOf(error, "change whether your agent uses this server's skills")) },
    )
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
      <Switch checked={enabled} disabled={pending} aria-busy={pending} aria-labelledby={id} onCheckedChange={change} />
    </div>
  )
}

/** What a connected server offers: its events, skills and Telegram channel, then its tools. */
function ServerBody({
  server,
  tools,
  failure,
  onMessage,
  channel,
}: ServerCardProps & {
  readonly tools: readonly ToolView[] | undefined
  /** Why its tools could not be read, if they could not, and a way to read them again. */
  readonly failure: { readonly error: unknown; readonly retry: () => void }
}) {
  const settings = server.skillsOffered === true || server.skillsEnabled === true || hasTelegramTools(tools ?? [])
  return (
    <CardContent>
      <div className="server-body">
        <EventsHealth events={server.eventHealth ?? []} />
        {settings && (
          <section className="server-part" aria-label="Settings">
            {(server.skillsOffered === true || server.skillsEnabled === true) && (
              <SkillsSwitch server={server} onMessage={onMessage} />
            )}
            {tools !== undefined && hasTelegramTools(tools) && (
              <TelegramControl connectionId={server.connectionId} channel={channel} />
            )}
          </section>
        )}
        {failure.error !== null ? (
          <QueryError
            error={failure.error}
            action={`list the tools of ${serverTitle(server)}`}
            onRetry={failure.retry}
          />
        ) : tools === undefined ? (
          <p className="server-note" role="status">
            Loading its tools…
          </p>
        ) : (
          <ToolGrants connectionId={server.connectionId} tools={tools} onMessage={onMessage} />
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

/** Connect, Disconnect and Look for new tools, with which of them is under way. */
function useServerActions(server: ServerView, onMessage: (message: string) => void) {
  const connect = useMutation(connectMutation)
  const disconnect = useMutation(disconnectMutation)
  const refresh = useMutation(refreshToolsMutation)
  const title = serverTitle(server)
  const failed = (action: string) => (error: unknown) => onMessage(messageOf(error, action))
  // An authorization URL means the page is leaving for the server's sign-in.
  const leaving = connect.isSuccess && connect.data.authorizationUrl !== undefined
  const pending: Action | undefined =
    connect.isPending || leaving
      ? 'connect'
      : disconnect.isPending
        ? 'disconnect'
        : refresh.isPending
          ? 'refresh'
          : undefined
  function act(action: Action): void {
    if (action === 'connect')
      connect.mutate(server.connectionId, {
        onSuccess: ({ authorizationUrl }) => {
          if (authorizationUrl !== undefined) window.location.assign(authorizationUrl)
        },
        onError: failed(`connect ${title}`),
      })
    else if (action === 'disconnect') disconnect.mutate(server.connectionId, { onError: failed(`disconnect ${title}`) })
    else refresh.mutate(server.connectionId, { onError: failed(`look for new tools on ${title}`) })
  }
  return { pending, act }
}

export function ServerCard({ server, onReload, onMessage, channel }: ServerCardProps) {
  const { tools, error, retry } = useServerTools(server)
  const { pending, act } = useServerActions(server, onMessage)
  const [removing, setRemoving] = useState(false)
  const loaded = tools !== undefined
  // Loading tools opens the connection; reload once so what it declares (skills) shows.
  useEffect(() => {
    if (loaded && !server.live) onReload()
  }, [loaded, server.live, onReload])
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <span className="server-title">
            <AppTile origin={server.connectionId} />
            {serverTitle(server)}
          </span>
        </CardTitle>
        <CardDescription>{shortEndpoint(server.endpoint)}</CardDescription>
        <CardAction>
          <div className="server-actions">
            <StatusLabel label={serverStatus(server.status)} />
            {server.status !== 'connected' && (
              <Button size="sm" pending={pending === 'connect'} onClick={() => act('connect')}>
                {server.status === 'needs_auth' ? 'Sign in again' : 'Connect'}
              </Button>
            )}
            <ServerMenu
              server={server}
              busy={pending !== undefined && pending !== 'connect'}
              onAct={act}
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
            {removing && <RemoveConfirm server={server} onCancel={() => setRemoving(false)} onMessage={onMessage} />}
          </div>
        </CardContent>
      )}
      {server.status === 'connected' && (
        <ServerBody
          server={server}
          tools={tools}
          failure={{ error, retry }}
          onReload={onReload}
          onMessage={onMessage}
          channel={channel}
        />
      )}
    </Card>
  )
}
