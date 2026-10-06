import { Workspace } from '@cloudflare/shell'
import { InvalidInput, PayloadTooLarge } from '../http/errors.ts'
import { slugOf } from './names.ts'

const MIB = 1024 * 1024
/** One app's files (ADR 0022): text, 1 MiB a write, 64 MiB and 2,000 files in all. */
export const APP_FILE_LIMITS = { writeBytes: MIB, totalBytes: 64 * MIB, files: 2000 } as const

/** At most eight segments of letters, digits, spaces and `_ . ( ) -`, none of them only dots. */
const APP_FILE_PATH = /^(?:\/(?!\.+(?:\/|$))[\p{L}\p{N}_ .()-]{1,80}){1,8}$/u

const checked = (path: string): string => {
  if (!APP_FILE_PATH.test(path)) throw new InvalidInput({ reason: `file path ${path.slice(0, 100)}` })
  return path
}

/**
 * One app's own files: Shell's Workspace in the namespace `app_<name>` of the agent's SQLite, larger files in R2 under
 * the agent's prefix, so erasing the account erases them too.
 */
export class AppFiles {
  readonly #workspace: Workspace

  constructor(sql: SqlStorage, bucket: R2Bucket, owner: () => string, app: string) {
    this.#workspace = new Workspace({
      sql,
      namespace: `app_${slugOf(app)}`,
      r2: bucket,
      name: () => `agents/${owner()}`,
      inlineThreshold: 128 * 1024,
    })
  }

  async read(path: string): Promise<string | null> {
    return this.#workspace.readFile(checked(path))
  }

  async write(path: string, text: string): Promise<void> {
    const target = checked(path)
    const size = new TextEncoder().encode(text).byteLength
    if (size > APP_FILE_LIMITS.writeBytes) throw new PayloadTooLarge({ limit: APP_FILE_LIMITS.writeBytes })
    const [info, existing] = await Promise.all([this.#workspace.getWorkspaceInfo(), this.#workspace.stat(target)])
    const replaced = existing?.type === 'file' ? existing.size : 0
    if (info.totalBytes - replaced + size > APP_FILE_LIMITS.totalBytes)
      throw new PayloadTooLarge({ limit: APP_FILE_LIMITS.totalBytes })
    if (existing === null && info.fileCount >= APP_FILE_LIMITS.files)
      throw new InvalidInput({ reason: 'too many files' })
    await this.#workspace.writeFile(target, text, 'text/plain; charset=utf-8')
  }

  async list(dir: string): Promise<readonly { readonly path: string; readonly size: number }[]> {
    const root = dir === '/' ? '/' : checked(dir)
    return (await this.#workspace.readDir(root)).map((entry) => ({ path: entry.path, size: entry.size }))
  }

  async delete(path: string): Promise<boolean> {
    return this.#workspace.deleteFile(checked(path))
  }

  /** How many files the app keeps, and their bytes. */
  async size(): Promise<{ readonly count: number; readonly bytes: number }> {
    const info = await this.#workspace.getWorkspaceInfo()
    return { count: info.fileCount, bytes: info.totalBytes }
  }

  /** Deletes every file of the app, a large one's R2 object with it (the owner deleted the app). */
  async purge(): Promise<void> {
    for (const entry of await this.#workspace.readDir('/'))
      await this.#workspace.rm(entry.path, { recursive: true, force: true })
  }
}
