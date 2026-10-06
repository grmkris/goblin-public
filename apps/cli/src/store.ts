import * as Schema from 'effect/Schema'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** One endpoint's sign-in: the client registered for it, the redirect it registered, and its tokens, as JSON. */
const Entry = Schema.Struct({
  redirectUri: Schema.optional(Schema.String),
  client: Schema.optional(Schema.Unknown),
  tokens: Schema.optional(Schema.Unknown),
})
export type Entry = typeof Entry.Type
const File = Schema.Record(Schema.String, Entry)
const decodeFile = Schema.decodeUnknownSync(Schema.fromJsonString(File))

/**
 * The CLI's credentials, one entry per endpoint URL, in a file only its owner can read (mode 600, directory 700).
 * Tokens never leave it except as the bearer of the endpoint they were issued for.
 */
export class CredentialStore {
  readonly #path: string

  constructor(path: string) {
    this.#path = path
  }

  async #all(): Promise<Record<string, Entry>> {
    const text = await readFile(this.#path, 'utf8').catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return '{}'
      throw error
    })
    return { ...decodeFile(text) }
  }

  async read(key: string): Promise<Entry> {
    return (await this.#all())[key] ?? {}
  }

  /** Merge `change` into the endpoint's entry. */
  async update(key: string, change: Entry): Promise<void> {
    const all = await this.#all()
    await this.#save({ ...all, [key]: { ...all[key], ...change } })
  }

  /** Drop some of the endpoint's entry: tokens the server refused, or a client it no longer knows. */
  async forget(key: string, fields: readonly ('client' | 'tokens')[]): Promise<void> {
    const all = await this.#all()
    const entry: Record<string, unknown> = { ...all[key] }
    for (const field of fields) delete entry[field]
    await this.#save({ ...all, [key]: Schema.decodeUnknownSync(Entry)(entry) })
  }

  async remove(key: string): Promise<void> {
    const { [key]: _removed, ...rest } = await this.#all()
    await this.#save(rest)
  }

  async #save(all: Record<string, Entry>): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 })
    await writeFile(this.#path, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 })
    // A file that existed before keeps its old mode through writeFile; make sure.
    await chmod(this.#path, 0o600)
  }

  /** Forget every sign-in (`goblin logout --all`). */
  async clear(): Promise<void> {
    await rm(this.#path, { force: true })
  }
}
