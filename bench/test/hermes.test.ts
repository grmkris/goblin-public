import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from 'vitest'
import { importHermes } from '../src/hermes.ts'
import { sourceCheckpoints } from '../src/import.ts'
import { redactor } from '../scripts/redaction.ts'

const row = (id: number, role: string, content: string | null) => ({
  id,
  role,
  content,
  tool_call_id: null,
  tool_calls: null,
  tool_name: null,
  timestamp: 100 + id,
  finish_reason: null,
  display_kind: null,
  active: 0,
  compacted: 1,
})
const source = (messages: readonly unknown[]) =>
  JSON.stringify({
    schemaVersion: 1,
    sessionHash: 'source',
    source: 'telegram',
    chatType: 'dm',
    startedAt: 100,
    endedAt: 200,
    parentSessionHash: null,
    privateIdentifiers: ['471780984'],
    messages,
  })

test('Hermes restores compacted originals, preserves parallel tool pairs, and excludes hidden/meta records', () => {
  const calls = [
    { id: 'a', type: 'function', function: { name: 'inspect', arguments: '{"owner":"471780984"}' } },
    { id: 'b', type: 'function', function: { name: 'inspect', arguments: '{}' } },
  ]
  const messages = [
    row(1, 'user', 'Owner 471780984'),
    { ...row(2, 'assistant', null), tool_calls: JSON.stringify(calls) },
    { ...row(3, 'tool', 'Failure'), tool_call_id: 'a', tool_name: 'inspect', finish_reason: 'error' },
    { ...row(4, 'tool', 'Success'), tool_call_id: 'b', tool_name: 'inspect' },
    row(5, 'session_meta', 'generated compression summary'),
    { ...row(6, 'assistant', 'hidden reasoning'), display_kind: 'hidden' },
    row(7, 'assistant', 'Done'),
  ]
  const imported = importHermes(source(messages), redactor([], ['471780984']).redact)
  expect(imported.events.map((e) => e.kind)).toEqual([
    'user',
    'tool-call',
    'tool-call',
    'tool-result',
    'tool-result',
    'assistant',
  ])
  expect(imported.events[3]?.isError).toBe(true)
  expect(imported.events[0]?.timestamp).toBe(101000)
  expect(JSON.stringify(imported.events)).not.toContain('471780984')
  expect(JSON.stringify(imported.events)).not.toContain('compression summary')
  expect(sourceCheckpoints(imported.events, [1])[0]?.cutoff).toBe(5)
  expect(() => importHermes(source(messages.slice(0, 3)), (text) => text)).toThrow('unmatched tool calls')
  expect(() => importHermes(source([row(2, 'user', 'first'), row(1, 'assistant', 'second')]), (text) => text)).toThrow(
    'ascending',
  )
})

const path = resolve(import.meta.dirname, '../../.local/bench/corpora/hermes-overnight/source.json')
test.skipIf(!existsSync(path))(
  'frozen real Hermes DM supports natural 32k/64k checkpoints without replay inflation',
  () => {
    const imported = importHermes(readFileSync(path, 'utf8'), redactor([]).redact)
    expect(imported.lines).toBe(225)
    expect(imported.omissions.some((item) => item.reason.includes('compression replay'))).toBe(true)
    expect(sourceCheckpoints(imported.events, [32000, 64000])).toHaveLength(2)
  },
)

test('compression copies retain the full original result and a repeated user turn remains a new event', () => {
  const call = JSON.stringify([{ id: 'a', type: 'function', function: { name: 'inspect', arguments: '{}' } }])
  const messages = [
    row(1, 'user', 'inspect'),
    { ...row(2, 'assistant', null), tool_calls: call },
    { ...row(3, 'tool', 'full original output'), tool_call_id: 'a' },
    row(4, 'assistant', 'Done'),
    { ...row(5, 'user', 'inspect'), active: 1, compacted: 0, timestamp: 101 },
    { ...row(6, 'assistant', null), tool_calls: call, active: 1, compacted: 0 },
    { ...row(7, 'tool', '[compressed output]'), tool_call_id: 'a', active: 1, compacted: 0 },
    { ...row(8, 'assistant', 'Done'), active: 1, compacted: 0 },
    { ...row(9, 'user', 'inspect'), active: 1, compacted: 0 },
  ]
  const imported = importHermes(source(messages), (text) => text)
  expect(imported.events.map((e) => e.text)).toEqual(['inspect', '{}', 'full original output', 'Done', 'inspect'])
  expect(imported.omissions.filter((e) => e.reason.includes('replay copy'))).toHaveLength(4)
})
