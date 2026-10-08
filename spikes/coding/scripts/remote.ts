import { SpikeError, type Check, type Overlay } from './overlay.ts'
import type { CodingVerifier } from './tools.ts'
import { boundedJson, decodeRunnerResult } from './wire.ts'

/** Only the bounded source overlay crosses the runner boundary. GitHub and owner OAuth stay on the trusted host. */
export class RemoteVerifier implements CodingVerifier {
  constructor(
    readonly endpoint: string,
    readonly token: string,
    readonly overlay: Overlay,
  ) {
    if (new URL(endpoint).protocol !== 'https:') throw new SpikeError('runner_requires_https')
  }

  private async call(operation: 'verify' | 'close'): Promise<Response> {
    const url = new URL(`/${operation}`, this.endpoint)
    url.searchParams.set('job', this.overlay.id)
    return fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        base: this.overlay.base,
        session: this.overlay.id,
        revision: this.overlay.revision,
        changes: [...this.overlay.changes],
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(120_000),
    })
  }

  async ready(): Promise<Check> {
    const response = await this.call('verify')
    if (!response.ok) throw new SpikeError('remote_verifier_failed')
    const result = decodeRunnerResult(await boundedJson(response))
    if (result.revision !== this.overlay.revision || result.passed !== (result.diagnostics.length === 0))
      throw new SpikeError('invalid_remote_receipt')
    return result
  }

  async close(): Promise<void> {
    const response = await this.call('close')
    if (!response.ok) throw new SpikeError('remote_close_failed')
  }
}
