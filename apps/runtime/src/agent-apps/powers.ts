import { RpcTarget } from 'cloudflare:workers'
import { EGRESS_LIMITS, type EgressRequest, type EgressResponse } from './egress.ts'
import type { AppFiles } from './files.ts'
import type { AppPowersApi } from './isolates.ts'
import { AppCodeError, refusalOf } from './queue.ts'

/** What one `prepare` may reach, each checked when it is used (ADR 0021). */
export type PowerPorts = {
  readonly files: AppFiles
  readonly log: (line: string) => void
  /** A fetch to an approved host. */
  readonly fetch: (url: string, init: EgressRequest) => Promise<EgressResponse>
  /** One of the owner's MCP tools (`<server>/<tool>`), approved for the app and granted by the owner. */
  readonly tool: (tool: string, args: Record<string, unknown>) => Promise<unknown>
  /** One completion on the deployment's cheap model, within the app's daily tokens. */
  readonly llm: (prompt: string, options: { readonly system?: string; readonly maxTokens?: number }) => Promise<string>
  /** A Telegram message to the owner, within the app's daily notifications. */
  readonly notify: (text: string) => Promise<void>
  /** An action or view of another approved app: the state after the action, or the view's value. */
  readonly app: (target: string, member: string, input: unknown) => Promise<unknown>
}

const record = (json: string): Record<string, unknown> => {
  const value: unknown = JSON.parse(json)
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new AppCodeError('arguments must be an object')
  return Object.fromEntries(Object.entries(value))
}

/**
 * What an app's `prepare` may do, lent to its isolate as an RPC target for that one call: its own files, a line in its
 * events, and the powers the owner approved for it. Values cross as JSON text; every failure crosses back as an
 * `IsolateRefusal`, which the isolate reads as an Error with its reason.
 */
export class AppPowers extends RpcTarget implements AppPowersApi {
  readonly #ports: PowerPorts
  #fetches = 0

  constructor(ports: PowerPorts) {
    super()
    this.#ports = ports
  }

  filesRead(path: string): Promise<string | null> {
    return plain(() => this.#ports.files.read(path))
  }

  filesWrite(path: string, text: string): Promise<void> {
    return plain(() => this.#ports.files.write(path, text))
  }

  filesList(dir: string): Promise<readonly { readonly path: string; readonly size: number }[]> {
    return plain(() => this.#ports.files.list(dir))
  }

  filesDelete(path: string): Promise<boolean> {
    return plain(() => this.#ports.files.delete(path))
  }

  async log(line: string): Promise<void> {
    this.#ports.log(line.slice(0, 500))
  }

  fetch(url: string, init: EgressRequest): Promise<EgressResponse> {
    return plain(() => {
      this.#fetches += 1
      if (this.#fetches > EGRESS_LIMITS.requests)
        throw new AppCodeError(`fetch: at most ${EGRESS_LIMITS.requests} fetches in one prepare`)
      return this.#ports.fetch(url, init)
    })
  }

  toolsCall(tool: string, args: string): Promise<string> {
    return plain(async () => JSON.stringify((await this.#ports.tool(tool, record(args))) ?? null))
  }

  llmComplete(prompt: string, options: { readonly system?: string; readonly maxTokens?: number }): Promise<string> {
    return plain(() => this.#ports.llm(prompt, options))
  }

  notify(text: string): Promise<void> {
    return plain(() => this.#ports.notify(text))
  }

  appsCall(app: string, member: string, input: string): Promise<string> {
    return plain(async () => JSON.stringify((await this.#ports.app(app, member, JSON.parse(input))) ?? null))
  }
}

async function plain<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (cause) {
    throw refusalOf(cause)
  }
}
