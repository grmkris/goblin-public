import * as Schema from 'effect/Schema'
import { digest, editable, sourcePath, SpikeError } from '../overlay.ts'

export const RunnerKind = Schema.Literals(['native', 'docker', 'cloudflare'])
export type RunnerKind = typeof RunnerKind.Type
const Hex = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const Base = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u))
const Positive = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))
const Milliseconds = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
export const limits = {
  maxFiles: 8,
  maxBytes: 150_000,
  verifyTimeoutMs: 120_000,
  executeTimeoutMs: 30_000,
  maxOutputBytes: 20_000,
}
export const RunnerSessionSpec = Schema.Struct({
  taskId: Hex,
  base: Base,
  snapshot: Schema.String.check(Schema.isMinLength(1)),
  limits: Schema.Struct({
    maxFiles: Positive,
    maxBytes: Positive,
    verifyTimeoutMs: Positive,
    executeTimeoutMs: Positive,
    maxOutputBytes: Positive,
  }),
})
export type RunnerSessionSpec = typeof RunnerSessionSpec.Type
export const VerifyRequest = Schema.Struct({
  session: Hex,
  base: Base,
  revision: Hex,
  changes: Schema.Array(
    Schema.Tuple([Schema.String.check(Schema.isMaxLength(300)), Schema.String.check(Schema.isMaxLength(60_000))]),
  ).check(Schema.isMaxLength(8)),
})
export type VerifyRequest = typeof VerifyRequest.Type
export const Diagnostic = Schema.Struct({
  source: Schema.Literals(['typescript', 'effect', 'oxlint', 'oxfmt']),
  file: Schema.optional(Schema.String.check(Schema.isMaxLength(300))),
  code: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  message: Schema.String.check(Schema.isMaxLength(60_000)),
  line: Schema.optional(Positive),
  formattedContent: Schema.optional(Schema.String.check(Schema.isMaxLength(60_000))),
})
export const CheckReceipt = Schema.Struct({
  revision: Hex,
  passed: Schema.Boolean,
  diagnostics: Schema.Array(Diagnostic).check(Schema.isMaxLength(1000)),
  elapsedMs: Milliseconds,
  backend: RunnerKind,
  imageDigest: Schema.optional(Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/u))),
})
export type CheckReceipt = typeof CheckReceipt.Type
export const ExecuteRequest = Schema.Struct({
  session: Hex,
  base: Base,
  revision: Hex,
  profile: Schema.Literal('cli-hello'),
})
export type ExecuteRequest = typeof ExecuteRequest.Type
export const ExecutionReceipt = Schema.Struct({
  revision: Hex,
  profile: Schema.Literal('cli-hello'),
  exitCode: Schema.NullOr(Schema.Number.check(Schema.isInt())),
  stdout: Schema.String,
  stderr: Schema.String,
  elapsedMs: Milliseconds,
  backend: RunnerKind,
  imageDigest: Schema.optional(Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/u))),
})
export type ExecutionReceipt = typeof ExecutionReceipt.Type
export type RunnerErrorTag = 'provider-unavailable' | 'rejected-input' | 'stale-revision' | 'closed' | 'busy'
export class RunnerError extends SpikeError {
  constructor(readonly reason: RunnerErrorTag) {
    super(reason)
  }
}
export interface CodingRunnerLease {
  verify(request: VerifyRequest): Promise<CheckReceipt>
  /** Operator only; never registered as an MCP tool. */
  execute(request: ExecuteRequest): Promise<ExecutionReceipt>
  close(): Promise<void>
}
export interface CodingRunnerFactory {
  create(spec: RunnerSessionSpec): Promise<CodingRunnerLease>
}

export function validateRequest(spec: RunnerSessionSpec, value: VerifyRequest): VerifyRequest {
  let request: VerifyRequest
  try {
    request = Schema.decodeUnknownSync(VerifyRequest)(value, { onExcessProperty: 'error' })
    if (request.session !== spec.taskId || request.base !== spec.base) throw new RunnerError('rejected-input')
    const paths = new Set<string>()
    let bytes = 0
    for (const [file, content] of request.changes) {
      sourcePath(file)
      if (!editable(file) || paths.has(file) || content.includes('\0') || Buffer.byteLength(content) > 60_000)
        throw new RunnerError('rejected-input')
      paths.add(file)
      bytes += Buffer.byteLength(content)
    }
    if (paths.size > spec.limits.maxFiles || bytes > spec.limits.maxBytes) throw new RunnerError('rejected-input')
  } catch {
    throw new RunnerError('rejected-input')
  }
  if (
    request.revision !==
    digest(JSON.stringify([request.base, [...request.changes].toSorted(([a], [b]) => a.localeCompare(b))]))
  )
    throw new RunnerError('stale-revision')
  return request
}

export function validateCheck(value: unknown, revision: string): CheckReceipt {
  let result: CheckReceipt
  try {
    result = Schema.decodeUnknownSync(CheckReceipt)(value)
  } catch {
    throw new RunnerError('provider-unavailable')
  }
  if (result.revision !== revision || result.passed !== (result.diagnostics.length === 0))
    throw new RunnerError('provider-unavailable')
  return result
}
