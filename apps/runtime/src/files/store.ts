import { Workspace } from '@cloudflare/shell'
import { type FileEntry, type FileListing, FILE_LIMITS, FILE_PATH } from '@goblin/contracts'
import { Forbidden, InvalidInput, NotFound, PayloadTooLarge } from '../http/errors.ts'

/** Files larger than this live in R2; smaller ones stay in the agent's SQLite. */
const INLINE_BYTES = 128 * 1024

/** Who acts on a file: the owner reads and writes everything, the agent reads uploads and writes only under /agent. */
export type FileCaller = 'owner' | 'agent'

const AREAS = new Set(['/uploads', '/agent'])

/** `path` checked as a file path, or a refusal naming why. */
export function filePath(path: string): string {
  if (!FILE_PATH.test(path)) throw new InvalidInput({ reason: 'file path' })
  return path
}

/** `dir` checked as a listing root: an area itself or a path under one. */
export function fileDirectory(dir: string): string {
  return AREAS.has(dir) ? dir : filePath(dir)
}

/** Refuses a write by `caller` to `path`: the agent writes only what it owns, under /agent. */
export function mayWrite(caller: FileCaller, path: string): void {
  if (caller === 'agent' && !path.startsWith('/agent/')) throw new Forbidden({ reason: 'the agent writes only /agent' })
}

const entry = (info: {
  readonly path: string
  readonly name: string
  readonly type: string
  readonly size: number
  readonly mimeType: string
  readonly updatedAt: number
}): FileEntry => ({
  path: info.path,
  name: info.name,
  kind: info.type === 'directory' ? 'directory' : 'file',
  size: info.size,
  mimeType: info.mimeType,
  updatedAt: info.updatedAt,
})

/** A stream that errors as soon as more than `limit` bytes pass through it. */
function capped(stream: ReadableStream<Uint8Array>, limit: number): ReadableStream<Uint8Array> {
  let seen = 0
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength
        if (seen > limit) controller.error(new PayloadTooLarge({ limit }))
        else controller.enqueue(chunk)
      },
    }),
  )
}

/**
 * The owner's files: `@cloudflare/shell`'s Workspace over the agent's SQLite (its `cf_workspace_files` tables), with
 * files over 128 KiB in the stage's R2 bucket under `agents/<user>/`. Quotas are checked before every write.
 */
export class FileStore {
  readonly #workspace: Workspace
  readonly #bucket: R2Bucket
  readonly #owner: () => string

  constructor(sql: SqlStorage, bucket: R2Bucket, owner: () => string) {
    this.#bucket = bucket
    this.#owner = owner
    this.#workspace = new Workspace({
      sql,
      namespace: 'files',
      r2: bucket,
      name: () => `agents/${owner()}`,
      inlineThreshold: INLINE_BYTES,
    })
  }

  /** A directory's entries, newest first, and the storage in use. */
  async list(dir: string): Promise<FileListing> {
    const root = fileDirectory(dir)
    const entries = (await this.#workspace.readDir(root)).map(entry).toSorted((a, b) => b.updatedAt - a.updatedAt)
    return {
      entries,
      usedBytes: (await this.#workspace.getWorkspaceInfo()).totalBytes,
      limitBytes: FILE_LIMITS.totalBytes,
    }
  }

  async stat(path: string): Promise<FileEntry> {
    const info = await this.#workspace.stat(filePath(path))
    if (info === null || info.type !== 'file') throw new NotFound({ what: path })
    return entry(info)
  }

  /** A file's bytes as a stream, with its entry. */
  async read(path: string): Promise<{ readonly entry: FileEntry; readonly body: ReadableStream<Uint8Array> }> {
    const found = await this.stat(path)
    const body = await this.#workspace.readFileStream(found.path)
    if (body === null) throw new NotFound({ what: path })
    return { entry: found, body }
  }

  /** At most `maxBytes` of a file's text from byte `offset`, and where the next read would start (if there is more). */
  async text(
    path: string,
    offset: number,
    maxBytes: number,
  ): Promise<{ readonly entry: FileEntry; readonly text: string; readonly next?: number }> {
    const found = await this.stat(path)
    const bytes = await this.#workspace.readFileBytes(found.path)
    if (bytes === null) throw new NotFound({ what: path })
    const end = Math.min(bytes.byteLength, offset + maxBytes)
    const text = new TextDecoder().decode(bytes.subarray(offset, end))
    return { entry: found, text, ...(end < bytes.byteLength ? { next: end } : {}) }
  }

  /** Writes `body` (`size` bytes, as the request declared) to `path` once the quotas allow it. */
  async write(
    caller: FileCaller,
    path: string,
    body: string | Uint8Array | ReadableStream<Uint8Array>,
    mimeType: string,
    size: number,
  ): Promise<FileEntry> {
    const target = filePath(path)
    mayWrite(caller, target)
    await this.#admit(target, size)
    if (typeof body === 'string') await this.#workspace.writeFile(target, body, mimeType)
    else if (body instanceof Uint8Array) await this.#workspace.writeFileBytes(target, body, mimeType)
    else await this.#workspace.writeFileStream(target, capped(body, size), mimeType)
    return this.stat(target)
  }

  async remove(caller: FileCaller, path: string): Promise<void> {
    const target = filePath(path)
    mayWrite(caller, target)
    if (!(await this.#workspace.deleteFile(target))) throw new NotFound({ what: path })
  }

  /** Deletes every R2 object of this agent's files (account deletion); SQLite goes with the agent's storage. */
  async purge(): Promise<void> {
    const prefix = `agents/${this.#owner()}/`
    let cursor: string | undefined
    do {
      const page = await this.#bucket.list({ prefix, ...(cursor === undefined ? {} : { cursor }) })
      if (page.objects.length > 0) await this.#bucket.delete(page.objects.map((object) => object.key))
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor !== undefined)
  }

  async #admit(path: string, size: number): Promise<void> {
    if (!Number.isSafeInteger(size) || size < 0) throw new InvalidInput({ reason: 'file size' })
    if (size > FILE_LIMITS.fileBytes) throw new PayloadTooLarge({ limit: FILE_LIMITS.fileBytes })
    const [info, existing] = await Promise.all([this.#workspace.getWorkspaceInfo(), this.#workspace.stat(path)])
    const replaced = existing?.type === 'file' ? existing.size : 0
    if (info.totalBytes - replaced + size > FILE_LIMITS.totalBytes)
      throw new PayloadTooLarge({ limit: FILE_LIMITS.totalBytes })
    if (existing === null && info.fileCount >= FILE_LIMITS.files) throw new InvalidInput({ reason: 'too many files' })
  }
}
