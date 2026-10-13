// One of the owner's connections (ADR 0041): its name, the server it reaches, where it stands and its actions (Open for
// its App), then once connected a summary, and behind Manage access its words, events, skills, Telegram channel and
// tools. A server's title and description are its own claims.
import { useEffect, useId, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { ServerView, ToolView } from '@goblin/contracts'
import { Link } from '@tanstack/react-router'
import {
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Switch,
} from '@goblin/ui'
import { ChevronRightIcon } from 'lucide-react'
import {
  connectMutation,
  connectedToolsQuery,
  disconnectMutation,
  refreshToolsMutation,
  setSkillsMutation,
} from '../mcp/queries.ts'
import { messageOf } from '../lib/query/app-error.ts'
import { glide } from '../lib/motion.ts'
import { routinesQuery } from '../routines/queries.ts'
import { QueryError } from '../lib/query/query-boundary.tsx'
import { serverStatus } from '../lib/labels.ts'
import { ConnectionEvents, eventsAnchor } from './connection-events.tsx'
import { AppTile } from './apps/app-tile.tsx'
import { StatusLabel } from './status-label.tsx'
import { type TelegramChannel, TelegramControl, hasTelegramTools } from './telegram-control.tsx'
import { AnotherConnection, ChooseAccess, RenameConnection } from './connection-forms.tsx'
import { type Action, type Edit, RemoveConfirm, ServerMenu } from './server-menu.tsx'
import { FirstClassAccess, FirstClassSummary } from './first-class.tsx'
import { ToolGrants } from './tool-grants.tsx'

/**
 * What the server behind a connection is called, beside the owner's label: goblin's own name for a first-class server,
 * else its card's title. Not the name it reports in `initialize`, which is an identifier (`coingecko_typescript_api`).
 */
const serverFrom = (server: ServerView): string | undefined => server.profile?.title ?? server.title

/** The endpoint's host, which is what tells servers apart on a card; the whole endpoint is its title. */
function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host
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
          Skills are procedures your agent follows. Turn this on only for a skills library you trust, such as your own
          through mysi. A skill never allows a tool by itself.
        </span>
      </span>
      <Switch checked={enabled} disabled={pending} aria-busy={pending} aria-labelledby={id} onCheckedChange={change} />
    </div>
  )
}

/**
 * What a connected server offers, behind Manage access: its own words, its paid tool's rule, its events (and what goblin
 * does with them), skills, Telegram, then its tools.
 */
function ServerBody({
  server,
  tools,
  failure,
  onMessage,
  channel,
}: Omit<ServerCardProps, 'onDone'> & {
  readonly tools: readonly ToolView[] | undefined
  /** Why its tools could not be read, if they could not, and a way to read them again. */
  readonly failure: { readonly error: unknown; readonly retry: () => void }
}) {
  const settings = server.skillsOffered === true || server.skillsEnabled === true || hasTelegramTools(tools ?? [])
  return (
    <CardContent>
      <div className="server-body server-body-open">
        {/* A first-class server is described in goblin's own words (ADR 0043); any other only as it claims. */}
        {server.profile === undefined ? (
          server.description !== undefined && (
            <p className="server-claim">
              <span>The server says:</span> {server.description}
            </p>
          )
        ) : (
          <p className="server-note">{server.profile.description}</p>
        )}
        {server.profile !== undefined && <FirstClassAccess server={server} profile={server.profile} tools={tools} />}
        <ConnectionEvents server={server} />
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
          <QueryError error={failure.error} action={`list the tools of ${server.label}`} onRetry={failure.retry} />
        ) : tools === undefined ? (
          <p className="server-note" role="status">
            Loading its tools…
          </p>
        ) : (
          <ToolGrants connectionId={server.connectionId} tools={tools} />
        )}
      </div>
    </CardContent>
  )
}

type ServerCardProps = {
  readonly server: ServerView
  readonly onReload: () => void
  readonly onMessage: (message: string) => void
  /** Something done, said where the page tells the owner (another connection added). */
  readonly onDone: (message: string) => void
  readonly channel: TelegramChannel
}

