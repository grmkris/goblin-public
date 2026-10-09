// Finding servers in MCP registries. Everything shown comes from the publisher and is labelled with the registry it
// came from; "namespace verified" appears only where the registry checks it. Adding one works as adding by URL.
import { type SubmitEvent, useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CatalogEntry } from '@goblin/contracts'
import { InvalidInput } from '@goblin/contracts/api'
import { Badge, Button, Input, Spinner } from '@goblin/ui'
import { optionalCatalogQuery, registriesQuery, registryMutation } from '../mcp/queries.ts'
import { messageOf } from '../lib/query/app-error.ts'
import { useAddAndConnect } from './server-add.tsx'

const REGISTRY_REFUSED: Record<string, string> = {
  not_a_registry: 'That address does not answer the MCP registry API (/v0.1/servers).',
  endpoint_not_https: 'Use an https:// address.',
  endpoint_not_public: 'That address is private or local.',
  already_added: 'That registry is already searched.',
  too_many_registries: 'You have added eight registries; remove one first.',
}

/** The registries searched: the built-in two, then the owner's own, which they may add and remove. */
function Registries({ onMessage }: { readonly onMessage: (message: string) => void }) {
  const queryClient = useQueryClient()
  const read = useQuery(registriesQuery)
  const change = useMutation(registryMutation(queryClient))
  const registries = read.data ?? []
  const [url, setUrl] = useState('')
  const failed = (error: unknown) =>
    onMessage(
      (error instanceof InvalidInput ? REGISTRY_REFUSED[error.reason] : undefined) ??
        messageOf(error, 'change the registries'),
    )
  function add(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault()
    change.mutate({ url, remove: false }, { onSuccess: () => setUrl(''), onError: failed })
  }
  return (
    <details className="registries">
      <summary>Registries searched ({registries.length})</summary>
      {read.error !== null && (
        <p className="server-note" role="alert">
          {messageOf(read.error, 'list the registries')}
        </p>
      )}
      <ul className="pick-list">
        {registries.map((registry) => (
          <li key={registry.url} className="pick-row">
            <span className="flex min-w-0 flex-col">
              <span className="text-sm font-medium">{registry.title}</span>
              <span className="truncate text-xs text-muted-foreground">{registry.url}</span>
            </span>
            {registry.builtIn ? (
              <span className="pick-meta">Built in</span>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => change.mutate({ url: registry.url, remove: true }, { onError: failed })}
              >
                Remove
              </Button>
            )}
          </li>
        ))}
      </ul>
      <form className="address-row" onSubmit={add}>
        <Input
          type="url"
          aria-label="Registry address"
          placeholder="https://registry.example.com"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
        <Button type="submit" variant="outline" pending={change.isPending} disabled={url.trim() === ''}>
          Add registry
        </Button>
      </form>
    </details>
  )
}

/** A filled-in URL template value: one path segment, nothing that could change the host or path. */
const SEGMENT = /^[\w.~-]{1,128}$/u

/** The endpoint with its placeholders filled, or nothing while one is missing or unsafe. */
export function filledEndpoint(endpoint: string, values: Readonly<Record<string, string>>): string | undefined {
  let missing = false
  const filled = endpoint.replace(/\{([\w-]{1,64})\}/gu, (_, name: string) => {
    const value = values[name]?.trim() ?? ''
    if (!SEGMENT.test(value)) missing = true
    return encodeURIComponent(value)
  })
  return missing ? undefined : filled
}

