// Adding and removing the owner's own MCP servers, by URL or from the servers we suggest. A pasted URL is checked by the runtime (public https only) and
// labelled from the server's card; it starts disconnected and is connected like any other.
import { useEffect, useState } from 'react'
import { Schema } from 'effect'
import { ServerSuggestion, ServerView } from '@purrable/contracts'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  FieldGroup,
  Input,
} from '@purrable/ui'
import { ApiFailure, failureText, isString, record, request } from '../lib/boundary.ts'

const decodeServer = Schema.decodeUnknownSync(ServerView)

/** Why the runtime refused an endpoint, in words the owner can act on. */
const REFUSED: Record<string, string> = {
  endpoint_not_https: 'Use an https:// address.',
  endpoint_not_public: 'That address is private or local; only public servers can be added.',
  endpoint_not_a_url: 'That is not a web address.',
  endpoint_invalid: 'Remove any user name, password or #fragment from the address.',
  already_added: 'That server is already in your list.',
  too_many_servers: 'You have added sixteen servers; remove one first.',
}

/** Add a server by its MCP endpoint, then connect it from its card. */
export function AddServer({
  onAdded,
  onMessage,
}: {
  readonly onAdded: (server: ServerView) => void
  readonly onMessage: (message: string) => void
}) {
  const [endpoint, setEndpoint] = useState('')
  const [busy, setBusy] = useState(false)
  async function add(): Promise<void> {
    setBusy(true)
    try {
      const server = decodeServer(await request('/api/mcp/servers', { body: { endpoint } }))
      setEndpoint('')
      onAdded(server)
    } catch (error) {
      const refused = error instanceof ApiFailure && error.reason !== undefined ? REFUSED[error.reason] : undefined
      onMessage(refused ?? failureText(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Add a server</CardTitle>
        <CardDescription>Paste an MCP server's address. You connect it and choose its tools next.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void add()
          }}
        >
          <FieldGroup>
            <Field orientation="horizontal">
              <Input
                type="url"
                inputMode="url"
                placeholder="https://example.com/mcp"
                aria-label="Server address"
                value={endpoint}
                onChange={(event) => setEndpoint(event.target.value)}
                required
              />
              <Button type="submit" disabled={busy || endpoint.trim() === ''}>
                Add
              </Button>
            </Field>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  )
}

/** Remove a server the owner added; asks once, because its sign-in and grants go with it. */
export function RemoveServer({
  server,
  onRemoved,
  onMessage,
}: {
  readonly server: ServerView
  readonly onRemoved: () => void
  readonly onMessage: (message: string) => void
}) {
  const [confirming, setConfirming] = useState(false)
  async function remove(): Promise<void> {
    try {
      await request(`/api/mcp/${encodeURIComponent(server.serverId)}/remove`, { body: {} })
      onRemoved()
    } catch (error) {
      onMessage(failureText(error))
    }
  }
  if (!confirming)
    return (
      <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
        Remove
      </Button>
    )
  return (
    <Button size="sm" variant="destructive" onClick={() => void remove()} onBlur={() => setConfirming(false)}>
      Remove with its grants
    </Button>
  )
}

const decodeSuggestions = Schema.decodeUnknownSync(Schema.Array(ServerSuggestion))

/** Where a server came from: a registry entry, recorded with it. */
export type ServerOrigin = { readonly registry: string; readonly name: string; readonly version?: string }

/** Add a server and start connecting it: off to its sign-in, or connected at once if it needs none. */
export async function addAndConnect(endpoint: string, title: string, source?: ServerOrigin): Promise<string> {
  const body = { endpoint, ...(source === undefined ? {} : { source }) }
  const server = decodeServer(await request('/api/mcp/servers', { body }))
  const connect = record(await request(`/api/mcp/${encodeURIComponent(server.serverId)}/connect`, { body: {} }))
  const next = connect?.authorizationUrl
  if (isString(next)) window.location.assign(next)
  return `Connected ${title}. Choose the tools your agent may use.`
}

/** Servers we suggest, checked to connect from here: one tap adds and connects; already added ones say so. */
export function SuggestedServers({
  version,
  onChanged,
  onMessage,
}: {
  /** Changes whenever the server list does, so "Added" stays true. */
  readonly version: number
  readonly onChanged: (message: string) => void
  readonly onMessage: (message: string) => void
}) {
  const [items, setItems] = useState<readonly ServerSuggestion[]>([])
  const [busy, setBusy] = useState('')
  useEffect(() => {
    void request('/api/mcp/suggested')
      .then((data) => setItems(decodeSuggestions(data)))
      .catch((error: unknown) => onMessage(failureText(error)))
  }, [version, onMessage])
  async function add(item: ServerSuggestion): Promise<void> {
    setBusy(item.id)
    try {
      onChanged(await addAndConnect(item.endpoint, item.title))
    } catch (error) {
      onMessage(failureText(error))
    } finally {
      setBusy('')
    }
  }
  if (items.length === 0) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle>Suggested</CardTitle>
        <CardDescription>Servers we have checked work from here. You still choose every tool.</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="suggestions">
          {items.map((item) => (
            <li key={item.id} className="suggestion">
              <span className="flex min-w-0 flex-col gap-1">
                <span className="flex flex-wrap items-center gap-2 font-medium">
                  {item.title}
                  <Badge variant="outline">{item.signIn ? 'sign-in' : 'no sign-in'}</Badge>
                </span>
                <span className="text-sm text-muted-foreground">{item.description}</span>
              </span>
              <Button
                size="sm"
                variant={item.added ? 'ghost' : 'outline'}
                disabled={item.added || busy !== ''}
                onClick={() => void add(item)}
              >
                {item.added ? 'Added' : busy === item.id ? 'Adding…' : 'Add'}
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}
