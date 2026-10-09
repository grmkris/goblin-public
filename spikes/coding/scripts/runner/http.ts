import { boundedJson, decodeRunnerResult } from '../wire.ts'
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
        await response.body?.cancel()
        if (response.status === 429) throw new RunnerError('busy')
        if (response.status === 400 || response.status === 413) throw new RunnerError('rejected-input')
        throw new RunnerError('provider-unavailable')
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
