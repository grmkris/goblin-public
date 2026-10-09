import { Overlay } from '../overlay.ts'
import { Verifier } from '../verifier.ts'
import { bounded } from '../lsp.ts'
import {
  validateCheck,
  RunnerError,
  type CodingRunnerFactory,
  type ExecuteRequest,
  type ExecutionReceipt,
  type RunnerSessionSpec,
  type VerifyRequest,
} from './contract.ts'
import { Lease } from './lease.ts'

export class NativeLease extends Lease {
  readonly overlay: Overlay
  readonly verifier: Verifier
  constructor(spec: RunnerSessionSpec, files: ReadonlyMap<string, string>, binaries: { type: string; effect: string }) {
    super(spec)
    this.overlay = new Overlay(spec.base, files, spec.taskId)
    this.verifier = new Verifier(spec.snapshot, this.overlay, binaries.effect, binaries.type)
  }
  protected async check(request: VerifyRequest) {
    this.overlay.changes.clear()
    for (const [file, content] of request.changes) this.overlay.edit(file, content, this.overlay.revision)
    if (this.overlay.revision !== request.revision) throw new RunnerError('stale-revision')
    try {
      return validateCheck(
        { ...(await bounded(this.verifier.ready(), this.spec.limits.verifyTimeoutMs)), backend: 'native' },
        request.revision,
      )
    } catch {
      throw new RunnerError('provider-unavailable')
    }
  }
  protected async run(_request: ExecuteRequest, _checked: VerifyRequest): Promise<ExecutionReceipt> {
    throw new RunnerError('provider-unavailable')
  }
  protected dispose(): Promise<void> {
    return this.verifier.close()
  }
}
export class NativeRunner implements CodingRunnerFactory {
  constructor(
    readonly files: ReadonlyMap<string, string>,
    readonly binaries: { type: string; effect: string },
  ) {}
  async create(spec: RunnerSessionSpec): Promise<NativeLease> {
    return new NativeLease(spec, this.files, this.binaries)
  }
}
