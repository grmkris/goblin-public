import type { AgentEventStream } from '@earendil-works/pi-durable'
import { Internal } from '../http/errors.ts'
import { sseResponse } from '../http/sse.ts'

/** What fails the stream: Pi's own error, or one that says the event stream failed when Pi rejected with a non-error. */
const failure = (error: unknown): Error => (error instanceof Error ? error : new Internal({ reason: 'event_stream' }))

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
      (error: unknown) => finish(failure(error)),
    )
    return () => events.stop()
  })
}
