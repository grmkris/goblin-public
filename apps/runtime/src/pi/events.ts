import type { AgentEventStream } from '@earendil-works/pi-durable'
import { sseResponse } from '../http/sse.ts'

/**
 * Pi-native SSE: `event: snapshot` with Pi's authoritative snapshot, then `event: batch` with committed event
 * batches. A transport projection only; a reconnecting client starts again from a fresh snapshot.
 */
export function piEventResponse(events: AgentEventStream): Response {
  return sseResponse((send, finish) => {
    send('snapshot', events.snapshot)
    events.start(async (batch) => {
      send('batch', batch)
      await Promise.resolve()
    })
    void events.closed.then(
      () => finish(),
      (error: Error) => finish(error),
    )
    return () => events.stop()
  })
}
