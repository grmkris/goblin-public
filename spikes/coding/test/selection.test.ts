import { expect, test } from 'bun:test'
import * as Schema from 'effect/Schema'
import { digest } from '../scripts/overlay.ts'
import { limits, RunnerError, type CodingRunnerFactory, type RunnerSessionSpec } from '../scripts/runner/contract.ts'
import { HttpRunner } from '../scripts/runner/http.ts'
import { FallbackRunner, RunnerConfig } from '../scripts/runner/config.ts'

const spec: RunnerSessionSpec = { taskId: digest('fallback'), base: 'a'.repeat(40), snapshot: '/frozen', limits }
const request = {
  session: spec.taskId,
  base: spec.base,
  revision: digest(JSON.stringify([spec.base, []])),
  changes: [],
}
const green = { revision: request.revision, passed: true, diagnostics: [], elapsedMs: 1 }

test('selection config requires a credential reference and refuses raw tokens', () => {
  const cloudflare = {
    kind: 'cloudflare' as const,
    endpoint: 'https://runner.test',
    credentialRef: '.local/coding-cf-spike/runner.env',
  }
  expect(Schema.decodeUnknownSync(RunnerConfig)(cloudflare)).toEqual(cloudflare)
  expect(() =>
    Schema.decodeUnknownSync(RunnerConfig)({ ...cloudflare, token: 'forbidden' }, { onExcessProperty: 'error' }),
  ).toThrow()
})

test('provider failure retries one explicit alternate, then remains on it', async () => {
  let primaryCalls = 0
  let alternateCalls = 0
  const primary = new HttpRunner(async (operation) => {
    if (operation === 'close') return Response.json({ closed: true })
    primaryCalls++
    return new Response('provider_down', { status: 503 })
  })
  const alternate = new HttpRunner(async (operation) => {
    if (operation === 'close') return Response.json({ closed: true })
    alternateCalls++
    return Response.json(green)
  }, 'docker')
  const lease = await new FallbackRunner(primary, alternate).create(spec)
  expect((await lease.verify(request)).backend).toBe('docker')
  expect((await lease.verify(request)).passed).toBe(true)
  expect(primaryCalls).toBe(1)
  expect(alternateCalls).toBe(2)
  await lease.close()
})

test('code failure never changes backend and a failed alternate is not retried', async () => {
  let alternateCreates = 0
  const alternate: CodingRunnerFactory = {
    create: async () => {
      alternateCreates++
      throw new RunnerError('provider-unavailable')
    },
  }
  const codeFailure = new HttpRunner(async (operation) =>
    Response.json(
      operation === 'close'
        ? { closed: true }
        : { ...green, passed: false, diagnostics: [{ source: 'typescript', code: 2322, message: 'Type mismatch' }] },
    ),
  )
  const lease = await new FallbackRunner(codeFailure, alternate).create(spec)
  expect((await lease.verify(request)).passed).toBe(false)
  expect(alternateCreates).toBe(0)
  await lease.close()
  const unavailable: CodingRunnerFactory = {
    create: async () => {
      throw new RunnerError('provider-unavailable')
    },
  }
  let reason = ''
  try {
    await new FallbackRunner(unavailable, alternate).create(spec)
  } catch (error) {
    if (error instanceof RunnerError) reason = error.reason
  }
  expect(reason).toBe('provider-unavailable')
  expect(alternateCreates).toBe(1)
})
