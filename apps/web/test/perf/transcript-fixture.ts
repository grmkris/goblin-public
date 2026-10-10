/**
 * A deterministic synthetic conversation for the performance harness: Pi entries as the snapshot carries them, and a
 * reply streamed as Pi batches. Shared by the runner (`../ui-perf.ts`, which serves the snapshot) and the page
 * (`transcript.tsx`, which plays the batches), so both sides agree on what the transcript holds.
 */

/** When the synthetic conversation starts (epoch ms); each turn is a minute after the last. */
const START = 1_760_000_000_000

const QUESTIONS = [
  'Can you compare the two hosting plans we looked at yesterday and say which one fits the side project?',
  'Summarise what changed in the release notes since the last version I installed.',
  'Write a small TypeScript helper that groups an array of records by a key.',
  'What is the difference between a Durable Object alarm and a Cron Trigger?',
  'Draft a short reply to the landlord about the heating repair next week.',
  'Plan a three-day trip to Ljubljana with one rainy-day option.',
]

const PROSE = [
  'Here is the short version first, then the detail you can skim if you want it.',
  'Both options work, but they trade cost against how much you have to look after yourself.',
  'I checked the notes you saved earlier and the numbers below come from those, not from memory.',
  'The main thing to watch is the limit on concurrent requests, which only bites under load.',
]

const CODE = [
  '```ts',
  'export function groupBy<T, K extends PropertyKey>(items: readonly T[], key: (item: T) => K): Record<K, T[]> {',
  '  const groups = {} as Record<K, T[]>',
  '  for (const item of items) (groups[key(item)] ??= []).push(item)',
  '  return groups',
  '}',
  '```',
].join('\n')

const TABLE = [
  '| Plan | Monthly | Requests | Notes |',
  '| --- | ---: | ---: | --- |',
  '| Starter | $5 | 10M | shared CPU, fine for a hobby project |',
  '| Standard | $25 | 50M | dedicated CPU, daily backups |',
  '| Business | $90 | 250M | support with a response-time promise |',
].join('\n')

const DIAGRAM = [
  '```mermaid',
  'flowchart LR',
  '  A[Request] --> B{Cached?}',
  '  B -- yes --> C[Reply]',
  '  B -- no --> D[Origin] --> C',
  '```',
].join('\n')

/** One assistant answer in Markdown, varied by turn so the transcript mixes prose, lists, code, tables and figures. */
function answer(turn: number): string {
  const prose = PROSE[turn % PROSE.length] ?? ''
  const list = [
    '- **First**, the part that matters most.',
    '- *Second*, a caveat with `inline code`.',
    '- Third, a [link](https://example.com/docs).',
  ].join('\n')
  const parts = [`### Turn ${turn + 1}`, prose, list]
  if (turn % 3 === 0) parts.push(CODE)
  if (turn % 3 === 1) parts.push(TABLE)
  if (turn % 12 === 5) parts.push(DIAGRAM)
  parts.push('> Quoted from the saved note, so you can check it against the source.', prose)
  return parts.join('\n\n')
}

type Entry = Record<string, unknown>
const user = (id: number, at: number, text: string): Entry => ({
  id,
  kind: 'pi.user',
  model: [{ role: 'user', content: text, timestamp: at }],
})
const assistant = (id: number, at: number, content: readonly Entry[]): Entry => ({
  id,
  kind: 'pi.assistant',
  model: [
    {
      role: 'assistant',
      content,
      timestamp: at,
      usage: { input: 900, output: 300, cacheRead: 0, cacheWrite: 0, totalTokens: 1200 },
    },
  ],
})
const toolResult = (id: number, at: number, call: string): Entry => ({
  id,
  kind: 'pi.toolResult',
  model: [
    {
      role: 'toolResult',
      toolCallId: call,
      toolName: 'web_fetch',
      isError: false,
      content: [{ type: 'text', text: `# Fetched page\n\n${PROSE.join(' ')}\n\n${TABLE}` }],
      timestamp: at,
    },
  ],
})

/** A conversation of at least `parts` transcript rows, with how many it has: every other turn calls a tool first. */
export function history(parts: number): { readonly entries: readonly Entry[]; readonly parts: number } {
  const entries: Entry[] = []
  let rows = 0
  let id = 1
  for (let turn = 0; rows < parts; turn += 1) {
    const at = START + turn * 60_000
    entries.push(user(id++, at, QUESTIONS[turn % QUESTIONS.length] ?? ''))
    if (turn % 2 === 1) {
      const call = `call-${turn}`
      const thinking = { type: 'thinking', thinking: 'The saved notes probably have this; fetch the page to be sure.' }
      const request = { type: 'toolCall', id: call, name: 'web_fetch', arguments: { url: 'https://example.com/plans' } }
      entries.push(assistant(id++, at + 1_000, [thinking, request]), toolResult(id++, at + 2_000, call))
      rows += 2 // the Thoughts and the tool card; the result folds into the card
    }
    entries.push(assistant(id++, at + 3_000, [{ type: 'text', text: answer(turn) }]))
    rows += 2 // the question and the answer
  }
  return { entries, parts: rows }
}

/** The snapshot the stream opens with: the whole history, nothing running. */
export const snapshot = (entries: readonly Entry[]) => ({ type: 'snapshot', entries, tools: [], inbox: [] })

/** The reply the Stream scenario plays: about 4,800 characters with every block kind, including a figure. */
export function streamedReply(): string {
  return Array.from({ length: 8 }, (_, turn) => answer(turn)).join('\n\n')
}

/** Characters per batch: pi-durable commits a partial at most every 100 ms; ~50 characters is a brisk model's pace. */
export const BATCH_CHARACTERS = 48
/** pi-durable's partial throttle (`PARTIAL_THROTTLE_MS`). */
export const BATCH_INTERVAL_MS = 100

/**
 * The batches of one owner turn and its streamed reply, as the runtime sends them: the owner's message, the run
 * starting, the reply growing a slice at a time, then its commit and the run's end.
 */
export function streamBatches(lastId: number): readonly (readonly Entry[])[] {
  const at = START + 10_000_000
  const question = user(lastId + 1, at, 'Pull it all together into one overview I can keep.')
  const reply = streamedReply()
  const batches: Entry[][] = [
    [{ type: 'entry_appended', entry: question }, { type: 'run_start' }],
    [{ type: 'message_start', message: { role: 'assistant', content: [], timestamp: at + 1_000 } }],
  ]
  for (let offset = 0; offset < reply.length; offset += BATCH_CHARACTERS)
    batches.push([
      {
        type: 'message_update',
        changes: [{ type: 'text_delta', contentIndex: 0, delta: reply.slice(offset, offset + BATCH_CHARACTERS) }],
      },
    ])
  const committed = assistant(lastId + 2, at + 1_000, [{ type: 'text', text: reply }])
  batches.push([{ type: 'message_end', entry: committed }, { type: 'run_end' }])
  return batches
}

/** What the page measured over one recorded stretch. */
export type Sample = {
  frames: number[]
  longTasks: number[]
  inputs: number[]
  commits: number
  commitMs: number
}
/** The page's controls (`transcript.tsx`), which the runner drives. */
export type PerfApi = {
  /** When the transcript first showed whole (ms since navigation). */
  ready?: number | undefined
  start(): void
  stop(): Sample
  /** Plays one owner turn and its streamed reply after entry `lastId`. */
  stream(lastId: number): Promise<void>
}
declare global {
  interface Window {
    readonly perf: PerfApi
  }
}
