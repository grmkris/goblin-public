import { RpcTarget } from 'cloudflare:workers'
import type { AppFiles } from './files.ts'
import type { AppPowersApi } from './isolates.ts'
import { problemText } from './queue.ts'

/**
 * What an app's `prepare` may do, lent to its isolate as an RPC target for that one call: its own files, and a line in
 * its events. Every failure crosses back as a plain Error with its reason.
 */
export class AppPowers extends RpcTarget implements AppPowersApi {
  readonly #files: AppFiles
  readonly #log: (line: string) => void

  constructor(files: AppFiles, log: (line: string) => void) {
    super()
    this.#files = files
    this.#log = log
  }

  filesRead(path: string): Promise<string | null> {
    return plain(() => this.#files.read(path))
  }

  filesWrite(path: string, text: string): Promise<void> {
    return plain(() => this.#files.write(path, text))
  }

  filesList(dir: string): Promise<readonly { readonly path: string; readonly size: number }[]> {
    return plain(() => this.#files.list(dir))
  }

  filesDelete(path: string): Promise<boolean> {
    return plain(() => this.#files.delete(path))
  }

  async log(line: string): Promise<void> {
    this.#log(line.slice(0, 500))
  }
}

async function plain<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (cause) {
    throw new Error(problemText(cause), { cause })
  }
}
