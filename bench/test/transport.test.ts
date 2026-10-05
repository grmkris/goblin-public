import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from 'vitest'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import { clampMaxTokensToContext } from '@earendil-works/pi-ai/api/simple-options'
import { requestPayload, transportModel } from '../src/transport.ts'
import type { Model } from '@earendil-works/pi-ai'

const ledger = resolve(import.meta.dirname, '../../.local/bench/runs/real-claude-canary-01/attempts.jsonl')
// The optional regression reuses the observed failed API request rather than manufacturing a large conversation.
test.skipIf(!existsSync(ledger))(
  'actual live writer request retains its output room with independent transport capacity',
  () => {
    const rows: { attempt: number; request: string }[] = readFileSync(ledger, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const row = rows.find((item) => item.attempt === 3)
    if (row === undefined) throw new Error('Missing observed clipped request')
    const request: { model: string; messages: { role: string; content: string }[] } = JSON.parse(row.request)
    const model: Model<'openai-completions'> = {
      id: request.model,
      provider: 'bench',
      name: request.model,
      api: 'openai-completions',
      baseUrl: 'http://127.0.0.1:18873/v1',
      input: ['text'],
      reasoning: false,
      contextWindow: 8192,
      maxTokens: 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }
    const context = normalizeContext({
      messages: request.messages.map((message) => ({ role: 'user', content: message.content, timestamp: 0 })),
    })
    expect(clampMaxTokensToContext(model, context, 2448)).toBe(1)
    expect(clampMaxTokensToContext(transportModel(model, new Map([[model.id, 131_072]])), context, 2448)).toBe(2448)
    const payload = JSON.parse(requestPayload(request, 'disabled'))
    expect(payload.enable_thinking).toBe(false)
    expect(payload.thinking).toEqual({ type: 'disabled' })
  },
)
