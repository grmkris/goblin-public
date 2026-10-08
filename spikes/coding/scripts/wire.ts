import * as Schema from 'effect/Schema'

const Hex = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
export const RunnerInput = Schema.Struct({
  base: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
  session: Hex,
  revision: Hex,
  changes: Schema.Array(
    Schema.Tuple([Schema.String.check(Schema.isMaxLength(300)), Schema.String.check(Schema.isMaxLength(60_000))]),
  ).check(Schema.isMaxLength(8)),
})

export const RunnerResult = Schema.Struct({
  revision: Hex,
  passed: Schema.Boolean,
  diagnostics: Schema.Array(Schema.Unknown),
  elapsedMs: Schema.Number,
})

/** Bound actual bytes even when the peer omits or lies about Content-Length. */
export async function boundedText(response: Response | Request, limit = 500_000): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('missing_body')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.length
      if (size > limit) throw new Error('body_limit')
      chunks.push(part.value)
    }
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return new TextDecoder().decode(bytes)
}

export async function boundedJson(response: Response | Request, limit = 500_000): Promise<unknown> {
  return JSON.parse(await boundedText(response, limit))
}

export const decodeRunnerInput = Schema.decodeUnknownSync(RunnerInput)
export const decodeRunnerResult = Schema.decodeUnknownSync(RunnerResult)
