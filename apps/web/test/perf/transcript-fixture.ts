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

/** One step of a scripted stream: a batch, how long the server stays quiet after it, and the dock's height from then on. */
export type Step = { readonly batch: readonly Entry[]; readonly wait: number; readonly dock?: string }
const step = (batch: readonly Entry[], wait = BATCH_INTERVAL_MS, dock?: string): Step => ({
  batch,
  wait,
  ...(dock !== undefined && { dock }),
})

/** The reply's text as `message_update` batches of one block, `BATCH_CHARACTERS` at a time. */
function textSteps(reply: string, contentIndex: number): Step[] {
  const steps: Step[] = []
  for (let offset = 0; offset < reply.length; offset += BATCH_CHARACTERS)
    steps.push(
      step([
        {
          type: 'message_update',
          changes: [{ type: 'text_delta', contentIndex, delta: reply.slice(offset, offset + BATCH_CHARACTERS) }],
        },
      ]),
    )
  return steps
}

/** Scenarios of one owner turn that the follow runner (`../ui-follow.ts`) plays against the real transcript. */
export const FOLLOW_SCENARIOS = ['reply', 'tools', 'long-first', 'dock', 'same-batch', 'resnapshot'] as const
export type FollowScenario = (typeof FOLLOW_SCENARIOS)[number]

/**
 * `reply`: the baseline, a streamed answer. `tools`: a slow provider, thinking, a tool that takes a while, then the
 * answer. `long-first`: the answer is already longer than the screen when its first batch arrives. `dock`: the
 * baseline while the composer grows (a queued message, an attachment) partway through. `same-batch`: the owner's turn
 * and more than a screen of its reply arrive together (a Telegram turn, a queued one starting). `resnapshot`: the tab
 * comes back from the background and the stream starts again from a snapshot that already holds the turn and a long
 * partial reply, which then keeps streaming.
 */
export function followSteps(scenario: FollowScenario, entries: readonly Entry[]): readonly Step[] {
  const lastId = entries.length
  const at = START + 10_000_000
  const question = user(lastId + 1, at, 'Pull it all together into one overview I can keep.')
  const opening = step([{ type: 'entry_appended', entry: question }, { type: 'run_start' }])
  const message = (when: number) => ({
    type: 'message_start',
    message: { role: 'assistant', content: [], timestamp: when },
  })
  const reply = streamedReply()
  const committed = (id: number, when: number) =>
    step([{ type: 'message_end', entry: assistant(id, when, [{ type: 'text', text: reply }]) }, { type: 'run_end' }])
  if (scenario === 'reply')
    return [opening, step([message(at + 1_000)]), ...textSteps(reply, 0), committed(lastId + 2, at + 1_000)]
  if (scenario === 'long-first')
    return [
      opening,
      step([
        message(at + 1_000),
        { type: 'message_update', changes: [{ type: 'text_delta', contentIndex: 0, delta: reply.slice(0, 2_400) }] },
      ]),
      ...textSteps(reply.slice(2_400), 0),
      committed(lastId + 2, at + 1_000),
    ]
  if (scenario === 'same-batch')
    return [
      step([
        { type: 'entry_appended', entry: question },
        { type: 'run_start' },
        message(at + 1_000),
        { type: 'message_update', changes: [{ type: 'text_delta', contentIndex: 0, delta: reply.slice(0, 2_400) }] },
      ]),
      ...textSteps(reply.slice(2_400), 0),
      committed(lastId + 2, at + 1_000),
    ]
  if (scenario === 'resnapshot')
    return [
      step([
        {
          type: 'snapshot',
          entries: [...entries, question],
          tools: [],
          inbox: [],
          run: {},
          generation: {
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: reply.slice(0, 2_400) }],
              timestamp: at + 1_000,
            },
          },
        },
      ]),
      ...textSteps(reply.slice(2_400), 0),
      committed(lastId + 2, at + 1_000),
    ]
  if (scenario === 'dock') {
    const steps = [opening, step([message(at + 1_000)]), ...textSteps(reply, 0)]
    const third = Math.floor(steps.length / 3)
    const grown = steps.map((one, index) => (index === third ? { ...one, dock: '11rem' } : one))
    return [...grown, committed(lastId + 2, at + 1_000)]
  }
  const call = 'call-follow'
  const thinking = 'The saved notes probably have this; fetch the page to be sure.'
  const request = { type: 'toolCall', id: call, name: 'web_fetch', arguments: { url: 'https://example.com/plans' } }
  const first = assistant(lastId + 2, at + 1_000, [{ type: 'thinking', thinking }, request])
  return [
    { ...opening, wait: 3_000 }, // the provider's quiet stretch before anything streams
    step([message(at + 1_000)]),
    step([
      {
        type: 'message_update',
        changes: [{ type: 'thinking_start', contentIndex: 0, block: { type: 'thinking', thinking: '' } }],
      },
    ]),
    step([{ type: 'message_update', changes: [{ type: 'thinking_delta', contentIndex: 0, delta: thinking }] }]),
    step([{ type: 'message_end', entry: first }]),
    step([{ type: 'tool_execution_start', toolCallId: call, toolName: 'web_fetch', args: request.arguments }], 1_500),
    step([{ type: 'tool_execution_end', toolCallId: call, entry: toolResult(lastId + 3, at + 2_500, call) }], 2_500),
    step([message(at + 3_000)]),
    ...textSteps(reply, 0),
    committed(lastId + 4, at + 3_000),
  ]
}

/** What the page saw of the scroller over one scripted turn (`transcript.tsx`). */
export type FollowReport = {
  readonly frames: number
  /** How far the newest row's bottom is below the clear area above the composer, at the worst frame (px; > 0 is hidden). */
  readonly hiddenMax: number
  /** The same, once the stream had finished and settled. */
  readonly hiddenFinal: number
  /** Whether the jump-to-end arrow was offered once it had settled. */
  readonly arrowFinal: boolean
  /** Frames in which the arrow was offered while the reply was still streaming. */
  readonly arrowFrames: number
  /** Frames where the viewport moved back up, and by how much at most (px). */
  readonly backFrames: number
  readonly backMax: number
  /** Rows that were already there and moved (not the newest), and the biggest move (px). */
  readonly shifts: number
  readonly shiftMax: number
  /** The tallest the reserved space under a pinned turn got (px). */
  readonly spacerMax: number
  /** What the scroller held at each of the first frames after the turn's first batch: the rows' ids and tops. */
  readonly trace: readonly string[]
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
  /** Plays a scripted turn while watching the scroller, and says what it saw. */
  follow(steps: readonly Step[]): Promise<FollowReport>
}
declare global {
  interface Window {
    readonly perf: PerfApi
  }
}
