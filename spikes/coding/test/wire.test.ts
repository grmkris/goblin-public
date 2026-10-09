import { expect, test } from 'bun:test'
import { boundedJson, decodeRunnerInput } from '../scripts/wire.ts'

test('runner input limits files, source length, and exact snapshot identities', () => {
  const input = { base: 'a'.repeat(40), session: 'b'.repeat(64), revision: 'c'.repeat(64), changes: [] }
  expect(decodeRunnerInput(input)).toEqual(input)
  expect(() => decodeRunnerInput({ ...input, base: 'main' })).toThrow()
  expect(() =>
    decodeRunnerInput({ ...input, changes: Array.from({ length: 9 }, () => ['apps/cli/src/a.ts', '']) }),
  ).toThrow()
  expect(() => decodeRunnerInput({ ...input, changes: [['apps/cli/src/a.ts', 'x'.repeat(60_001)]] })).toThrow()
})

test('runner JSON bounds streamed bytes without Content-Length', async () => {
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('{"a":"'))
      controller.enqueue(encoder.encode('x'.repeat(100)))
      controller.enqueue(encoder.encode('"}'))
      controller.close()
    },
  })
  let error: unknown
  try {
    await boundedJson(new Response(body), 50)
  } catch (caught) {
    // expected: the test asserts on the failure it captures
    error = caught
  }
  expect(error).toBeInstanceOf(Error)
  expect(error instanceof Error ? error.message : String(error)).toBe('body_limit')
  expect(await boundedJson(Response.json({ good: true }))).toEqual({ good: true })
})
