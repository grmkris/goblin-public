import type { AgentEventStream } from '@earendil-works/pi-durable'
import { sseResponse } from '../http/sse.ts'

/** Recheck membership before serializing every batch and periodically while idle. */
export function memberEventResponse(events: AgentEventStream, verify: () => Promise<void>): Response {
  return sseResponse((send, finish) => {
    let live = true
    let queued = Promise.resolve()
    const close = (error?: Error) => {
      live = false
      clearInterval(timer)
      void events.stop()
      finish(error)
    }
    const timer = setInterval(() => {
      void verify().catch(() => close())
    }, 5000)
    queued = queued.then(async () => {
      await verify()
      if (live) send('snapshot', events.snapshot)
    })
    events.start(async (batch) => {
      queued = queued.then(async () => {
        await verify()
        if (live) send('batch', batch)
      })
      await queued.catch(() => close())
    })
    void queued.catch(() => close())
    void events.closed.then(
      () => close(),
      () => close(),
    )
    return () => close()
  })
}
