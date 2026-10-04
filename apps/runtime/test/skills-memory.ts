// In-memory skills state for unit tests, with the SQLite stores' semantics (src/skills/store.ts).
import type { Activation, DraftLog, DraftRecord, DraftStatus, SkillState } from '../src/skills/store.ts'

/** The skills state in memory, with the SQLite store's semantics. */
export class MemorySkillState implements SkillState {
  readonly #sources = new Set<string>()
  readonly #activations = new Map<string, Activation[]>()
  readonly files = new Map<string, Uint8Array>()
  enabled = (serverId: string) => this.#sources.has(serverId)
  sources = () => [...this.#sources]
  setEnabled(serverId: string, enabled: boolean) {
    if (enabled) this.#sources.add(serverId)
    else this.#sources.delete(serverId)
  }
  activation = (sessionId: string, serverId: string, uri: string) =>
    this.#activations.get(sessionId)?.find((item) => item.serverId === serverId && item.entry.uri === uri)
  activations = (sessionId: string) => this.#activations.get(sessionId) ?? []
  activate(sessionId: string, activation: Activation) {
    const kept = this.activations(sessionId).filter(
      (item) => !(item.serverId === activation.serverId && item.entry.uri === activation.entry.uri),
    )
    this.#activations.set(sessionId, [...kept, activation])
  }
  file = (digest: string) => this.files.get(digest)
  storeFile(digest: string, bytes: Uint8Array) {
    this.files.set(digest, bytes)
  }
}

/** The learner's draft records in memory. */
export class MemoryDraftLog implements DraftLog {
  readonly rows = new Map<string, DraftRecord & { readonly createdAt: number }>()
  countSince = (since: number) => [...this.rows.values()].filter((row) => row.createdAt >= since).length
  known = (contentHash: string) => this.rows.has(contentHash)
  blocked = (serverId: string, name: string, baseUri: string | undefined) =>
    [...this.rows.values()].some(
      (row) =>
        row.serverId === serverId &&
        row.name === name &&
        (row.status === 'open' || (row.status === 'rejected' && row.baseUri === baseUri)),
    )
  open = (limit: number) => [...this.rows.values()].filter((row) => row.status === 'open').slice(0, limit)
  add(record: DraftRecord, now: number) {
    this.rows.set(record.contentHash, { ...record, createdAt: now })
  }
  update(contentHash: string, change: { readonly draftId?: string; readonly status: DraftStatus }) {
    const row = this.rows.get(contentHash)
    if (row !== undefined) this.rows.set(contentHash, { ...row, ...change })
  }
  forget(contentHash: string) {
    this.rows.delete(contentHash)
  }
}
