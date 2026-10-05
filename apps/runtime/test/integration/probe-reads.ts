import type { ConversationView } from '@purrable/contracts'
import type { PersonalAgentProbe } from './worker.ts'

type Probe = DurableObjectStub<PersonalAgentProbe>

export type Entry = {
  readonly id: number
  readonly kind: string
  readonly head?: number
  readonly data?: unknown
  readonly model?: readonly { readonly content?: unknown; readonly details?: unknown }[]
}

/** A conversation's snapshot through the same route the Worker proxies (`/conversations/<id>/snapshot`). */
export const snapshotOf = async (agent: Probe, session: string): Promise<{ entries?: Entry[] }> =>
  (await agent.fetch(`https://agent/conversations/${session}/snapshot`)).json()

/** Entries as `kind: content`, one line per model message. */
export const linesOf = (records: readonly Entry[]) =>
  records.flatMap((entry) => (entry.model ?? []).map((message) => `${entry.kind}: ${JSON.stringify(message.content)}`))

/** A conversation's history before entry `before`, through the route the Worker proxies. */
export const historyOf = async (agent: Probe, session: string, before = 2 ** 31): Promise<{ entries?: Entry[] }> =>
  (await agent.fetch(`https://agent/conversations/${session}/history?before=${before}`)).json()

/** A conversation's newest entries as people read them, in order, whatever the model's context starts with now. */
export const transcript = async (agent: Probe, session: string): Promise<string[]> =>
  linesOf((await historyOf(agent, session)).entries ?? [])

/**
 * Reads every 20 ms until `done` holds, for up to `ms` (5 s by default); the last read either way (background work
 * settles late).
 */
export async function until<A>(read: () => Promise<A>, done: (value: A) => boolean, ms = 5000): Promise<A> {
  let value = await read()
  for (let attempt = 0; attempt < ms / 20 && !done(value); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20))
    value = await read()
  }
  return value
}

/** The agent's conversations, once `done` holds for them. */
export const threadsUntil = (agent: Probe, done: (views: readonly ConversationView[]) => boolean, ms?: number) =>
  until(
    async (): Promise<readonly ConversationView[]> => {
      const threads = await agent.conversations()
      return threads.ok ? threads.value : []
    },
    done,
    ms,
  )

/** One owner message into a conversation, settled. */
export async function exchange(agent: Probe, session: string, text: string, id: string) {
  await agent.submit(session, text, id)
  return agent.settle(session, id)
}
