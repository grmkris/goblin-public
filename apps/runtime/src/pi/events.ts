import type { AgentEvent, AgentEventStream, SnapshotEvent } from '@earendil-works/pi-durable'

/** A transport projection only: Pi provides the authoritative snapshot and committed batches. */
export function piEventResponse(events: AgentEventStream): Response {
  const encoder = new TextEncoder()
  let connected = true
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, value: SnapshotEvent | readonly AgentEvent[]) => {
        if (connected) controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`))
      }
      send('snapshot', events.snapshot)
      events.start(async (batch) => {
        send('batch', batch)
        await Promise.resolve()
      })
      void events.closed
        .then(() => {
          if (connected) controller.close()
        })
        .catch((error: Error) => {
          if (connected) controller.error(error)
        })
    },
    async cancel() {
      connected = false
      await events.stop()
    },
  })
  return new Response(body, {
    headers: { 'cache-control': 'no-cache', 'content-type': 'text/event-stream' },
  })
}
