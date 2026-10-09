import * as Schema from 'effect/Schema'
import {
  CheckReceipt,
  ExecuteRequest,
  ExecutionReceipt,
  RunnerError,
  RunnerSessionSpec,
  validateCheck,
  validateRequest,
  type CodingRunnerLease,
  type VerifyRequest,
} from './contract.ts'

/** Every backend shares admission, revision validation and terminal close semantics. */
export abstract class Lease implements CodingRunnerLease {
  private closed = false
  private busy = false
  private closing: Promise<void> | undefined
  protected checked: VerifyRequest | undefined
  constructor(readonly spec: RunnerSessionSpec) {
    Schema.decodeUnknownSync(RunnerSessionSpec)(spec)
  }
  protected abstract check(request: VerifyRequest): Promise<CheckReceipt>
  protected abstract run(request: ExecuteRequest, checked: VerifyRequest): Promise<ExecutionReceipt>
  protected abstract dispose(): Promise<void>

  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) throw new RunnerError('closed')
    if (this.busy) throw new RunnerError('busy')
    this.busy = true
    try {
      return await work()
    } finally {
      this.busy = false
    }
  }
  async verify(value: VerifyRequest): Promise<CheckReceipt> {
    return this.exclusive(async () => {
      this.checked = undefined
      try {
        const request = validateRequest(this.spec, value)
        const result = validateCheck(await this.check(request), request.revision)
        if (result.passed) this.checked = request
        return result
      } catch (error) {
        try {
          await this.close()
        } catch {
          // expected: a failed cleanup is marked on the original error, which is rethrown below
          if (error instanceof RunnerError) error.cleanupFailed = true
        }
        throw error
      }
    })
  }
  async execute(value: ExecuteRequest): Promise<ExecutionReceipt> {
    return this.exclusive(async () => {
      let request: ExecuteRequest
      try {
        request = Schema.decodeUnknownSync(ExecuteRequest)(value, { onExcessProperty: 'error' })
      } catch {
        throw new RunnerError('rejected-input')
      }
      if (request.session !== this.spec.taskId || request.base !== this.spec.base)
        throw new RunnerError('rejected-input')
      if (!this.checked || request.revision !== this.checked.revision) throw new RunnerError('stale-revision')
      const result = Schema.decodeUnknownSync(ExecutionReceipt)(await this.run(request, this.checked))
      if (
        result.revision !== request.revision ||
        result.profile !== request.profile ||
        Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > this.spec.limits.maxOutputBytes
      )
        throw new RunnerError('provider-unavailable')
      return result
    })
  }
  close(): Promise<void> {
    this.closed = true
    this.closing ??= this.dispose()
    return this.closing
  }
}
