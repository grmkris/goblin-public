import { Profiler, useEffect, useMemo } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AppHost } from '../../src/components/apps/host.tsx'
import { Conversation } from '../../src/components/conversation.tsx'
import { AppsIn } from '../../src/components/parts/mcp-tool-part.tsx'
import type { ChatThreads } from '../../src/components/shell/thread-summary.tsx'
import { useConversation, useTranscript } from '../../src/components/use-conversation.ts'
import { WorkspaceFeedProvider } from '../../src/components/workspace-feed.tsx'
import { type Navigation, NavigationContext } from '../../src/lib/navigation.ts'
import { groupWork } from '../../src/lib/work-groups.ts'
import {
  BATCH_INTERVAL_MS,
  type FollowReport,
  type PerfApi,
  type Sample,
  type Step,
  streamBatches,
} from './transcript-fixture.ts'
import '../../src/styles.css'

/** What the page measures, read by the runner (`../ui-perf.ts`) through `window.perf`. */
const sample: Sample = { frames: [], longTasks: [], inputs: [], commits: 0, commitMs: 0 }
let recording = false
let lastFrame = 0
function frame(now: number) {
  if (recording && lastFrame > 0) sample.frames.push(now - lastFrame)
  lastFrame = now
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
new PerformanceObserver((list) => {
  if (recording) for (const entry of list.getEntries()) sample.longTasks.push(entry.duration)
}).observe({ type: 'longtask' })
new PerformanceObserver((list) => {
  if (recording) for (const entry of list.getEntries()) sample.inputs.push(entry.duration)
}).observe({ type: 'event', durationThreshold: 16 })

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The scroller as one frame shows it: where the rows are, how far the newest is hidden, and what is on offer. */
function look() {
  const viewport = document.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]')
  const content = viewport?.firstElementChild
  if (!(viewport instanceof HTMLElement) || !(content instanceof HTMLElement)) return undefined
  const rows = [...document.querySelectorAll<HTMLElement>('[data-message-id]')]
  const last = rows.at(-1)?.getBoundingClientRect()
  const box = viewport.getBoundingClientRect()
  const clear = box.bottom - Number.parseFloat(getComputedStyle(content).paddingBottom)
  const newest = rows.at(-1)
  return {
    newestId: newest?.dataset.messageId ?? '',
    newestHeight: last?.height ?? 0,
    top: viewport.scrollTop,
    hidden: last === undefined ? 0 : last.bottom - clear,
    arrow: (viewport.parentElement?.getAttribute('data-scrollable') ?? '').split(' ').includes('end'),
    spacer: document.querySelector<HTMLElement>('[data-message-scroller-spacer]')?.offsetHeight ?? 0,
    visible: rows
      .filter((row) => {
        const rect = row.getBoundingClientRect()
        return rect.bottom > box.top && rect.top < box.bottom
      })
      .map((row) => [row.dataset.messageId ?? '', row.getBoundingClientRect().top + viewport.scrollTop] as const),
  }
}

type Look = NonNullable<ReturnType<typeof look>>
/** What the watcher adds up over a turn; `FollowReport` is its settled form. */
type Tally = {
  frames: number
  hiddenMax: number
  arrowFrames: number
  backFrames: number
  backMax: number
  shifts: number
  shiftMax: number
  spacerMax: number
  trace: string[]
}
const TRACE_LIMIT = 400

/** Where the gap between two neighbouring rows that are on screen in both frames changed, and by how much (px). */
function gapChanges(previous: Look, now: Look): { readonly id: string; readonly change: number }[] {
  const was = new Map(previous.visible)
  return now.visible.flatMap(([id, top], index) => {
    const next = now.visible[index + 1]
    const before = was.get(id)
    const nextBefore = next === undefined ? undefined : was.get(next[0])
    if (next === undefined || before === undefined || nextBefore === undefined) return []
    const change = next[1] - top - (nextBefore - before)
    return Math.abs(change) > 1 ? [{ id, change }] : []
  })
}

/** Adds one frame to the tally: what the scroller offered, and what moved since the last frame. */
function tallyFrame(tally: Tally, previous: Look | undefined, now: Look, streaming: boolean): void {
  tally.frames += 1
  tally.hiddenMax = Math.max(tally.hiddenMax, now.hidden)
  tally.spacerMax = Math.max(tally.spacerMax, now.spacer)
  if (now.arrow && streaming) tally.arrowFrames += 1
  if (previous === undefined) return
  const back = previous.top - now.top
  if (back > 2) {
    tally.backFrames += 1
    tally.backMax = Math.max(tally.backMax, back)
  }
  // A visible jump: the gap between two rows that are both on screen changed. Rows above the screen changing height are
  // not one; the scroller keeps the screen where it was.
  for (const { id, change } of gapChanges(previous, now)) {
    tally.shifts += 1
    tally.shiftMax = Math.max(tally.shiftMax, Math.abs(change))
    tally.trace.push(`f${tally.frames} row ${id} is ${Math.round(change)}px taller on screen`)
  }
  const shrank = now.newestId === previous.newestId && previous.newestHeight - now.newestHeight > 20
  if (shrank)
    tally.trace.push(
      `f${tally.frames} newest ${now.newestId} shrank ${Math.round(previous.newestHeight)}→${Math.round(now.newestHeight)}`,
    )
  if (back > 2 || now.arrow !== previous.arrow)
    tally.trace.push(
      `f${tally.frames} top ${Math.round(previous.top)}→${Math.round(now.top)} arrow ${now.arrow} spacer ${now.spacer}`,
    )
  tally.trace.length = Math.min(tally.trace.length, TRACE_LIMIT)
}

