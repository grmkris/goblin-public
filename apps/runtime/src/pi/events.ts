import type { AgentEventStream } from '@earendil-works/pi-durable'
import { Internal } from '../http/errors.ts'
import { sseResponse } from '../http/sse.ts'

/** What fails the stream: Pi's own error, or one that says the event stream failed when Pi rejected with a non-error. */
const failure = (error: unknown): Error => (error instanceof Error ? error : new Internal({ reason: 'event_stream' }))

/**
 * Pi-native SSE: `event: snapshot` with Pi's authoritative snapshot, then `event: batch` with committed event
 * batches. A transport projection only; a reconnecting client starts again from a fresh snapshot.
 */
export function piEventResponse(events: AgentEventStream, onRebind?: (close: () => void) => () => void): Response {
  return sseResponse((send, finish) => {
    const unbind = onRebind?.(() => {
      // expected: a stop that fails ends the stream with that failure, which the client sees as a closed stream.
      void events.stop().catch((error: unknown) => finish(failure(error)))
    })
    send('snapshot', events.snapshot)
    events.start(async (batch) => {
      send('batch', batch)
      await Promise.resolve()
    })
    void events.closed.then(
      () => {
        unbind?.()
        finish()
      },
      (error: unknown) => {
        unbind?.()
        finish(failure(error))
      },
    )
    return () => {
      unbind?.()
      return events.stop()
    }
  })
}
