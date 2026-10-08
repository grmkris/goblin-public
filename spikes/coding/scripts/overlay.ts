import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'

export class SpikeError extends Error {}

export const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
export const editable = (file: string): boolean =>
  /^apps\/cli\/(?:src|test)\/[\w/-]+\.ts$/u.test(file) && !file.split('/').includes('..')

export function sourcePath(file: string): string {
  if (path.isAbsolute(file) || file.includes('\\') || file.split('/').some((part) => part === '..' || part === '.'))
    throw new SpikeError('invalid_repo_path')
  return file
}

export type Check = {
  revision: string
  passed: boolean
  diagnostics: readonly unknown[]
  elapsedMs: number
}
export type Published = { url: string; number: number; commit: string }
export type Publication = { title: string; body: string; commit?: string | undefined }

/** One immutable baseline, with agent changes retained only in a bounded memory overlay. */
export class Overlay {
  readonly changes = new Map<string, string>()
  check: Check | undefined
  published: Published | undefined
  publication: Publication | undefined
  busy = false
  constructor(
    readonly base: string,
    readonly files: ReadonlyMap<string, string>,
    readonly id: string = randomUUID(),
  ) {}

  get revision(): string {
    return digest(JSON.stringify([this.base, [...this.changes].toSorted(([a], [b]) => a.localeCompare(b))]))
  }

  read(file: string): string {
    sourcePath(file)
    const value = this.changes.get(file) ?? this.files.get(file)
    if (value === undefined) throw new SpikeError('file_not_found')
    if (value.length > 100_000) throw new SpikeError('file_too_large')
    return value
  }

  edit(file: string, content: string, expectedRevision: string): string {
    sourcePath(file)
    if (!editable(file)) throw new SpikeError('path_outside_cli_spike')
    if (this.busy || this.published || this.publication) throw new SpikeError('session_frozen')
    if (expectedRevision !== this.revision) throw new SpikeError('stale_revision')
    if (content.length > 60_000 || content.includes('\0')) throw new SpikeError('content_limit')
    if (!this.changes.has(file) && this.changes.size >= 8) throw new SpikeError('file_count_limit')
    const next = new Map(this.changes).set(file, content)
    if ([...next.values()].reduce((sum, value) => sum + value.length, 0) > 150_000)
      throw new SpikeError('overlay_limit')
    if (this.files.get(file) === content) this.changes.delete(file)
    else this.changes.set(file, content)
    this.check = undefined
    return this.revision
  }

  assertReady(revision: string): void {
    if (revision !== this.revision) throw new SpikeError('stale_revision')
    if (this.changes.size === 0) throw new SpikeError('no_changes')
    if (!this.check?.passed || this.check.revision !== revision) throw new SpikeError('ready_required')
  }

  async exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.busy) throw new SpikeError('session_busy')
    this.busy = true
    try {
      return await work()
    } finally {
      this.busy = false
    }
  }
}
