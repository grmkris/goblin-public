import { boundedJson, boundedText, decodeRunnerResult } from '../wire.ts'
import * as Schema from 'effect/Schema'
import {
  ExecutionReceipt,
  validateCheck,
  RunnerError,
  type CheckReceipt,
  type CodingRunnerFactory,
  type ExecuteRequest,
  type RunnerKind,
  type RunnerSessionSpec,
  type VerifyRequest,
} from './contract.ts'
import { Lease } from './lease.ts'

export type Transport = (
  operation: 'verify' | 'execute' | 'close',
  input: VerifyRequest,
  timeoutMs: number,
) => Promise<Response>
export function httpsTransport(endpoint: string, token: string): Transport {
  const origin = new URL(endpoint)
  if (origin.protocol !== 'https:' || origin.username || origin.password) throw new RunnerError('rejected-input')
  return (operation, input, timeoutMs) => {
    const url = new URL(`/${operation}`, origin)
    url.searchParams.set('job', input.session)
    return fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    })
  }
}
async function responseFailure(response: Response): Promise<RunnerError> {
  if (response.status === 429) {
    await response.body?.cancel()
    return new RunnerError('busy')
  }
  if (response.status === 413) {
    await response.body?.cancel()
    return new RunnerError('rejected-input')
  }
  const body = await boundedText(response, 1024)
  let name = body
  try {
    name = Schema.decodeUnknownSync(Schema.Struct({ error: Schema.String }))(JSON.parse(body)).error
  } catch {
    /* Workers can return fixed plaintext rejection tags. */
  }
  if (name === 'revision_mismatch' || name === 'stale-revision') return new RunnerError('stale-revision')
  const rejected = [
    'invalid_input',
    'invalid_job',
    'session_mismatch',
    'snapshot_mismatch',
    'content_limit',
    'overlay_limit',
    'file_count_limit',
    'invalid_repo_path',
    'path_outside_cli_spike',
    'rejected-input',
  ]
  return new RunnerError(rejected.includes(name) ? 'rejected-input' : 'provider-unavailable')
}
export class HttpLease extends Lease {
  private latest: VerifyRequest
  constructor(
    spec: RunnerSessionSpec,
    readonly transport: Transport,
    readonly backend: RunnerKind,
    readonly imageDigest?: string,
  ) {
    super(spec)
    this.latest = { session: spec.taskId, base: spec.base, revision: '0'.repeat(64), changes: [] }
  }
  private async call(
    operation: 'verify' | 'execute' | 'close',
    input: VerifyRequest,
    timeoutMs: number,
  ): Promise<unknown> {
    try {
      const response = await this.transport(operation, input, timeoutMs)
      if (!response.ok) {
        const failure = await responseFailure(response)
        console.error(JSON.stringify({ runner: this.backend, status: response.status, error: failure.reason }))
        throw failure
      }
      return await boundedJson(response, operation === 'execute' ? this.spec.limits.maxOutputBytes + 2000 : 500_000)
    } catch (error) {
      if (error instanceof RunnerError) throw error
      throw new RunnerError('provider-unavailable')
    }
  }
  protected async check(request: VerifyRequest): Promise<CheckReceipt> {
    this.latest = request
    const result = decodeRunnerResult(await this.call('verify', request, this.spec.limits.verifyTimeoutMs))
    return validateCheck(
      { ...result, backend: this.backend, ...(this.imageDigest ? { imageDigest: this.imageDigest } : {}) },
      request.revision,
    )
  }
  protected async run(request: ExecuteRequest, checked: VerifyRequest): Promise<typeof ExecutionReceipt.Type> {
    const start = performance.now()
    const result = await this.call('execute', checked, this.spec.limits.executeTimeoutMs)
    if (typeof result !== 'object' || result === null) throw new RunnerError('provider-unavailable')
    return Schema.decodeUnknownSync(ExecutionReceipt)({
      ...result,
      profile: request.profile,
      elapsedMs: Math.round(performance.now() - start),
      backend: this.backend,
      ...(this.imageDigest ? { imageDigest: this.imageDigest } : {}),
    })
  }
  protected async dispose(): Promise<void> {
    await this.call('close', this.latest, 15_000)
  }
}
export class HttpRunner implements CodingRunnerFactory {
  constructor(
    readonly transport: Transport,
    readonly backend: RunnerKind = 'cloudflare',
    readonly imageDigest?: string,
  ) {}
  async create(spec: RunnerSessionSpec): Promise<HttpLease> {
    return new HttpLease(spec, this.transport, this.backend, this.imageDigest)
  }
}
