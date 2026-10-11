// Adding the owner's own MCP servers, by URL or from the servers we suggest. A pasted URL is checked by the runtime (public https only) and
// labelled from the server's card; it starts disconnected and is connected like any other.
import { type SubmitEvent, useState } from 'react'
import { useMutation, useSuspenseQuery } from '@tanstack/react-query'
import type { ServerSuggestion, ServerView } from '@goblin/contracts'
import { InvalidInput } from '@goblin/contracts/api'
import { Button, Field, FieldDescription, FieldGroup, FieldLabel, Input } from '@goblin/ui'
import { addServerMutation, suggestedQuery } from '../mcp/queries.ts'
import { useAddAndConnect } from '../mcp/hooks.ts'
import { messageOf } from '../lib/query/app-error.ts'

/** Why the runtime refused an endpoint, in words the owner can act on. */
const REFUSED: Record<string, string> = {
  endpoint_not_https: 'Use an https:// address.',
  endpoint_not_public: 'That address is private or local; only public servers can be added.',
  endpoint_not_a_url: 'That is not a web address.',
  endpoint_invalid: 'Remove any user name, password or #fragment from the address.',
  too_many_servers: 'You have added thirty-two connections; remove one first.',
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
  const [endpoint, setEndpoint] = useState('')
  const adding = useMutation(addServerMutation)
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

/**
 * Servers we suggest, checked to work from here: one tap adds and connects. One the owner already has can be connected
 * again, as another account (ADR 0041). It suspends until the suggestions are read.
 */
export function SuggestedServers({
  onChanged,
  onMessage,
}: {
  readonly onChanged: (message: string) => void
  readonly onMessage: (message: string) => void
}) {
  const items = useSuspenseQuery(suggestedQuery).data
  const connect = useAddAndConnect()
  const [busy, setBusy] = useState('')
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
            disabled={busy !== '' && busy !== item.id}
            pending={busy === item.id}
            onClick={() => void add(item)}
          >
            {item.added ? 'Add another' : 'Add'}
          </Button>
        </li>
      ))}
    </ul>
  )
}
