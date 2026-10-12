// Adding the owner's own MCP servers, by URL or from the servers we suggest. A pasted URL is checked by the runtime
// (public https only) and labelled from the server's card; it starts disconnected and is connected like any other. The
// suggestions sit on a shelf in groups (ADR 0052): the owner's own apps through mysi, goblin's services, then servers
// that need no sign-in by what they are for.
import { type SubmitEvent, useId, useState } from 'react'
import { useMutation, useSuspenseQuery } from '@tanstack/react-query'
import type { ServerGroup, ServerSuggestion, ServerView } from '@goblin/contracts'
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

/** The shelf's groups in the order it shows them, each under its name. */
const GROUPS: readonly { readonly group: ServerGroup; readonly title: string }[] = [
  { group: 'yours', title: 'Your apps' },
  { group: 'goblin', title: 'Pay and publish' },
  { group: 'travel', title: 'Travel' },
  { group: 'knowledge', title: 'Knowledge' },
  { group: 'crypto', title: 'Crypto data' },
  { group: 'apps', title: 'Views in the chat' },
  { group: 'code', title: 'Code and docs' },
]

/** One suggestion: what it is in our words, and Add (Add another once the owner has it). */
function SuggestionRow({
  item,
  meta,
  busy,
  onAdd,
}: {
  readonly item: ServerSuggestion
  /** Whether it needs sign-in, said on the row when its group does not say it for all of them. */
  readonly meta: boolean
  /** Which suggestion is being added, if one is. */
  readonly busy: string
  readonly onAdd: (item: ServerSuggestion) => void
}) {
  return (
    <li className="pick-row">
      <span className="grant-text">
        <span className="grant-name">{item.title}</span>
        <span className="grant-about">{item.description}</span>
      </span>
      {meta && <span className="pick-meta">{item.signIn ? 'Sign-in' : 'No sign-in'}</span>}
      <Button
        size="sm"
        variant={item.added ? 'ghost' : 'outline'}
        disabled={busy !== '' && busy !== item.id}
        pending={busy === item.id}
        onClick={() => onAdd(item)}
      >
        {item.added ? 'Add another' : 'Add'}
      </Button>
    </li>
  )
}

/**
 * Servers we suggest, checked to work from here, in their groups: one tap adds and connects. A group whose servers all
 * need no sign-in says so once, by its name. One the owner already has can be connected again, as another account
 * (ADR 0041). It suspends until the suggestions are read.
 */
export function SuggestedServers({
  onChanged,
  onMessage,
  exclude = [],
  connectWith,
}: {
  readonly onChanged: (message: string) => void
  readonly onMessage: (message: string) => void
  /** Suggestions to leave out by id, such as the ones Start asks for in steps of their own. */
  readonly exclude?: readonly string[]
  /** How to add and sign in to a suggestion, when a page brings the owner back somewhere of its own (Start). */
  readonly connectWith?: (item: ServerSuggestion) => Promise<string>
}) {
  const items = useSuspenseQuery(suggestedQuery).data.filter((item) => !exclude.includes(item.id))
  const connect = useAddAndConnect()
  const [busy, setBusy] = useState('')
  const heading = useId()
  async function add(item: ServerSuggestion): Promise<void> {
    setBusy(item.id)
    try {
      onChanged(await (connectWith?.(item) ?? connect(item.endpoint, item.title)))
    } catch (error) {
      onMessage(messageOf(error, `add ${item.title}`))
    } finally {
      setBusy('')
    }
  }
  if (items.length === 0) return <p className="server-note">Nothing to suggest right now.</p>
  const shelf = GROUPS.map(({ group, title }) => ({
    group,
    title,
    items: items.filter((item) => item.group === group),
  })).filter((section) => section.items.length > 0)
  return (
    <div className="shelf">
      {shelf.map((section) => {
        const open = section.items.every((item) => !item.signIn)
        const mixed = !open && section.items.some((item) => !item.signIn)
        return (
          <section key={section.group} className="shelf-group" aria-labelledby={`${heading}-${section.group}`}>
            <div className="shelf-head">
              <h3 id={`${heading}-${section.group}`} className="shelf-title">
                {section.title}
              </h3>
              {open && <span className="pick-meta">No sign-in</span>}
            </div>
            <ul className="pick-list">
              {section.items.map((item) => (
                <SuggestionRow key={item.id} item={item} meta={mixed} busy={busy} onAdd={(next) => void add(next)} />
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}
