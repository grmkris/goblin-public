// Skills from MCP servers, as the resident agent sees them. The catalog lists every skill of every server the owner
// uses skills from, each under a host-assigned handle (`<serverId>:<name>`) so two servers' skills never replace one
// another. Activation reads `SKILL.md` lazily, verifies it against the entry and records the entry for the
// conversation; supporting files are read only from that retained manifest. Nothing is fetched at wake.
import type { SkillRequestOptions as RequestOptions } from '../mcp/types.ts'
import * as Context from 'effect/Context'
import { NotFound, UpstreamMcp } from '../http/errors.ts'
import type { McpConnectionManager } from '../mcp/connection.ts'
import { promiseWith } from '../runtime/boundary.ts'
import type { SkillEntry } from './protocol.ts'
import type { Activation, SkillState } from './store.ts'
import { SkillVerifyError, contentBytes, fileAt, usableManifest, verifyBytes, verifySkillFile } from './verify.ts'

/** Runs a caller's skill-scope check (an Effect bound to its services) from this Promise code. */
const checked = promiseWith(Context.empty())

const DEFAULT_TTL_MS = 300_000
const MIN_TTL_MS = 30_000
const MAX_TTL_MS = 3_600_000

/** A skill as the model may name it. */
export type ListedSkill = {
  readonly handle: string
  readonly serverId: string
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
const listed = (serverId: string, entries: readonly SkillEntry[]): readonly ListedSkill[] => {
  const seen = new Map<string, number>()
  return entries
    .filter((entry) => entry.resources !== 'dynamic' && stringField(entry, 'name') !== '')
    .toSorted((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0))
    .map((entry) => {
      const name = stringField(entry, 'name')
      const count = (seen.get(name) ?? 0) + 1
      seen.set(name, count)
      return {
        handle: count === 1 ? `${serverId}:${name}` : `${serverId}:${name}~${count}`,
        serverId,
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

export class SkillLibrary {
  readonly #manager: McpConnectionManager
  readonly #state: SkillState
  readonly #now: () => number
  readonly #cache = new Map<string, Cached>()
  readonly #loading = new Map<string, Promise<readonly ListedSkill[]>>()

  constructor(manager: McpConnectionManager, state: SkillState, now: () => number) {
    this.#manager = manager
    this.#state = state
    this.#now = now
  }

  /** The servers the owner uses skills from and still has configured. */
  sources(): readonly string[] {
    const configured = new Set(this.#manager.servers.map((server) => server.serverId))
    return this.#state.sources().filter((serverId) => configured.has(serverId))
  }

  /** Turn skills from a server on or off; off also forgets its cached listing. */
  setEnabled(serverId: string, enabled: boolean): void {
    this.#manager.server(serverId)
    this.#state.setEnabled(serverId, enabled, this.#now())
    this.#cache.delete(serverId)
  }

  /** Persist invalidation before ack; retained activations keep their immutable manifest. */
  invalidate(serverId: string, unavailable = false): void {
    this.#state.dirtyCatalog?.(serverId, unavailable, this.#now())
    this.#cache.delete(serverId)
  }

  enabled(serverId: string): boolean {
    return this.#state.enabled(serverId)
  }

  /**
   * Every listed skill of every enabled server that `include` keeps (a conversation leaves out the libraries it switched
   * off, which are then not fetched). A server that cannot be reached keeps its last listing while one is cached; with
   * none it is reported unavailable, never as an empty library.
   */
  async catalog(options: RequestOptions = {}, include: (serverId: string) => boolean = () => true): Promise<Catalog> {
    const sources = this.sources().filter(include)
    const results = await Promise.all(
      sources.map(async (serverId) => {
        try {
          return { serverId, skills: await this.#listing(serverId, options) }
        } catch {
          // expected: an unreachable server keeps its last listing while one is cached, else it is named unavailable
          const candidate = this.#cache.get(serverId)
          const stale =
            candidate?.generation === (this.#state.catalogState?.(serverId).dirty ?? 0) ? candidate : undefined
          return stale === undefined ? { serverId, skills: undefined } : { serverId, skills: stale.skills }
        }
      }),
    )
    return {
      skills: results.flatMap((result) => result.skills ?? []),
      unavailable: results.filter((result) => result.skills === undefined).map((result) => result.serverId),
    }
  }

  async #listing(serverId: string, options: RequestOptions): Promise<readonly ListedSkill[]> {
    const cached = this.#cache.get(serverId)
    const generation = this.#state.catalogState?.(serverId).dirty ?? 0
    if (cached !== undefined && cached.generation === generation && cached.expiresAt > this.#now()) return cached.skills
    const pending = this.#loading.get(serverId)
    if (pending !== undefined) return pending
    const loading = this.#manager
      .listSkills(serverId, options)
      .then(({ skills, ttlMs }) => {
        const ttl = Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, ttlMs ?? DEFAULT_TTL_MS))
        if ((this.#state.catalogState?.(serverId).dirty ?? 0) !== generation)
          throw new UpstreamMcp({ serverId, reason: 'content-limit' })
        this.#state.refreshedCatalog?.(serverId, generation, this.#now())
        const entry = { generation, skills: listed(serverId, skills), expiresAt: this.#now() + ttl }
        this.#cache.set(serverId, entry)
        return entry.skills
      })
      .finally(() => this.#loading.delete(serverId))
    this.#loading.set(serverId, loading)
    return loading
  }

  async #find(handle: string, options: RequestOptions): Promise<ListedSkill> {
    const serverId = handle.slice(0, handle.indexOf(':'))
    if (serverId === '' || !this.sources().includes(serverId)) throw new NotFound({ what: `skill ${handle}` })
    const skill = (await this.#listing(serverId, options)).find((item) => item.handle === handle)
    if (skill === undefined) throw new NotFound({ what: `skill ${handle}` })
    return skill
  }

  /** Verified bytes of one manifest file: from the cache when it still matches, else from the serving server. */
  async #bytes(serverId: string, entry: SkillEntry, path: string, options: RequestOptions) {
    const file = fileAt(entry, path)
    const cached = this.#state.file(file.digest)
    if (cached !== undefined) {
      try {
        await verifyBytes(file, cached)
        return { bytes: cached, mimeType: undefined }
      } catch {
        // expected: a cached row that no longer matches is ignored and fetched again
      }
    }
    const result = await this.#manager.readSkillFile(serverId, file.uri, options)
    const content = result.contents.find((item) => item.uri === file.uri) ?? result.contents[0]
    if (content === undefined) throw new SkillVerifyError('size-mismatch')
    const bytes = contentBytes(content)
    await verifyBytes(file, bytes)
    this.#state.storeFile(file.digest, bytes, this.#now())
    return { bytes, mimeType: content.mimeType }
  }

  /**
   * Load a skill for a conversation: read and verify its `SKILL.md`, then record the entry it was loaded from. The
   * conversation keeps that entry for later file reads, so a new version applies only when it is activated again.
   */
  async activate(sessionId: string, handle: string, options: RequestOptions = {}): Promise<Activated> {
    const skill = await this.#find(handle, options)
    return this.#activate(sessionId, skill, options)
  }

  async #activate(sessionId: string, skill: ListedSkill, options: RequestOptions): Promise<Activated> {
    const files = usableManifest(skill.entry)
    const { bytes } = await this.#bytes(skill.serverId, skill.entry, 'SKILL.md', options)
    const { body } = verifySkillFile(skill.entry, new TextDecoder().decode(bytes))
    if (options.authorize !== undefined) await checked(options.authorize(skill.serverId))
    this.#state.activate(sessionId, { serverId: skill.serverId, entry: skill.entry, activatedAt: this.#now() })
    return {
      skill,
      body,
      files: files
        .filter((file) => file.uri !== skill.entry.uri)
        .map((file) => ({ path: relativePath(skill.entry, file.uri), size: file.size })),
    }
  }

  /** A browser selection pins identity by URI, even when names or duplicate handle numbers change. */
  async activateSelection(
    sessionId: string,
    serverId: string,
    uri: string,
    options: RequestOptions,
  ): Promise<Activated> {
    if (options.authorize !== undefined) await checked(options.authorize(serverId))
    if (!this.sources().includes(serverId)) throw new NotFound({ what: 'skill library' })
    const skill = (await this.#listing(serverId, options)).find((item) => item.entry.uri === uri)
    if (skill === undefined) throw new NotFound({ what: 'selected skill' })
    return this.#activate(sessionId, skill, options)
  }

  /** The conversation's newest activation of a skill, by its handle's server and name. */
  #activation(sessionId: string, handle: string): Activation {
    const colon = handle.indexOf(':')
    const serverId = handle.slice(0, colon)
    const name = handle.slice(colon + 1).replace(/~\d+$/u, '')
    const found = this.#state
      .activations(sessionId)
      .filter((item) => item.serverId === serverId && item.entry.frontmatter['name'] === name)
      .toSorted((a, b) => b.activatedAt - a.activatedAt)[0]
    if (found === undefined) throw new NotFound({ what: `activated skill ${handle}` })
    return found
  }

  /** A supporting file of a skill this conversation activated, verified against the retained manifest. */
  async read(sessionId: string, handle: string, path: string, options: RequestOptions = {}): Promise<SkillFile> {
    const activation = this.#activation(sessionId, handle)
    if (!this.#state.enabled(activation.serverId)) throw new NotFound({ what: `activated skill ${handle}` })
    const { bytes, mimeType } = await this.#bytes(activation.serverId, activation.entry, path, options)
    if (isText(mimeType, path)) return { kind: 'text', path, text: new TextDecoder().decode(bytes) }
    if (mimeType !== undefined && /^image\/(png|jpeg|gif|webp)$/u.test(mimeType))
      return {
        kind: 'image',
        path,
        data: btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')),
        mimeType,
      }
    return { kind: 'binary', path, size: bytes.byteLength, mimeType }
  }
}
