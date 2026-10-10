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
import { BATCH_INTERVAL_MS, type PerfApi, type Sample, streamBatches } from './transcript-fixture.ts'
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
