import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Schema from 'effect/Schema'
import { expect, test, vi } from 'vitest'
import { readJson } from '../../src/http/body.ts'
import {
  GrantDenied,
  Internal,
  InvalidInput,
  PayloadTooLarge,
  attempt,
  attemptSync,
  isAppError,
  toAppError,
} from '../../src/http/errors.ts'

const SECRET = 'secret-value'
const parseLine = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

/** The JSON lines `write` sent to `console[method]`, which prints nothing meanwhile. */
const linesOf = (method: 'log' | 'warn' | 'error', write: () => void): unknown[] => {
  const spy = vi.spyOn(console, method).mockImplementation(() => undefined)
  try {
    write()
    return spy.mock.calls.map(([line]): unknown => (typeof line === 'string' ? parseLine(line) : line))
  } finally {
    spy.mockRestore()
  }
}

const chunked = (parts: readonly string[]): Request => {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part))
      controller.close()
    },
  })
  // Node's Request needs `duplex` for a stream body; workers-types does not declare it.
  const init = { method: 'POST', body, duplex: 'half' }
  return new Request('https://goblin.test/api/x', init)
}

test('a chunked body without content-length is still bounded', async () => {
  const request = chunked(['{"a":"', 'x'.repeat(40), '"}'])
  await expect(readJson(request, Schema.Unknown, 16)).rejects.toBeInstanceOf(PayloadTooLarge)
})

test('bodies decode through the schema; mismatches are InvalidInput', async () => {
  const schema = Schema.Struct({ input: Schema.String })
  await expect(readJson(chunked(['{"input":"hi"}']), schema)).resolves.toEqual({ input: 'hi' })
  await expect(readJson(chunked(['{"input":1}']), schema)).rejects.toBeInstanceOf(InvalidInput)
  await expect(readJson(chunked(['not json']), schema)).rejects.toBeInstanceOf(InvalidInput)
})

test('a typed failure passes through; anything else, stored data that does not decode included, is ours (H2)', () => {
  const known = new GrantDenied({ serverId: 'myplan', name: 'x' })
  expect(toAppError(known)).toBe(known)
  const Stored = Schema.Struct({ revision: Schema.Number })
  const decoded = Schema.decodeUnknownExit(Stored)({ revision: SECRET })
  let error: unknown
  const lines = linesOf('error', () => {
    if (Exit.isFailure(decoded)) error = toAppError(Cause.squash(decoded.cause))
  })
  expect(error).toBeInstanceOf(Internal)
  expect(lines).toHaveLength(1)
  expect(lines[0]).toMatchObject({ event: 'failure', where: 'http.toAppError', 'error.type': 'SchemaError' })
  expect(JSON.stringify(lines)).not.toContain(SECRET)
})

test('the failure line keeps the frames that name a location, even beside one that does not', () => {
  const cause = new TypeError(SECRET)
  cause.stack = [
    `TypeError: ${SECRET}`,
    '    at read (file:///worker.js:10:5)',
    '    at async Promise.all (index 0)',
    '    at serve (file:///worker.js:20:7)',
  ].join('\n')
  const lines = linesOf('error', () => toAppError(cause))
  expect(lines).toEqual([
    {
      level: 'error',
      event: 'failure',
      where: 'http.toAppError',
      'error.type': 'TypeError',
      frames: ['at read (file:///worker.js:10:5)', 'at serve (file:///worker.js:20:7)'],
      severity: 'Error',
    },
  ])
})

test('attempt and attemptSync keep a typed failure, and report anything else under `where` as Internal', async () => {
  const known = new GrantDenied({ serverId: 'myplan', name: 'x' })
  expect(isAppError(known)).toBe(true)
  expect(isAppError(new TypeError(SECRET))).toBe(false)
  expect(await Effect.runPromise(attempt(async () => 'value'))).toBe('value')
  expect(Effect.runSync(attemptSync(() => 'value'))).toBe('value')
  const rejected = await Effect.runPromiseExit(attempt(() => Promise.reject(known)))
  expect(rejected).toStrictEqual(Exit.fail(known))
  const thrown = Effect.runSyncExit(
    attemptSync(() => {
      throw known
    }),
  )
  expect(thrown).toStrictEqual(Exit.fail(known))
  let failure: Exit.Exit<never, unknown> | undefined
  const lines = linesOf('error', () => {
    failure = Effect.runSyncExit(
      attemptSync(() => {
        throw new TypeError(SECRET)
      }, 'files.read'),
    )
  })
  expect(failure !== undefined && Exit.isFailure(failure) && Cause.squash(failure.cause)).toBeInstanceOf(Internal)
  expect(lines).toHaveLength(1)
  expect(lines[0]).toMatchObject({ event: 'failure', where: 'files.read', 'error.type': 'TypeError' })
  expect(JSON.stringify(lines)).not.toContain(SECRET)
})