/** Connect, Disconnect and Look for new tools, with which of them is under way. */
function useServerActions(server: ServerView, onMessage: (message: string) => void) {
  const connect = useMutation(connectMutation)
  const disconnect = useMutation(disconnectMutation)
  const refresh = useMutation(refreshToolsMutation)
  const title = server.label
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
      connect.mutate(
        { connectionId: server.connectionId },
        {
          onSuccess: ({ authorizationUrl }) => {
            if (authorizationUrl !== undefined) window.location.assign(authorizationUrl)
          },
          onError: failed(`connect ${title}`),
        },
      )
    else if (action === 'disconnect') disconnect.mutate(server.connectionId, { onError: failed(`disconnect ${title}`) })
    else refresh.mutate(server.connectionId, { onError: failed(`look for new tools on ${title}`) })
  }
  return { pending, act }
}

/** The card's inline part under its header while one is open: Remove's confirmation, or a menu's form. */
function CardForms({
  server,
  editing,
  removing,
  onClose,
  onDone,
  onMessage,
}: Pick<ServerCardProps, 'server' | 'onDone' | 'onMessage'> & {
  readonly editing: Edit | undefined
  readonly removing: boolean
  readonly onClose: () => void
}) {
  if (!removing && editing === undefined) return null
  return (
    <CardContent>
      <div className="server-body">
        {removing && <RemoveConfirm server={server} onCancel={onClose} onMessage={onMessage} />}
        {editing === 'rename' && <RenameConnection server={server} onDone={onClose} onMessage={onMessage} />}
        {editing === 'access' && <ChooseAccess server={server} onCancel={onClose} onMessage={onMessage} />}
        {editing === 'another' && (
          <AnotherConnection
            server={server}
            onDone={(message) => {
              onClose()
              if (message !== '') onDone(message)
            }}
            onMessage={onMessage}
          />
        )}
      </div>
    </CardContent>
  )
}

/** The card's head: the connection's name and server, where it stands, Open for its App, and its menu. */
function ServerHeading({
  server,
  pending,
  onAct,
  onEdit,
  onRemove,
}: {
  readonly server: ServerView
  readonly pending: Action | undefined
  readonly onAct: (action: Action) => void
  readonly onEdit: (edit: Edit) => void
  readonly onRemove: () => void
}) {
  const from = serverFrom(server)
  const appTool = server.profile?.app?.tool ?? server.entrypoint
  const connected = server.status === 'connected'
  const status = <StatusLabel label={serverStatus(server.status)} />
  // Where it stands is said once: beside the actions on a wide card, on the quiet line under the name on a narrow one.
  return (
    <CardHeader>
      <CardTitle>
        <span className="server-title">
          <AppTile origin={server.connectionId} />
          <span className="server-name">{server.label}</span>
        </span>
      </CardTitle>
      <CardDescription>
        <span className="server-from">
          {status}
          {from !== undefined && from !== server.label && (
            <>
              <span>{from}</span>
              <span className="server-sep" aria-hidden="true">
                ·
              </span>
            </>
          )}
          <span title={server.endpoint}>{endpointHost(server.endpoint)}</span>
        </span>
      </CardDescription>
      <CardAction>
        <div className="server-actions">
          {status}
          {connected && appTool !== undefined && (
            <Button
              size="sm"
              variant="outline"
              nativeButton={false}
              render={<Link to="/connections/$connectionId/app" params={{ connectionId: server.connectionId }} />}
            >
              Open
            </Button>
          )}
          {!connected && (
            <Button size="sm" pending={pending === 'connect'} onClick={() => onAct('connect')}>
              {server.status === 'needs_auth' ? 'Sign in again' : 'Connect'}
            </Button>
          )}
          <ServerMenu
            server={server}
            busy={pending !== undefined && pending !== 'connect'}
            onAct={onAct}
            onEdit={onEdit}
            onRemove={onRemove}
          />
        </div>
      </CardAction>
    </CardHeader>
  )
}

/** Where a connection's card is on Connections, for a link from Activity. */
export const connectionAnchor = (connectionId: string): string => `connection-${connectionId}`

/** Brings a connection's Events into view once Manage access has opened them (it mounts on the next frame). */
function showEvents(connectionId: string): void {
  requestAnimationFrame(() =>
    requestAnimationFrame(() =>
      document.getElementById(eventsAnchor(connectionId))?.scrollIntoView({ block: 'start', behavior: glide() }),
    ),
  )
}

