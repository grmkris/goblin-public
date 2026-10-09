// Adding the owner's own MCP servers, by URL or from the servers we suggest. A pasted URL is checked by the runtime (public https only) and
// labelled from the server's card; it starts disconnected and is connected like any other.
import { type SubmitEvent, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ServerSuggestion, ServerView } from '@goblin/contracts'
import { InvalidInput } from '@goblin/contracts/api'
import { Button, Field, FieldDescription, FieldGroup, FieldLabel, Input } from '@goblin/ui'
import { addAndStartConnecting, addServerMutation, serversChanged, suggestedQuery } from '../mcp/queries.ts'
import { messageOf } from '../lib/query/app-error.ts'
import { QueryError } from '../lib/query/query-boundary.tsx'

/** Why the runtime refused an endpoint, in words the owner can act on. */
const REFUSED: Record<string, string> = {
  endpoint_not_https: 'Use an https:// address.',
  endpoint_not_public: 'That address is private or local; only public servers can be added.',
  endpoint_not_a_url: 'That is not a web address.',
  endpoint_invalid: 'Remove any user name, password or #fragment from the address.',
  already_added: 'That server is already in your list.',
  too_many_servers: 'You have added sixteen servers; remove one first.',
}
const refusal = (error: unknown): string | undefined =>
  error instanceof InvalidInput ? REFUSED[error.reason] : undefined

/** Add a server by its MCP endpoint, then connect it from its card. */
export function AddByAddress({
  onAdded,
  onMessage,
}: {
  readonly onAdded: (server: ServerView) => void
  readonly onMessage: (message: string) => void
}) {
  const queryClient = useQueryClient()
  const [endpoint, setEndpoint] = useState('')
  const adding = useMutation(addServerMutation(queryClient))
  function add(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault()
    adding.mutate(
      { endpoint },
      {
        onSuccess: (server) => {
          setEndpoint('')
          onAdded(server)
        },
        onError: (error) => onMessage(refusal(error) ?? messageOf(error, 'add that server')),
      },
    )
  }
  return (
    <form onSubmit={add}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="server-address">The server's address</FieldLabel>
          <div className="address-row">
            <Input
              id="server-address"
              type="url"
              inputMode="url"
              placeholder="https://example.com/mcp"
              value={endpoint}
              onChange={(event) => setEndpoint(event.target.value)}
              required
            />
            <Button type="submit" pending={adding.isPending} disabled={endpoint.trim() === ''}>
              Add
            </Button>
          </div>
          <FieldDescription>Any public MCP server. You connect it and choose its tools next.</FieldDescription>
        </Field>
      </FieldGroup>
    </form>
  )
}

/** Where a server came from: a registry entry, recorded with it. */
export type ServerOrigin = { readonly registry: string; readonly name: string; readonly version?: string }

/** Add a server and start connecting it: off to its sign-in, or connected at once if it needs none. */
export async function addAndConnect(endpoint: string, title: string, source?: ServerOrigin): Promise<string> {
  const started = await addAndStartConnecting({ endpoint, ...(source === undefined ? {} : { source }) })
  if (started.authorizationUrl !== undefined) window.location.assign(started.authorizationUrl)
  return `Connected ${title}. Choose the tools your agent may use.`
}

/** `addAndConnect`, then the server list and the suggestions read again. */
export function useAddAndConnect() {
  const queryClient = useQueryClient()
  return async (endpoint: string, title: string, source?: ServerOrigin): Promise<string> => {
    const done = await addAndConnect(endpoint, title, source)
    await serversChanged(queryClient)
    return done
  }
}

/** Servers we suggest, checked to work from here: one tap adds and connects; already added ones say so. */
export function SuggestedServers({
  onChanged,
  onMessage,
}: {
  readonly onChanged: (message: string) => void
  readonly onMessage: (message: string) => void
}) {
  const read = useQuery(suggestedQuery)
  const connect = useAddAndConnect()
  const [busy, setBusy] = useState('')
  const items = read.data ?? []
  async function add(item: ServerSuggestion): Promise<void> {
    setBusy(item.id)
    try {
      onChanged(await connect(item.endpoint, item.title))
    } catch (error) {
      onMessage(messageOf(error, `add ${item.title}`))
    } finally {
      setBusy('')
    }
  }
  if (read.error !== null)
    return <QueryError error={read.error} action="list the suggested servers" onRetry={() => void read.refetch()} />
  if (read.data === undefined) return <p className="server-note">Looking for suggestions…</p>
  if (items.length === 0) return <p className="server-note">Nothing to suggest right now.</p>
  return (
    <ul className="pick-list">
      {items.map((item) => (
        <li key={item.id} className="pick-row">
          <span className="grant-text">
            <span className="grant-name">{item.title}</span>
            <span className="grant-about">{item.description}</span>
          </span>
          <span className="pick-meta">{item.signIn ? 'Sign-in' : 'No sign-in'}</span>
          <Button
            size="sm"
            variant={item.added ? 'ghost' : 'outline'}
            disabled={item.added || (busy !== '' && busy !== item.id)}
            pending={busy === item.id}
            onClick={() => void add(item)}
          >
            {item.added ? 'Added' : 'Add'}
          </Button>
        </li>
      ))}
    </ul>
  )
}
