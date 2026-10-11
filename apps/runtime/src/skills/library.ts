// Skills from MCP servers, as the resident agent sees them. The catalog lists every skill of every server the owner
// uses skills from, each under a host-assigned handle (`<connectionId>:<name>`) so two servers' skills never replace one
// another. Activation reads `SKILL.md` lazily, verifies it against the entry and records the entry for the
// conversation; supporting files are read only from that retained manifest. Nothing is fetched at wake.
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import { type AppError, NotFound, UpstreamMcp, attempt, attemptSync } from '../http/errors.ts'
import { McpConnections } from '../mcp/service.ts'
import type { SkillRequestOptions as RequestOptions } from '../mcp/types.ts'
import { SingleFlight } from '../observability/single-flight.ts'
import type { SkillEntry } from './protocol.ts'
import { Skills } from './service.ts'
import type { Activation, SkillState } from './store.ts'
import { SkillVerifyError, contentBytes, fileAt, usableManifest, verifyBytes, verifySkillFile } from './verify.ts'

const DEFAULT_TTL_MS = 300_000
const MIN_TTL_MS = 30_000
const MAX_TTL_MS = 3_600_000

/** A skill as the model may name it. */
export type ListedSkill = {
  readonly handle: string
  readonly connectionId: string
  readonly name: string
  readonly description: string
  readonly entry: SkillEntry
}

export type Catalog = { readonly skills: readonly ListedSkill[]; readonly unavailable: readonly string[] }

/** A verified file: text for the model, or what it is when it is not text. */
export type SkillFile =
  | { readonly kind: 'text'; readonly path: string; readonly text: string }
  | { readonly kind: 'image'; readonly path: string; readonly data: string; readonly mimeType: string }
  | { readonly kind: 'binary'; readonly path: string; readonly size: number; readonly mimeType: string | undefined }

export type Activated = {
  readonly skill: ListedSkill
  readonly body: string
  /** Supporting files the skill may read, relative to its root, with sizes. */
  readonly files: readonly { readonly path: string; readonly size: number }[]
}

type Cached = { readonly generation: number; readonly skills: readonly ListedSkill[]; readonly expiresAt: number }

const stringField = (entry: SkillEntry, key: string): string => {
  const value = entry.frontmatter[key]
  return typeof value === 'string' ? value : ''
}

/** Handles for one server's skills: `<server>:<name>`, numbered when a server lists one name twice. */
const listed = (connectionId: string, entries: readonly SkillEntry[]): readonly ListedSkill[] => {
  const seen = new Map<string, number>()
  return entries
    .filter((entry) => entry.resources !== 'dynamic' && stringField(entry, 'name') !== '')
    .toSorted((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0))
    .map((entry) => {
      const name = stringField(entry, 'name')
      const count = (seen.get(name) ?? 0) + 1
      seen.set(name, count)
      return {
        handle: count === 1 ? `${connectionId}:${name}` : `${connectionId}:${name}~${count}`,
        connectionId,
        name,
        description: stringField(entry, 'description'),
        entry,
      }
    })
}

const relativePath = (entry: SkillEntry, uri: string): string => uri.slice(entry.uri.length - 'SKILL.md'.length)

const isText = (mimeType: string | undefined, path: string): boolean =>
  (mimeType ?? '').startsWith('text/') ||
  /json|yaml|xml|javascript|typescript|x-sh|x-python|toml/u.test(mimeType ?? '') ||
  /\.(md|txt|json|ya?ml|toml|csv|tsv|js|mjs|ts|tsx|py|sh|bash|rb|go|rs|html|css|sql|xml)$/iu.test(path)

/** What the library's steps share: the skills state, the connections, the flights and each server's listing. */
type Library = {
  readonly state: SkillState
  readonly connections: McpConnections['Service']
  readonly flights: SingleFlight['Service']
  readonly cache: Map<string, Cached>
}

const generationOf = (library: Library, connectionId: string) => library.state.catalogState?.(connectionId).dirty ?? 0

/** The servers the owner uses skills from and still has configured. */
const sourcesOf = (library: Library) =>
  Effect.map(library.connections.servers(), (servers) => {
    const configured = new Set(servers.map((server) => server.connectionId))
    return library.state.sources().filter((connectionId) => configured.has(connectionId))
  })

const load = (library: Library, connectionId: string, generation: number, options: RequestOptions) =>
  Effect.gen(function* () {
    const { skills, ttlMs } = yield* library.connections.skills(connectionId, options)
    const ttl = Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, ttlMs ?? DEFAULT_TTL_MS))
    if (generationOf(library, connectionId) !== generation)
      return yield* new UpstreamMcp({ connectionId, reason: 'content-limit' })
    const now = yield* Clock.currentTimeMillis
    const entry = { generation, skills: listed(connectionId, skills), expiresAt: now + ttl }
    yield* Effect.sync(() => {
      library.state.refreshedCatalog?.(connectionId, generation, now)
      library.cache.set(connectionId, entry)
    })
    return entry.skills
  })