function Result({
  entry,
  onAdd,
  busy,
  adding,
}: {
  readonly entry: CatalogEntry
  readonly onAdd: (endpoint: string) => void
  /** Some result is being added. */
  readonly busy: boolean
  /** This one is. */
  readonly adding: boolean
}) {
  const [values, setValues] = useState<Readonly<Record<string, string>>>({})
  const endpoint = filledEndpoint(entry.endpoint, values)
  return (
    <li className="pick-row">
      <span className="grant-text">
        <span className="grant-name">
          {entry.title ?? entry.name}
          {entry.verified && <Badge variant="outline">namespace verified</Badge>}
          {entry.needsKey && <Badge variant="outline">needs an API key</Badge>}
        </span>
        <span className="pick-source">
          {entry.name} · from {entry.registryTitle}
        </span>
        {entry.description && <span className="grant-about">{entry.description}</span>}
        {entry.variables.map((name) => (
          <Input
            key={name}
            aria-label={name}
            placeholder={name}
            value={values[name] ?? ''}
            onChange={(event) => setValues((current) => ({ ...current, [name]: event.target.value }))}
          />
        ))}
      </span>
      <Button
        size="sm"
        variant={entry.added ? 'ghost' : 'outline'}
        disabled={entry.added || entry.needsKey || endpoint === undefined || (busy && !adding)}
        pending={adding}
        onClick={() => endpoint && onAdd(endpoint)}
      >
        {entry.added ? 'Added' : 'Add'}
      </Button>
    </li>
  )
}

type Search =
  | { readonly kind: 'idle' }
  | { readonly kind: 'searching' }
  | { readonly kind: 'found'; readonly results: readonly CatalogEntry[] }
  | { readonly kind: 'failed'; readonly reason: string }

/** `value` once it has stayed the same for `ms`. */
function useSettled(value: string, ms: number): string {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return settled
}

/** The registries' answer for what the owner typed, a moment after they stop typing. */
function useCatalog(query: string): Search {
  const text = query.trim()
  const settled = useSettled(text, 300)
  const read = useQuery(optionalCatalogQuery(settled.length < 2 ? undefined : settled))
  if (text.length < 2) return { kind: 'idle' }
  if (text !== settled || read.isFetching) return { kind: 'searching' }
  if (read.error !== null) return { kind: 'failed', reason: messageOf(read.error, 'search the registries') }
  return read.data === undefined ? { kind: 'searching' } : { kind: 'found', results: read.data }
}

/** Search the MCP registries; results update as the owner types. */
export function ServerSearch({
  onChanged,
  onMessage,
}: {
  readonly onChanged: (message: string) => void
  readonly onMessage: (message: string) => void
}) {
  const [query, setQuery] = useState('')
  const search = useCatalog(query)
  const addAndConnect = useAddAndConnect()
  const [adding, setAdding] = useState('')
  async function add(entry: CatalogEntry, endpoint: string): Promise<void> {
    setAdding(entry.name)
    try {
      const source = { registry: entry.registry, name: entry.name, ...(entry.version && { version: entry.version }) }
      onChanged(await addAndConnect(endpoint, entry.title ?? entry.name, source))
    } catch (error) {
      onMessage(messageOf(error, `add ${entry.title ?? entry.name}`))
    } finally {
      setAdding('')
    }
  }
  return (
    <div className="pick-panel">
      <div className="search-field">
        <Input
          type="search"
          aria-label="Search MCP registries"
          placeholder="notes, calendar, github…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {search.kind === 'searching' && <Spinner />}
      </div>
      {search.kind === 'idle' && (
        <p className="server-note">
          Searches the MCP Registry, GitHub's and any you add. Listings are the publishers' own words.
        </p>
      )}
      {search.kind === 'failed' && (
        <p className="server-note" role="alert">
          {search.reason}
        </p>
      )}
      {search.kind === 'found' && search.results.length === 0 && (
        <p className="server-note">No server this agent can reach matches “{query.trim()}”.</p>
      )}
      {search.kind === 'found' && search.results.length > 0 && (
        <ul className="pick-list">
          {search.results.map((entry) => (
            <Result
              key={entry.name}
              entry={entry}
              busy={adding !== ''}
              adding={adding === entry.name}
              onAdd={(endpoint) => void add(entry, endpoint)}
            />
          ))}
        </ul>
      )}
      <Registries onMessage={onMessage} />
    </div>
  )
}
