// Finding servers in MCP registries. Everything shown comes from the publisher and is labelled with the registry it
// came from; "namespace verified" appears only where the registry checks it. Adding one works as adding by URL.
import { useEffect, useState } from 'react'
import { Schema } from 'effect'
import { CatalogEntry, RegistryView } from '@purrable/contracts'
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input } from '@purrable/ui'
import { ApiFailure, failureText, request } from '../lib/boundary.ts'
import { addAndConnect } from './server-add.tsx'

const decodeEntries = Schema.decodeUnknownSync(Schema.Array(CatalogEntry))
const decodeRegistries = Schema.decodeUnknownSync(Schema.Array(RegistryView))

const REGISTRY_REFUSED: Record<string, string> = {
  not_a_registry: 'That address does not answer the MCP registry API (/v0.1/servers).',
  endpoint_not_https: 'Use an https:// address.',
  endpoint_not_public: 'That address is private or local.',
  already_added: 'That registry is already searched.',
  too_many_registries: 'You have added eight registries; remove one first.',
}

/** The registries searched: the built-in two, then the owner's own, which they may add and remove. */
function Registries({ onMessage }: { readonly onMessage: (message: string) => void }) {
  const [registries, setRegistries] = useState<readonly RegistryView[]>([])
  const [url, setUrl] = useState('')
  useEffect(() => {
    void request('/api/mcp/registries')
      .then((data) => setRegistries(decodeRegistries(data)))
      .catch((error: unknown) => onMessage(failureText(error)))
  }, [onMessage])
  async function change(path: string, target: string): Promise<boolean> {
    try {
      setRegistries(decodeRegistries(await request(path, { body: { url: target } })))
      return true
    } catch (error) {
      const refused = error instanceof ApiFailure && error.reason ? REGISTRY_REFUSED[error.reason] : undefined
      onMessage(refused ?? failureText(error))
      return false
    }
  }
  return (
    <details className="registries">
      <summary>Registries searched ({registries.length})</summary>
      <ul className="suggestions">
        {registries.map((registry) => (
          <li key={registry.url} className="suggestion">
            <span className="flex min-w-0 flex-col">
              <span className="text-sm font-medium">{registry.title}</span>
              <span className="truncate text-xs text-muted-foreground">{registry.url}</span>
            </span>
            {registry.builtIn ? (
              <Badge variant="outline">built in</Badge>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => void change('/api/mcp/registries/remove', registry.url)}>
                Remove
              </Button>
            )}
          </li>
        ))}
      </ul>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void change('/api/mcp/registries', url).then((added) => added && setUrl(''))
        }}
      >
        <Input
          type="url"
          aria-label="Registry address"
          placeholder="https://registry.example.com"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
        <Button type="submit" variant="outline" disabled={url.trim() === ''}>
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
}: {
  readonly entry: CatalogEntry
  readonly onAdd: (endpoint: string) => void
  readonly busy: boolean
}) {
  const [values, setValues] = useState<Readonly<Record<string, string>>>({})
  const endpoint = filledEndpoint(entry.endpoint, values)
  return (
    <li className="suggestion">
      <span className="flex min-w-0 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2 font-medium">
          {entry.title ?? entry.name}
          {entry.verified && <Badge variant="outline">namespace verified</Badge>}
          {entry.needsKey && <Badge variant="outline">needs an API key</Badge>}
        </span>
        <span className="text-xs text-muted-foreground">
          {entry.name} · from {entry.registryTitle}
        </span>
        {entry.description && <span className="text-sm text-muted-foreground">{entry.description}</span>}
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
        disabled={entry.added || entry.needsKey || endpoint === undefined || busy}
        onClick={() => endpoint && onAdd(endpoint)}
      >
        {entry.added ? 'Added' : 'Add'}
      </Button>
    </li>
  )
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
  const [results, setResults] = useState<readonly CatalogEntry[]>()
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const text = query.trim()
    if (text.length < 2) return setResults(undefined)
    const controller = new AbortController()
    const timer = setTimeout(() => {
      void request(`/api/mcp/catalog?q=${encodeURIComponent(text)}`, { signal: controller.signal })
        .then((data) => setResults(decodeEntries(data)))
        .catch(() => undefined)
    }, 300)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [query])
  async function add(entry: CatalogEntry, endpoint: string): Promise<void> {
    setBusy(true)
    try {
      const source = { registry: entry.registry, name: entry.name, ...(entry.version && { version: entry.version }) }
      onChanged(await addAndConnect(endpoint, entry.title ?? entry.name, source))
    } catch (error) {
      onMessage(failureText(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Find a server</CardTitle>
        <CardDescription>
          Search the MCP Registry, GitHub's and any you add. Their listings are the publishers' own words.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-3">
          <Input
            type="search"
            aria-label="Search MCP registries"
            placeholder="notes, calendar, github…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {results?.length === 0 && (
            <p className="text-sm text-muted-foreground">No servers a Worker can reach match.</p>
          )}
          {results !== undefined && results.length > 0 && (
            <ul className="suggestions">
              {results.map((entry) => (
                <Result key={entry.name} entry={entry} busy={busy} onAdd={(endpoint) => void add(entry, endpoint)} />
              ))}
            </ul>
          )}
          <Registries onMessage={onMessage} />
        </div>
      </CardContent>
    </Card>
  )
}