/** A server's listing: cached while fresh and of the current generation, else one load joined by every caller. */
const listingOf = (
  library: Library,
  connectionId: string,
  options: RequestOptions,
): Effect.Effect<readonly ListedSkill[], AppError> =>
  Effect.gen(function* () {
    const cached = library.cache.get(connectionId)
    const generation = generationOf(library, connectionId)
    const now = yield* Clock.currentTimeMillis
    if (cached !== undefined && cached.generation === generation && cached.expiresAt > now) return cached.skills
    return yield* library.flights.run(
      `skills.listing:${connectionId}`,
      load(library, connectionId, generation, options),
    )
  })

/**
 * Every listed skill of every enabled server that `include` keeps (a conversation leaves out the libraries it switched
 * off, which are then not fetched). A server that cannot be reached keeps its last listing while one is cached; with
 * none it is reported unavailable, never as an empty library.
 */
const catalogOf = (library: Library, options: RequestOptions, include: (connectionId: string) => boolean) =>
  Effect.gen(function* () {
    const results = yield* Effect.forEach(
      (yield* sourcesOf(library)).filter(include),
      (connectionId) =>
        listingOf(library, connectionId, options).pipe(
          Effect.map((skills): { connectionId: string; skills: readonly ListedSkill[] | undefined } => ({
            connectionId,
            skills,
          })),
          // expected: an unreachable server keeps its last listing while one is cached, else it is named unavailable
          Effect.catch(() =>
            Effect.sync(() => {
              const candidate = library.cache.get(connectionId)
              const current = candidate?.generation === generationOf(library, connectionId)
              return { connectionId, skills: current ? candidate?.skills : undefined }
            }),
          ),
        ),
      { concurrency: 'unbounded' },
    )
    return {
      skills: results.flatMap((result) => result.skills ?? []),
      unavailable: results.filter((result) => result.skills === undefined).map((result) => result.connectionId),
    } satisfies Catalog
  })

const find = (library: Library, handle: string, options: RequestOptions) =>
  Effect.gen(function* () {
    const connectionId = handle.slice(0, handle.indexOf(':'))
    if (connectionId === '' || !(yield* sourcesOf(library)).includes(connectionId))
      return yield* new NotFound({ what: `skill ${handle}` })
    const skill = (yield* listingOf(library, connectionId, options)).find((item) => item.handle === handle)
    if (skill === undefined) return yield* new NotFound({ what: `skill ${handle}` })
    return skill
  })

/** Verified bytes of one manifest file: from the cache when it still matches, else from the serving server. */
const bytesOf = (library: Library, connectionId: string, entry: SkillEntry, path: string, options: RequestOptions) =>
  Effect.gen(function* () {
    const file = yield* attemptSync(() => fileAt(entry, path))
    const cached = library.state.file(file.digest)
    if (cached !== undefined) {
      const fresh = yield* Effect.tryPromise(() => verifyBytes(file, cached)).pipe(
        Effect.as(true),
        // expected: a cached row that no longer matches is ignored and fetched again
        Effect.catch(() => Effect.succeed(false)),
      )
      if (fresh) return { bytes: cached, mimeType: undefined }
    }
    const result = yield* library.connections.skillFile(connectionId, file.uri, options)
    const content = result.contents.find((item) => item.uri === file.uri) ?? result.contents[0]
    const bytes = yield* attemptSync(() => {
      if (content === undefined) throw new SkillVerifyError('size-mismatch')
      return contentBytes(content)
    })
    yield* attempt(() => verifyBytes(file, bytes))
    const now = yield* Clock.currentTimeMillis
    yield* Effect.sync(() => library.state.storeFile(file.digest, bytes, now))
    return { bytes, mimeType: content?.mimeType }
  })

/**
 * Loads a skill for a conversation: reads and verifies its `SKILL.md`, then records the entry it was loaded from. The
 * conversation keeps that entry for later file reads, so a new version applies only when it is activated again.
 */
const activateSkill = (library: Library, sessionId: string, skill: ListedSkill, options: RequestOptions) =>
  Effect.gen(function* () {
    const files = yield* attemptSync(() => usableManifest(skill.entry))
    const { bytes } = yield* bytesOf(library, skill.connectionId, skill.entry, 'SKILL.md', options)
    const { body } = yield* attemptSync(() => verifySkillFile(skill.entry, new TextDecoder().decode(bytes)))
    if (options.authorize !== undefined)
      yield* options.authorize(skill.connectionId, { name: skill.name, uri: skill.entry.uri })
    const activatedAt = yield* Clock.currentTimeMillis
    yield* Effect.sync(() =>
      library.state.activate(sessionId, { connectionId: skill.connectionId, entry: skill.entry, activatedAt }),
    )
    return {
      skill,
      body,
      files: files
        .filter((file) => file.uri !== skill.entry.uri)
        .map((file) => ({ path: relativePath(skill.entry, file.uri), size: file.size })),
    } satisfies Activated
  })