/** "12 of 17 tools allowed", once the tools are read. */
const allowedCount = (tools: readonly ToolView[] | undefined): string =>
  tools === undefined ? '' : `${tools.filter((tool) => tool.granted).length} of ${tools.length} tools allowed`

/**
 * That a connected server sends events, on its summary so it is seen without opening Manage access: how many are set
 * up, and the way to them. Nothing once the owner said they want none of them and none is set up.
 */
function EventsLine({ server, onOpen }: { readonly server: ServerView; readonly onOpen: () => void }) {
  const routines = useQuery(routinesQuery).data?.routines ?? []
  const set = routines.filter(
    ({ definition: { trigger } }) => trigger.kind === 'event' && trigger.connectionId === server.connectionId,
  ).length
  if (server.events === undefined || (server.events === 'dismissed' && set === 0)) return null
  return (
    <div className="server-summary-row">
      <span className="server-note tabular-nums">{set === 0 ? 'Sends events' : `Sends events, ${set} set up`}</span>
      <Button size="sm" variant="outline" onClick={onOpen}>
        {set === 0 ? 'Set up' : 'Change'}
      </Button>
    </div>
  )
}

/**
 * A connected server at a glance: its first-class line and recommended access, that it sends events, and Manage
 * access, which opens what it offers and what the agent may call. The card a #connection link names opens at once.
 */
function ServerSummary({
  server,
  tools,
  open,
  onEvents,
}: {
  readonly server: ServerView
  readonly tools: readonly ToolView[] | undefined
  readonly open: boolean
  readonly onEvents: () => void
}) {
  return (
    <CardContent>
      <div className="server-summary">
        {server.profile !== undefined && <FirstClassSummary server={server} profile={server.profile} tools={tools} />}
        <EventsLine server={server} onOpen={onEvents} />
        <div className="server-summary-row">
          <CollapsibleTrigger render={<button type="button" className="server-toggle" />}>
            <ChevronRightIcon aria-hidden />
            {open ? 'Hide access' : 'Manage access'}
          </CollapsibleTrigger>
          <span className="server-note tabular-nums">{allowedCount(tools)}</span>
        </div>
      </div>
    </CardContent>
  )
}

export function ServerCard({ server, onReload, onMessage, onDone, channel }: ServerCardProps) {
  const { tools, error, retry } = useServerTools(server)
  const { pending, act } = useServerActions(server, onMessage)
  const [removing, setRemoving] = useState(false)
  const [editing, setEditing] = useState<Edit>()
  const [open, setOpen] = useState(
    () => typeof window !== 'undefined' && window.location.hash === `#${connectionAnchor(server.connectionId)}`,
  )
  const connected = server.status === 'connected'
  const loaded = tools !== undefined
  // Loading tools opens the connection; reload once so what it declares (skills) shows.
  useEffect(() => {
    if (loaded && !server.live) onReload()
  }, [loaded, server.live, onReload])
  return (
    <Card id={connectionAnchor(server.connectionId)}>
      <ServerHeading
        server={server}
        pending={pending}
        onAct={act}
        onEdit={(edit) => {
          setRemoving(false)
          setEditing(edit)
        }}
        onRemove={() => {
          setEditing(undefined)
          setRemoving(true)
        }}
      />
      <CardForms
        server={server}
        editing={editing}
        removing={removing}
        onClose={() => {
          setEditing(undefined)
          setRemoving(false)
        }}
        onDone={onDone}
        onMessage={onMessage}
      />
      {connected && (
        <Collapsible open={open} onOpenChange={setOpen}>
          <ServerSummary
            server={server}
            tools={tools}
            open={open}
            onEvents={() => {
              setOpen(true)
              showEvents(server.connectionId)
            }}
          />
          <CollapsibleContent>
            <ServerBody
              server={server}
              tools={tools}
              failure={{ error, retry }}
              onReload={onReload}
              onMessage={onMessage}
              channel={channel}
            />
          </CollapsibleContent>
        </Collapsible>
      )}
    </Card>
  )
}
