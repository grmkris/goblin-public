// Searching MCP registries that speak the generic registry API (`GET {base}/v0.1/servers?search=&limit=&cursor=`):
// the Official MCP Registry, GitHub's, and any the owner adds. Entries are publishers' claims, bounded and decoded;
// they label servers for the owner, never reach the model and grant nothing. Only remotes a Worker can use are kept.
// Redirects are not followed (`manual`; workerd has no `error` mode): a 3xx is not `ok`, so it reads as nothing.
import type { CatalogEntry, RegistryView } from '@goblin/contracts'
import type { FetchLike } from '@modelcontextprotocol/client'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { type AppError, InvalidInput, UpstreamMcp, attemptSync } from '../http/errors.ts'
import { logEvent } from '../observability/logger.ts'
import { safeErrorType } from '../observability/report.ts'
import { userEndpoint } from './endpoint.ts'
import { type AddedRegistries, MAX_ADDED_REGISTRIES } from './registries.ts'

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
/** How long one registry may take to answer a search or a probe. */
const REGISTRY_TIMEOUT = '8 seconds'

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

/** A registry's page that is not one: an error status, too large, not JSON or not the registry API's shape. */
const notARegistry = () => new InvalidInput({ reason: 'not_a_registry' })

/**
 * One page from a registry, read within its time limit. A request that gets no answer (the network, the limit) is
 * `UpstreamMcp` transport, named by the registry's host; an answer that is not a page of the registry API is
 * `not_a_registry`. Redirects are not followed, so a 3xx is not a page either.
 */
const readPage = (url: URL, fetcher: FetchLike) =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetcher(url, { redirect: 'manual', signal })
      return response.ok ? await response.text() : undefined
    },
    catch: () => new UpstreamMcp({ serverId: url.host, reason: 'transport' }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: REGISTRY_TIMEOUT,
      orElse: () => Effect.fail(new UpstreamMcp({ serverId: url.host, reason: 'transport' })),
    }),
    Effect.flatMap((body) => {
      if (body === undefined || body.length > MAX_PAGE_BYTES) return Effect.fail(notARegistry())
      return Effect.try({ try: (): unknown => JSON.parse(body), catch: notARegistry }).pipe(
        Effect.flatMap((json) =>
          Option.match(decodePage(json), { onNone: () => Effect.fail(notARegistry()), onSome: Effect.succeed }),
        ),
      )
    }),
  )

/** One registry's servers matching `query` that a Worker can use. */
export const searchRegistry = (registry: Registry, query: string, fetcher: FetchLike) => {
  const url = new URL('/v0.1/servers', registry.url)
  url.searchParams.set('limit', String(PAGE_LIMIT))
  if (query !== '') url.searchParams.set('search', query)
  return Effect.map(readPage(url, fetcher), (page) => page.servers.flatMap((raw) => catalogEntry(raw, registry) ?? []))
}

/** Check that `raw` is a registry speaking the generic API, and name it by its host. */
export const probeRegistry = (raw: string, fetcher: FetchLike): Effect.Effect<Registry, AppError> =>
  Effect.gen(function* () {
    const base = yield* attemptSync(() => userEndpoint(raw))
    yield* readPage(new URL('/v0.1/servers?limit=1', base.origin), fetcher)
    return { url: base.origin, title: base.hostname }
  })

/** A catalog search: every registry's matches, and whether any registry could not be searched (`partial`). */
export type CatalogSearch = { readonly entries: readonly Omit<CatalogEntry, 'added'>[]; readonly partial: boolean }

/** What the catalog reads: the owner's registries and how to reach them. */
export type CatalogPorts = { readonly added: AddedRegistries; readonly fetch: FetchLike }

/**
 * The registries the owner searches for servers (the built-in ones first, then the owner's) and the search over them,
 * the newest answers cached for ten minutes per query. One catalog per agent: the cache is its only state.
 */
export const makeCatalog = ({ added, fetch: fetcher }: CatalogPorts) => {
  const cache = new Map<string, { readonly at: number; readonly entries: CatalogSearch['entries'] }>()
  const registries = Effect.sync((): readonly RegistryView[] => [
    ...DEFAULT_REGISTRIES.map(({ url, title }) => ({ url, title, builtIn: true })),
    ...added.list().map(({ url, title }) => ({ url, title, builtIn: false })),
  ])
  /**
   * Every registry's matches, each server once: earlier registries (the official one first) win on name. A registry
   * that cannot be searched is logged and leaves the answer partial, which is not cached.
   */
  const search = Effect.fn('McpCatalog.search')(function* (query: string) {
    const searched = [...DEFAULT_REGISTRIES, ...added.list()]
    const key = JSON.stringify([query, searched.map((registry) => registry.url)])
    const now = yield* Clock.currentTimeMillis
    const cached = cache.get(key)
    if (cached !== undefined && now - cached.at < CACHE_MS) return { entries: cached.entries, partial: false }
    const pages = yield* Effect.forEach(
      searched,
      (registry) =>
        searchRegistry(registry, query, fetcher).pipe(
          Effect.tapError((error) =>
            logEvent('warn', 'failure', {
              where: 'mcp.catalog.search',
              'error.type': safeErrorType(error),
              code: error.reason,
            }),
          ),
          Effect.option,
        ),
      { concurrency: 'unbounded' },
    )
    const seen = new Set<string>()
    const entries = pages
      .flatMap((page) => Option.getOrElse(page, () => []))
      .filter((entry) => !seen.has(entry.name) && seen.add(entry.name))
    const partial = pages.some(Option.isNone)
    if (!partial) {
      if (cache.size > 50) cache.clear()
      cache.set(key, { at: now, entries })
    }
    return { entries, partial }
  })
  /** Adds a registry to search, once it answers the generic registry API. */
  const add = Effect.fn('McpCatalog.add')(function* (raw: string) {
    if (added.list().length >= MAX_ADDED_REGISTRIES) return yield* new InvalidInput({ reason: 'too_many_registries' })
    const registry = yield* probeRegistry(raw, fetcher)
    if ((yield* registries).some((item) => item.url === registry.url))
      return yield* new InvalidInput({ reason: 'already_added' })
    const now = yield* Clock.currentTimeMillis
    yield* attemptSync(() => added.add(registry, Math.floor(now / 1000)))
    return yield* registries
  })
  /** Stops searching a registry the owner added; the built-in ones stay, as do servers added from it. */
  const remove = Effect.fn('McpCatalog.remove')(function* (url: string) {
    if (!added.list().some((item) => item.url === url)) return yield* new InvalidInput({ reason: 'unknown_registry' })
    yield* attemptSync(() => added.remove(url))
    return yield* registries
  })
  return { registries, search, add, remove }
}
