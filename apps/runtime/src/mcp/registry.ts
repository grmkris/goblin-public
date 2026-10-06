// Searching MCP registries that speak the generic registry API (`GET {base}/v0.1/servers?search=&limit=&cursor=`):
// the Official MCP Registry, GitHub's, and any the owner adds. Entries are publishers' claims, bounded and decoded;
// they label servers for the owner, never reach the model and grant nothing. Only remotes a Worker can use are kept.
// Redirects are not followed (`manual`; workerd has no `error` mode): a 3xx is not `ok`, so it reads as nothing.
import type { CatalogEntry } from '@goblin/contracts'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { InvalidInput } from '../http/errors.ts'
import { userEndpoint } from './endpoint.ts'

export type Registry = { readonly url: string; readonly title: string; readonly official?: boolean }

/** Searched for every owner. The official registry verifies namespaces (DNS, HTTP or GitHub); GitHub's curates. */
export const DEFAULT_REGISTRIES: readonly Registry[] = [
  { url: 'https://registry.modelcontextprotocol.io', title: 'MCP Registry', official: true },
  { url: 'https://api.mcp.github.com', title: 'GitHub MCP Registry' },
]

const Text = (max: number) => Schema.String.check(Schema.isMaxLength(max))
const Remote = Schema.Struct({
  type: Text(64),
  url: Text(2048),
  headers: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Text(256),
        isRequired: Schema.optional(Schema.Boolean),
        isSecret: Schema.optional(Schema.Boolean),
      }),
    ),
  ),
})
const ServerJson = Schema.Struct({
  name: Text(256),
  title: Schema.optional(Text(256)),
  description: Schema.optional(Text(2000)),
  version: Schema.optional(Text(64)),
  websiteUrl: Schema.optional(Text(2048)),
  remotes: Schema.optional(Schema.Array(Remote)),
})
const Official = Schema.Struct({ status: Schema.optional(Text(32)), isLatest: Schema.optional(Schema.Boolean) })
const Entry = Schema.Struct({
  server: ServerJson,
  _meta: Schema.optional(Schema.Struct({ 'io.modelcontextprotocol.registry/official': Schema.optional(Official) })),
})
const Page = Schema.Struct({
  servers: Schema.Array(Schema.Unknown),
  metadata: Schema.optional(Schema.Struct({ nextCursor: Schema.optional(Text(512)) })),
})
const decodeEntry = Schema.decodeUnknownOption(Entry)
const decodePage = Schema.decodeUnknownOption(Page)

const MAX_PAGE_BYTES = 4 * 1024 * 1024
const PAGE_LIMIT = 20
const CACHE_MS = 10 * 60 * 1000

/** The template variables in a remote URL (`https://x/mcp/{workspaceId}`). */
const variablesOf = (url: string): string[] => [...url.matchAll(/\{([\w-]{1,64})\}/gu)].map((match) => match[1] ?? '')

/** A registry entry as the owner may add it, or nothing when no remote is usable from a Worker. */
export function catalogEntry(raw: unknown, registry: Registry): Omit<CatalogEntry, 'added'> | undefined {
  const entry = Option.getOrUndefined(decodeEntry(raw))
  if (entry === undefined) return undefined
  const official = entry._meta?.['io.modelcontextprotocol.registry/official']
  if (official?.isLatest === false || (official?.status !== undefined && official.status !== 'active')) return undefined
  const { server } = entry
  const remote = server.remotes?.find((item) => item.type === 'streamable-http' && item.url.startsWith('https://'))
  if (remote === undefined) return undefined
  const needsKey = (remote.headers ?? []).some((header) => header.isRequired === true && header.isSecret === true)
  return {
    registry: registry.url,
    registryTitle: registry.title,
    verified: registry.official === true,
    name: server.name,
    ...(server.title === undefined ? {} : { title: server.title }),
    ...(server.description === undefined ? {} : { description: server.description }),
    ...(server.version === undefined ? {} : { version: server.version }),
    endpoint: remote.url,
    variables: variablesOf(remote.url),
    needsKey,
  }
}

/** One page of one registry's search results; nothing when it is down, slow, too large or not a registry. */
async function searchOne(registry: Registry, query: string, fetcher: typeof fetch) {
  const url = new URL('/v0.1/servers', registry.url)
  url.searchParams.set('limit', String(PAGE_LIMIT))
  if (query !== '') url.searchParams.set('search', query)
  try {
    const response = await fetcher(url, { redirect: 'manual', signal: AbortSignal.timeout(8000) })
    if (!response.ok) return []
    const body = await response.text()
    if (body.length > MAX_PAGE_BYTES) return []
    const page = Option.getOrUndefined(decodePage(JSON.parse(body)))
    return (page?.servers ?? []).flatMap((raw) => catalogEntry(raw, registry) ?? [])
  } catch {
    return []
  }
}

/** Search registries, newest results cached for ten minutes per query in this agent's memory. */
export class RegistryCatalog {
  readonly #fetch: typeof fetch
  readonly #cache = new Map<string, { readonly at: number; readonly entries: readonly Omit<CatalogEntry, 'added'>[] }>()
  constructor(fetcher: typeof fetch) {
    this.#fetch = fetcher
  }

  /** Every registry's matches, each server once: earlier registries (the official one first) win on name. */
  async search(query: string, registries: readonly Registry[]): Promise<readonly Omit<CatalogEntry, 'added'>[]> {
    const key = JSON.stringify([query, registries.map((registry) => registry.url)])
    const cached = this.#cache.get(key)
    if (cached !== undefined && Date.now() - cached.at < CACHE_MS) return cached.entries
    const pages = await Promise.all(registries.map((registry) => searchOne(registry, query, this.#fetch)))
    const seen = new Set<string>()
    const entries = pages.flat().filter((entry) => !seen.has(entry.name) && seen.add(entry.name))
    if (this.#cache.size > 50) this.#cache.clear()
    this.#cache.set(key, { at: Date.now(), entries })
    return entries
  }

  /** Check that `url` is a registry speaking the generic API, and name it; InvalidInput otherwise. */
  async probe(url: string): Promise<Registry> {
    const base = userEndpoint(url)
    const probeUrl = new URL('/v0.1/servers?limit=1', base.origin)
    try {
      const response = await this.#fetch(probeUrl, { redirect: 'manual', signal: AbortSignal.timeout(8000) })
      const body = response.ok ? await response.text() : ''
      if (body.length <= MAX_PAGE_BYTES && Option.isSome(decodePage(JSON.parse(body))))
        return { url: base.origin, title: base.hostname }
    } catch {
      // Falls through to the refusal below.
    }
    throw new InvalidInput({ reason: 'not_a_registry' })
  }
}
