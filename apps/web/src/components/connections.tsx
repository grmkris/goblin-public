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
} from '@purrable/ui'
import { failureText, record, request } from '../lib/boundary.ts'
import { ToolConsole } from './tool-console.tsx'

const decodeServers = Schema.decodeUnknownSync(Schema.Array(ServerView))
const decodeTools = Schema.decodeUnknownSync(Schema.Array(ToolView))
const path = (serverId: string, action: string): string => `/api/mcp/${encodeURIComponent(serverId)}/${action}`

/** One remote tool with its grant toggle. Remote hints are labelled as the server's claim, never as fact. */
function ToolRow({
  serverId,
  tool,
  onChange,
}: {
  readonly serverId: string
  readonly tool: ToolView
  readonly onChange: (message: string) => void
}) {
  const [granted, setGranted] = useState(tool.granted)
  async function toggle(): Promise<void> {
    const allowed = !granted
    try {
      await request('/api/mcp/grants', { method: 'PUT', body: { serverId, name: tool.name, allowed } })
      setGranted(allowed)
    } catch (error) {
      onChange(failureText(error))
    }
  }
  return (
    <label className="tool-row">
      <input type="checkbox" checked={granted} onChange={() => void toggle()} />
      <span className="flex flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2">
          <code>{tool.name}</code>
          {tool.readOnlyHint === true && <Badge variant="outline">says read-only</Badge>}
          {tool.destructiveHint === true && <Badge variant="destructive">says destructive</Badge>}
          {!tool.modelVisible && <Badge variant="outline">app only</Badge>}
          {tool.appResource !== undefined && <Badge variant="outline">has app</Badge>}
        </span>
        {tool.description && <span className="text-muted-foreground text-sm">{tool.description}</span>}
      </span>
    </label>
  )
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
  const [tools, setTools] = useState<readonly ToolView[]>()
  const [pending, setPending] = useState(false)
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
        <CardTitle>{server.serverName ?? server.serverId}</CardTitle>
        <CardDescription>{server.endpoint}</CardDescription>
        <CardAction>
          <div className="flex items-center gap-2">
            <Badge variant={server.status === 'connected' ? 'secondary' : 'outline'}>
              {server.status.replace('_', ' ')}
            </Badge>
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
            {tools === undefined && <p role="status">Loading tools…</p>}
            {tools?.map((tool) => (
              <ToolRow key={tool.name} serverId={server.serverId} tool={tool} onChange={onMessage} />
            ))}
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
      {servers.length === 0 && <p className="text-muted-foreground">No MCP servers are configured.</p>}
      {servers.map((server) => (
        <ServerCard key={server.serverId} server={server} onReload={load} onMessage={setMessage} />
      ))}
      <ToolConsole servers={servers.filter((server) => server.status === 'connected')} />
    </div>
  )
}
