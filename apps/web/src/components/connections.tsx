import { useCallback, useEffect, useState } from 'react'
import { Schema } from 'effect'
import { ServerView, ToolView } from '@purrable/contracts'
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Switch,
} from '@purrable/ui'
import { failureText, record, request } from '../lib/boundary.ts'
import { AddServer, RemoveServer } from './server-add.tsx'
import { ToolConsole } from './tool-console.tsx'

const decodeServers = Schema.decodeUnknownSync(Schema.Array(ServerView))
const decodeTools = Schema.decodeUnknownSync(Schema.Array(ToolView))
const path = (serverId: string, action: string): string => `/api/mcp/${encodeURIComponent(serverId)}/${action}`

/** One remote tool with its grant toggle. Remote hints are labelled as the server's claim, never as fact. */
function ToolRow({ tool, onToggle }: { readonly tool: ToolView; readonly onToggle: (allowed: boolean) => void }) {
  return (
    <label className="tool-row">
      <input type="checkbox" checked={tool.granted} onChange={() => onToggle(!tool.granted)} />
      <span className="flex flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2">
          <code>{tool.name}</code>
          {tool.readOnlyHint === true && <Badge variant="outline">says read-only</Badge>}
          {tool.destructiveHint === true && <Badge variant="destructive">says destructive</Badge>}
          {!tool.modelVisible && <Badge variant="outline">app only</Badge>}
        </span>
        {tool.description && <span className="text-muted-foreground text-sm">{tool.description}</span>}
      </span>
    </label>
  )
}

/** An App and the exact tools it uses: one switch allows them all, and each stays listed and adjustable. */
function AppGroup({
  uri,
  tools,
  onAllow,
  onToggle,
}: {
  readonly uri: string
  readonly tools: readonly ToolView[]
  readonly onAllow: (allowed: boolean) => void
  readonly onToggle: (tool: ToolView, allowed: boolean) => void
}) {
  const all = tools.every((tool) => tool.granted)
  const id = `app-${uri}`
  return (
    <section className="tool-app" aria-labelledby={id}>
      <div className="flex items-center gap-3">
        <Switch checked={all} onCheckedChange={(checked) => onAllow(checked)} aria-labelledby={id} />
        <span className="flex min-w-0 flex-col">
          <span id={id} className="text-sm font-medium">
            Allow app
          </span>
          <code className="truncate text-xs text-muted-foreground">{uri}</code>
        </span>
      </div>
      {tools.map((tool) => (
        <ToolRow key={tool.name} tool={tool} onToggle={(allowed) => onToggle(tool, allowed)} />
      ))}
    </section>
  )
}

/** The server's tools, an App's tools grouped under it; grants change here and the list follows. */
function ToolGrants({
  serverId,
  tools,
  setTools,
  onMessage,
}: {
  readonly serverId: string
  readonly tools: readonly ToolView[]
  readonly setTools: (update: (tools: readonly ToolView[]) => readonly ToolView[]) => void
  readonly onMessage: (message: string) => void
}) {
  const grant = (changed: (tool: ToolView) => boolean, allowed: boolean) =>
    setTools((current) => current.map((tool) => (changed(tool) ? { ...tool, granted: allowed } : tool)))
  async function toggle(tool: ToolView, allowed: boolean): Promise<void> {
    try {
      await request('/api/mcp/grants', { method: 'PUT', body: { serverId, name: tool.name, allowed } })
      grant((other) => other.name === tool.name, allowed)
    } catch (error) {
      onMessage(failureText(error))
    }
  }
  async function allowApp(uri: string, allowed: boolean): Promise<void> {
    try {
      await request('/api/mcp/app-grants', { method: 'PUT', body: { serverId, uri, allowed } })
      grant((tool) => tool.appResource === uri, allowed)
    } catch (error) {
      onMessage(failureText(error))
    }
  }
  const apps = [...new Set(tools.flatMap((tool) => (tool.appResource === undefined ? [] : [tool.appResource])))]
  return (
    <>
      {apps.map((uri) => (
        <AppGroup
          key={uri}
          uri={uri}
          tools={tools.filter((tool) => tool.appResource === uri)}
          onAllow={(allowed) => void allowApp(uri, allowed)}
          onToggle={(tool, allowed) => void toggle(tool, allowed)}
        />
      ))}
      {tools
        .filter((tool) => tool.appResource === undefined)
        .map((tool) => (
          <ToolRow key={tool.name} tool={tool} onToggle={(allowed) => void toggle(tool, allowed)} />
        ))}
    </>
  )
}

