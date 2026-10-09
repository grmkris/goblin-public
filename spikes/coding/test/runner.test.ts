import * as Schema from 'effect/Schema'
import { expect, test } from 'bun:test'
import { digest } from '../scripts/overlay.ts'
import { HttpLease, type Transport } from '../scripts/runner/http.ts'
import {
  ExecuteRequest,
  limits,
  validateRequest,
  type RunnerSessionSpec,
  type VerifyRequest,
} from '../scripts/runner/contract.ts'

const spec: RunnerSessionSpec = { taskId: digest('lease-test'), base: 'a'.repeat(40), snapshot: '/frozen', limits }
function input(changes: VerifyRequest['changes'] = []): VerifyRequest {
  return { session: spec.taskId, base: spec.base, revision: digest(JSON.stringify([spec.base, changes])), changes }
}
async function failure(work: Promise<unknown>): Promise<string> {
  try {
    await work
    return 'unexpected-success'
  } catch (error) {
    return error instanceof Error ? error.message : 'unexpected-error'
  }
}
const response = (request: VerifyRequest) => ({
  revision: request.revision,
  passed: true,
  diagnostics: [],
  elapsedMs: 1,
})

test('contract rejects cross-session, stale, malformed, duplicate and byte-oversized overlays', () => {
  const request = input([['apps/cli/src/probe.ts', 'export const probe = 1\n']])
  expect(validateRequest(spec, request)).toEqual(request)
  expect(() => validateRequest(spec, { ...request, session: digest('other') })).toThrow('rejected-input')
  expect(() => validateRequest(spec, { ...request, revision: digest('old') })).toThrow('stale-revision')
  const invalid: VerifyRequest['changes'][] = [
    [['../outside.ts', '']],
    [['apps/cli/src/probe.ts', '\0']],
    [['apps/cli/src/probe.ts', 'é'.repeat(30_001)]],
    [
      ['apps/cli/src/probe.ts', ''],
      ['apps/cli/src/probe.ts', ''],
    ],
  ]
  for (const changes of invalid) {
    expect(() => validateRequest(spec, { ...request, changes })).toThrow('rejected-input')
  }
  expect(() => validateRequest({ ...spec, limits: { ...limits, maxBytes: 10 } }, request)).toThrow('rejected-input')
})

test('HTTP lease preserves the wire, validates receipts, and closes idempotently', async () => {
  const calls: string[] = []
  const transport: Transport = async (operation, request) => {
    calls.push(operation)
    return Response.json(operation === 'verify' ? response(request) : { closed: true })
  }
  const lease = new HttpLease(spec, transport, 'cloudflare')
  const request = input()
  expect(await lease.verify(request)).toEqual({ ...response(request), backend: 'cloudflare' })
  await lease.close()
  await lease.close()
  expect(calls).toEqual(['verify', 'close'])
  expect(await failure(lease.verify(request))).toBe('closed')
})

test('invalid revision, diagnostic shape and pass bit cannot become a green receipt', async () => {
  for (const result of [
    { ...response(input()), revision: digest('wrong') },
    { ...response(input()), passed: false },
    { ...response(input()), diagnostics: [{ source: 'untrusted', message: 'bad' }] },
    { ...response(input()), diagnostics: [{ source: 'typescript', message: 'bad' }] },
  ]) {
    const lease = new HttpLease(spec, async () => Response.json(result), 'cloudflare')
    expect(await failure(lease.verify(input()))).toBe('provider-unavailable')
    expect(await failure(lease.verify(input()))).toBe('closed')
  }
})

test('one verification at a time and fixed execution only at the checked revision', async () => {
  let finish: (() => void) | undefined
  const pending = new Promise<void>((resolve) => {
    finish = resolve
  })
  const lease = new HttpLease(
    spec,
    async (operation, request) => {
      if (operation === 'verify') {
        await pending
        return Response.json(response(request))
      }
      return Response.json({ revision: request.revision, exitCode: 0, stdout: 'Hello, world!\n', stderr: '' })
    },
    'docker',
  )
  const checking = lease.verify(input())
  expect(await failure(lease.verify(input()))).toBe('busy')
  finish?.()
  await checking
  const execute = { session: spec.taskId, base: spec.base, revision: input().revision, profile: 'cli-hello' as const }
  expect(await failure(lease.execute({ ...execute, revision: digest('old') }))).toBe('stale-revision')
  expect(() => Schema.decodeUnknownSync(ExecuteRequest)({ ...execute, profile: 'shell' })).toThrow()
  expect((await lease.execute(execute)).stdout).toBe('Hello, world!\n')
  await lease.close()
})