/** Plays `steps` and watches every frame; the scroller's own state is read from the DOM, as a person would see it. */
async function follow(steps: readonly Step[]): Promise<FollowReport> {
  const tally: Tally = {
    frames: 0,
    hiddenMax: Number.NEGATIVE_INFINITY,
    arrowFrames: 0,
    backFrames: 0,
    backMax: 0,
    shifts: 0,
    shiftMax: 0,
    spacerMax: 0,
    trace: [],
  }
  let watching = true
  let streaming = true
  let previous = look()
  const watch = () => {
    const now = look()
    if (now !== undefined) {
      tallyFrame(tally, previous, now, streaming)
      previous = now
    }
    if (watching) requestAnimationFrame(watch)
  }
  requestAnimationFrame(watch)
  for (const { batch, wait, dock } of steps) {
    if (dock !== undefined) document.documentElement.style.setProperty('--dock-height', dock)
    window.dispatchEvent(new MessageEvent('fixture-batch', { data: JSON.stringify(batch) }))
    await sleep(wait)
  }
  streaming = false
  await nextFrame()
  await sleep(500)
  const settled = look()
  watching = false
  const items = [...document.querySelectorAll<HTMLElement>('[data-message-id]')]
  const turnStart = items.findLastIndex((item) => item.dataset.scrollAnchor === 'true')
  return {
    ...tally,
    turnRows: turnStart < 0 ? 0 : items.length - turnStart,
    hiddenMax: Math.round(tally.hiddenMax),
    hiddenFinal: Math.round(settled?.hidden ?? 0),
    arrowFinal: settled?.arrow ?? false,
    backMax: Math.round(tally.backMax),
    shiftMax: Math.round(tally.shiftMax),
  }
}
const perf: PerfApi = {
  start() {
    Object.assign(sample, { frames: [], longTasks: [], inputs: [], commits: 0, commitMs: 0 })
    lastFrame = 0
    recording = true
  },
  stop(): Sample {
    recording = false
    return structuredClone(sample)
  },
  /** At pi-durable's pace. */
  async stream(lastId: number) {
    for (const batch of streamBatches(lastId)) {
      window.dispatchEvent(new MessageEvent('fixture-batch', { data: JSON.stringify(batch) }))
      await new Promise((resolve) => setTimeout(resolve, BATCH_INTERVAL_MS))
    }
    await nextFrame()
  },
  follow,
}
Object.defineProperty(window, 'perf', { value: perf })

/** The shell's navigation, which nothing in a transcript of plain parts uses. */
const navigation: Navigation = {
  isAppPage: () => false,
  openApp: () => undefined,
  closeAppPage: () => undefined,
  focusApp: () => undefined,
  newThreadWith: () => undefined,
}

/** The transcript as `ChatView` composes it, without the dock: the real stream hooks over the fixture's stream. */
function Transcript({ expected }: { readonly expected: number }) {
  const { projection, report } = useConversation('1')
  const { parts, branchable, earlier } = useTranscript('1', projection, report)
  const threads = useMemo<ChatThreads>(
    () => ({ chat: '1', at: new Map(), branchable, reply: () => undefined, open: () => undefined }),
    [branchable],
  )
  // As `ChatView` folds a turn's quiet work to one line each.
  const rows = useMemo(() => groupWork(parts, { appCalls: new Set() }), [parts])
  const shown = projection !== undefined && parts.length >= expected
  useEffect(() => {
    // Two frames on: the scroller has placed the transcript at its end and the browser has painted it.
    if (shown && perf.ready === undefined)
      requestAnimationFrame(() => requestAnimationFrame(() => (perf.ready = performance.now())))
  }, [shown])
  return (
    <section className="chat-view" data-place="channel" data-dock-ready="" aria-label="Transcript" data-app-scope>
      <AppsIn conversation="1">
        <Conversation
          parts={rows}
          canSwitchModel={false}
          threads={threads}
          loading={projection === undefined}
          {...(earlier && { onEarlier: earlier })}
        />
      </AppsIn>
    </section>
  )
}

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
const expected = Number(new URLSearchParams(location.search).get('parts') ?? '0')
const root = document.getElementById('root')
if (root)
  createRoot(root).render(
    <QueryClientProvider client={client}>
      <WorkspaceFeedProvider enabled={false}>
        <NavigationContext value={navigation}>
          <AppHost>
            <Profiler
              id="transcript"
              onRender={(_id, _phase, actual) => {
                if (!recording) return
                sample.commits += 1
                sample.commitMs += actual
              }}
            >
              <main style={{ height: '100dvh', display: 'flex', flexDirection: 'column' }}>
                <Transcript expected={expected} />
              </main>
              <textarea
                aria-label="Typing probe"
                style={{ position: 'fixed', insetInline: 16, bottom: 16, height: 48 }}
              />
            </Profiler>
          </AppHost>
        </NavigationContext>
      </WorkspaceFeedProvider>
    </QueryClientProvider>,
  )
