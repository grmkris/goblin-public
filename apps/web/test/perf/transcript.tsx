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
  return {
    top: viewport.scrollTop,
    hidden: last === undefined ? 0 : last.bottom - clear,
    arrow: (viewport.parentElement?.getAttribute('data-scrollable') ?? '').split(' ').includes('end'),
    spacer: document.querySelector<HTMLElement>('[data-message-scroller-spacer]')?.offsetHeight ?? 0,
    rows: new Map(
      rows.map((row) => [row.dataset.messageId ?? '', row.getBoundingClientRect().top + viewport.scrollTop]),
    ),
  }
}

/** Plays `steps` and watches every frame; the scroller's own state is read from the DOM, as a person would see it. */
async function follow(steps: readonly Step[]): Promise<FollowReport> {
  let watching = true
  let streaming = true
  let previous = look()
  let frames = 0
  let hiddenMax = Number.NEGATIVE_INFINITY
  let arrowFrames = 0
  let backFrames = 0
  let backMax = 0
  let shifts = 0
  let shiftMax = 0
  let spacerMax = 0
  const trace: string[] = []
  const watch = () => {
    const now = look()
    if (now !== undefined) {
      frames += 1
      hiddenMax = Math.max(hiddenMax, now.hidden)
      spacerMax = Math.max(spacerMax, now.spacer)
      if (now.arrow && streaming) arrowFrames += 1
      if (previous !== undefined) {
        const back = previous.top - now.top
        if (back > 2) {
          backFrames += 1
          backMax = Math.max(backMax, back)
        }
        const newest = [...now.rows.keys()].at(-1)
        for (const [id, top] of now.rows) {
          const before = previous.rows.get(id)
          if (before !== undefined && id !== newest && Math.abs(top - before) > 1) {
            shifts += 1
            shiftMax = Math.max(shiftMax, Math.abs(top - before))
          }
        }
        if (trace.length < 400 && (back > 2 || now.arrow !== previous.arrow))
          trace.push(
            `f${frames} top ${Math.round(previous.top)}→${Math.round(now.top)} arrow ${now.arrow} spacer ${now.spacer}`,
          )
      }
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
  return {
    frames,
    hiddenMax: Math.round(hiddenMax),
    hiddenFinal: Math.round(settled?.hidden ?? 0),
    arrowFinal: settled?.arrow ?? false,
    arrowFrames,
    backFrames,
    backMax: Math.round(backMax),
    shifts,
    shiftMax: Math.round(shiftMax),
    spacerMax,
    trace,
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
  const shown = projection !== undefined && parts.length >= expected
  useEffect(() => {
    // Two frames on: the scroller has placed the transcript at its end and the browser has painted it.
    if (shown && perf.ready === undefined)
      requestAnimationFrame(() => requestAnimationFrame(() => (perf.ready = performance.now())))
  }, [shown])
  return (
    <section className="chat-view" data-place="channel" aria-label="Transcript" data-app-scope>
      <AppsIn conversation="1">
        <Conversation
          parts={parts}
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
