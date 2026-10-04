import * as Schema from 'effect/Schema'
import { expect, test } from 'vitest'
import { readJson } from '../../src/http/body.ts'
import { BudgetExhausted, GrantDenied, InvalidInput, PayloadTooLarge, UpstreamMcp } from '../../src/http/errors.ts'
import { failureResponse, statusOf } from '../../src/http/respond.ts'

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
  return new Request('https://purrable.test/api/x', init)
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

test('each failure maps to one status; unknown causes become a bodiless 500', async () => {
  expect(statusOf(new GrantDenied({ serverId: 'myplan', name: 'x' }))).toBe(403)
  expect(statusOf(new UpstreamMcp({ serverId: 'myplan', reason: 'timeout' }))).toBe(504)
  expect(statusOf(new BudgetExhausted({ limit: 1000, resetsAt: 86_400 }))).toBe(429)
  const response = failureResponse(new Error('token=secret-value'), '/api/x', 'req-1')
  expect(response.status).toBe(500)
  const body = JSON.stringify(await response.json())
  expect(body).toBe('{"error":"Internal","reason":"unexpected"}')
  expect(response.headers.get('cache-control')).toBe('no-store')
})