/** A browser selection pins identity by URI, even when names or duplicate handle numbers change. */
const selected = (library: Library, sessionId: string, connectionId: string, uri: string, options: RequestOptions) =>
  Effect.gen(function* () {
    if (options.authorize !== undefined) yield* options.authorize(connectionId)
    if (!(yield* sourcesOf(library)).includes(connectionId)) return yield* new NotFound({ what: 'skill library' })
    const skill = (yield* listingOf(library, connectionId, options)).find((item) => item.entry.uri === uri)
    if (skill === undefined) return yield* new NotFound({ what: 'selected skill' })
    // activateSkill asks about this one skill before it is recorded.
    return yield* activateSkill(library, sessionId, skill, options)
  })

/** The conversation's newest activation of a skill, by its handle's server and name. */
const activationOf = (state: SkillState, sessionId: string, handle: string): Effect.Effect<Activation, AppError> =>
  Effect.suspend(() => {
    const colon = handle.indexOf(':')
    const connectionId = handle.slice(0, colon)
    const name = handle.slice(colon + 1).replace(/~\d+$/u, '')
    const found = state
      .activations(sessionId)
      .filter((item) => item.connectionId === connectionId && item.entry.frontmatter['name'] === name)
      .toSorted((a, b) => b.activatedAt - a.activatedAt)[0]
    return found === undefined
      ? Effect.fail(new NotFound({ what: `activated skill ${handle}` }))
      : Effect.succeed(found)
  })

/** A supporting file of a skill this conversation activated, verified against the retained manifest. */
const readFile = (library: Library, sessionId: string, handle: string, path: string, options: RequestOptions) =>
  Effect.gen(function* () {
    const found = yield* activationOf(library.state, sessionId, handle)
    if (!library.state.enabled(found.connectionId)) return yield* new NotFound({ what: `activated skill ${handle}` })
    // Asked before any byte is read, from the cache or the server: a skill the setup no longer holds reads nothing.
    const name = found.entry.frontmatter['name']
    if (options.authorize !== undefined)
      yield* options.authorize(found.connectionId, { name: typeof name === 'string' ? name : '', uri: found.entry.uri })
    const { bytes, mimeType } = yield* bytesOf(library, found.connectionId, found.entry, path, options)
    if (isText(mimeType, path)) return { kind: 'text', path, text: new TextDecoder().decode(bytes) } satisfies SkillFile
    if (mimeType !== undefined && /^image\/(png|jpeg|gif|webp)$/u.test(mimeType))
      return {
        kind: 'image',
        path,
        data: btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')),
        mimeType,
      } satisfies SkillFile
    return { kind: 'binary', path, size: bytes.byteLength, mimeType } satisfies SkillFile
  })

/**
 * The agent's skills over its MCP connections and the skills state in its database. A server's listing is cached for
 * its `ttlMs`, until the server says it changed; loading one is one flight per server (`skills.listing:<server>`). A
 * content check that fails is an `Internal` failure, reported where it is taken.
 */
export const makeSkills = Effect.fnUntraced(function* (state: SkillState) {
  const library: Library = {
    state,
    connections: yield* McpConnections,
    flights: yield* SingleFlight,
    cache: new Map(),
  }
  return Skills.of({
    sources: Effect.fn('Skills.sources')(function* () {
      return yield* sourcesOf(library)
    }),
    enabled: Effect.fn('Skills.enabled')(function* (connectionId: string) {
      return yield* Effect.sync(() => state.enabled(connectionId))
    }),
    /** Turns skills from a server on or off; off also forgets its cached listing. */
    setEnabled: Effect.fn('Skills.setEnabled')(function* (connectionId: string, enabled: boolean) {
      yield* library.connections.server(connectionId)
      const now = yield* Clock.currentTimeMillis
      yield* Effect.sync(() => {
        state.setEnabled(connectionId, enabled, now)
        library.cache.delete(connectionId)
      })
    }),
    /** Persists the invalidation before the delivery is acknowledged; activations keep their immutable manifest. */
    invalidate: Effect.fn('Skills.invalidate')(function* (connectionId: string, unavailable = false) {
      const now = yield* Clock.currentTimeMillis
      yield* Effect.sync(() => {
        state.dirtyCatalog?.(connectionId, unavailable, now)
        library.cache.delete(connectionId)
      })
    }),
    catalog: Effect.fn('Skills.catalog')(function* (
      options: RequestOptions = {},
      include: (connectionId: string) => boolean = () => true,
    ) {
      return yield* catalogOf(library, options, include)
    }),
    activate: Effect.fn('Skills.activate')(function* (sessionId: string, handle: string, options: RequestOptions = {}) {
      return yield* activateSkill(library, sessionId, yield* find(library, handle, options), options)
    }),
    activateSelection: Effect.fn('Skills.activateSelection')(function* (
      sessionId: string,
      connectionId: string,
      uri: string,
      options: RequestOptions,
    ) {
      return yield* selected(library, sessionId, connectionId, uri, options)
    }),
    read: Effect.fn('Skills.read')(function* (
      sessionId: string,
      handle: string,
      path: string,
      options: RequestOptions = {},
    ) {
      return yield* readFile(library, sessionId, handle, path, options)
    }),
  })
})