/** The server's discovered tools: loaded once connected, reloaded on demand, updated in place as grants change. */
function useServerTools(server: ServerView, onMessage: (message: string) => void) {
  const [tools, setTools] = useState<readonly ToolView[]>()
  const loadTools = useCallback(
    (refresh: boolean) => {
      void request(path(server.serverId, `tools${refresh ? '?refresh=1' : ''}`))
        .then((data) => setTools(decodeTools(data)))
        .catch((error: unknown) => onMessage(failureText(error)))
    },
    [server.serverId, onMessage],
  )
  useEffect(() => {
    if (server.status === 'connected') loadTools(false)
  }, [server.status, loadTools])
  const update = (change: (current: readonly ToolView[]) => readonly ToolView[]) =>
    setTools((current) => (current === undefined ? current : change(current)))
  return { tools, loadTools, update }
}

function ServerCard({
  server,
  onReload,
  onMessage,
}: {
  readonly server: ServerView
  readonly onReload: () => void
  readonly onMessage: (message: string) => void
}) {
  const { tools, loadTools, update } = useServerTools(server, onMessage)
  const [pending, setPending] = useState(false)
  async function act(action: 'connect' | 'disconnect'): Promise<void> {
    setPending(true)
    try {
      const data = record(await request(path(server.serverId, action), { body: {} }))
      const next = data?.authorizationUrl
      if (typeof next === 'string') window.location.assign(next)
      else onReload()
    } catch (error) {
      onMessage(failureText(error))
    } finally {
      setPending(false)
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>{server.title ?? server.serverName ?? server.serverId}</CardTitle>
        <CardDescription>
          {server.endpoint}
          {server.description && <span className="block">The server says: {server.description}</span>}
        </CardDescription>
        <CardAction>
          <div className="flex items-center gap-2">
            <Badge variant={server.status === 'connected' ? 'secondary' : 'outline'}>
              {server.status.replace('_', ' ')}
            </Badge>
            {server.source === 'added' && <RemoveServer server={server} onRemoved={onReload} onMessage={onMessage} />}
            {server.status === 'connected' ? (
              <>
                <Button size="sm" variant="outline" disabled={pending} onClick={() => loadTools(true)}>
                  Refresh
                </Button>
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => void act('disconnect')}>
                  Disconnect
                </Button>
              </>
            ) : (
              <Button size="sm" disabled={pending} onClick={() => void act('connect')}>
                {server.status === 'needs_auth' ? 'Reconnect' : 'Connect'}
              </Button>
            )}
          </div>
        </CardAction>
      </CardHeader>
      {server.status === 'connected' && (
        <CardContent>
          <div className="flex flex-col gap-3">
            <p className="text-muted-foreground text-sm">
              Your agent may call only the tools you tick. Descriptions and hints come from the server.
            </p>
            {tools === undefined ? (
              <p role="status">Loading tools…</p>
            ) : (
              <ToolGrants serverId={server.serverId} tools={tools} setTools={update} onMessage={onMessage} />
            )}
          </div>
        </CardContent>
      )}
    </Card>
  )
}

const callbackNotice = (): string => {
  const params = new URLSearchParams(window.location.search)
  const connected = params.get('connected')
  const error = params.get('error')
  if (connected !== null) return `Connected ${connected}. Choose which tools your agent may use.`
  if (error !== null) return `Connection failed (${error}).`
  return ''
}

export function Connections() {
  const [servers, setServers] = useState<readonly ServerView[]>([])
  const [message, setMessage] = useState(callbackNotice)
  const load = useCallback(() => {
    void request('/api/mcp/servers')
      .then((data) => setServers(decodeServers(data)))
      .catch((error: unknown) => setMessage(failureText(error)))
  }, [])
  useEffect(load, [load])
  return (
    <div className="flex flex-col gap-6">
      {message && (
        <Alert>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}
      <AddServer
        onAdded={(server) => {
          setMessage(`Added ${server.title ?? server.serverId}. Connect it, then choose the tools your agent may use.`)
          load()
        }}
        onMessage={setMessage}
      />
      {servers.map((server) => (
        <ServerCard key={server.serverId} server={server} onReload={load} onMessage={setMessage} />
      ))}
      <ToolConsole servers={servers.filter((server) => server.status === 'connected')} />
    </div>
  )
}
