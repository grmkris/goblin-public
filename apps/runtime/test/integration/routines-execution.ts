import type { PersonalAgent } from '../../src/agent.ts'
import { drizzle } from 'drizzle-orm/durable-sqlite'
import { eq } from 'drizzle-orm'
import { proposeRoutine, changeRoutine, runRoutineNow } from './routines-owner.ts'
import { callOwner } from '../owner-client.ts'
import { RoutineRunStore } from '../../src/routines/runs.ts'
import { appConversations, appConversationCapabilities } from '../../src/storage/schema.ts'
import { BACKGROUND, conversationId } from '../../src/pi/context.ts'
import type { SeenRequest } from './model.ts'
import { type RoutineDefinition } from '@goblin/contracts'
import { ChatDirectory } from '../../src/chats/directory.ts'

/** Bounded native happy path: real app SQLite, native Pi tasks and the injected keyless model. */
export async function routineExecutionProbe(
  storage: DurableObjectStorage,
  agent: PersonalAgent,
  seen: readonly SeenRequest[],
) {
  const definition: RoutineDefinition = {
    title: 'Isolated native routine',
    prompt: 'Return a short reminder.',
    timezone: 'UTC',
    trigger: { kind: 'once', at: new Date(Date.now() + 3_600_000).toISOString() },
    notifyTelegram: false,
    allowedTools: [],
    budget: { tokensPerRun: 1000, tokensPerDay: 2000, runtimeSeconds: 60 },
  }
  const proposal = await proposeRoutine(agent, definition, 'execution-proposal')
  await changeRoutine(agent, proposal.id, { revision: 1, operationId: 'execution-confirm' }, 'confirm')
  const first = await runRoutineNow(agent, proposal.id, 1, 'execution-manual')
  const replay = await runRoutineNow(agent, proposal.id, 1, 'execution-manual')
  const db = drizzle(storage)
  const store = new RoutineRunStore(db, 'fixture')
  for (let count = 0; count < 200; count += 1) {
    if (store.get(first.id).state === 'completed') break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  await agent.routinesWake()
  const record = store.get(first.id)
  if (record.sessionId === null) throw new Error('Routine session did not bind')
  const thread = db.select().from(appConversations).where(eq(appConversations.chatId, record.sessionId)).get()
  const pi = await agent.harness.pi()
  const chats = new ChatDirectory(db)
  const main = await pi.conversation(conversationId(chats.session(chats.primary())), BACKGROUND)
  const history = await main?.entries({}, 100, undefined, BACKGROUND)
  const notes = history?.items.filter((entry) => entry.kind === 'app.routine') ?? []
  const child = await pi.conversation(conversationId(record.sessionId), BACKGROUND)
  const childHistory = await child?.entries({}, 100, undefined, BACKGROUND)
  const request = seen.find((item) =>
    item.messages.some((message) => message.text.includes('Confirmed routine: Isolated native routine')),
  )
  const spent = store.used(first.id, Date.now())
  await callOwner(agent, (api) => api.resident.set({ payload: { enabled: false } }))
  const calls = seen.length
  const skipped = await runRoutineNow(agent, proposal.id, 1, 'execution-skipped')
  await agent.routinesWake()
  return {
    duplicate: first.id === replay.id,
    state: record.state,
    session: record.sessionId,
    registered: thread?.kind === 'thread' && thread.routineRunId === first.id && thread.mainNote === null,
    copiedCapabilities: db
      .select()
      .from(appConversationCapabilities)
      .where(eq(appConversationCapabilities.sessionId, record.sessionId))
      .all().length,
    reportCount: notes.length,
    reportRequest: record.reportRequestId,
    reportAccepted: record.reportAcceptedAt !== null,
    childEntries: childHistory?.items.map((entry) => entry.kind),
    tools: request?.tools,
    usage: spent,
    skipped: skipped.state,
    skipOutcome: skipped.outcome,
    noSkippedModel: seen.length === calls,
  }
}
