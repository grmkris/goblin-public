import { PRIMARY_CHAT } from '@goblin/contracts'
import { drizzle } from 'drizzle-orm/durable-sqlite'
import { CapabilityProfiles } from '../../src/capabilities/profiles.ts'
import { ChatDirectory } from '../../src/chats/directory.ts'
import { appConversations } from '../../src/storage/schema.ts'
import { runApplicationMigrations } from '../../src/storage/migrations.ts'
import { exchange, ownerCreate, ownerSend, threadsUntil, transcript } from './probe-reads.ts'
import type { PersonalAgentProbe } from './worker.ts'

/** Live ancestry, direct-parent control and copied app exclusions on the native SQLite adapter. */
export async function helperExclusionsProbe(storage: DurableObjectStorage) {
  runApplicationMigrations(storage)
  const db = drizzle(storage)
  db.insert(appConversations)
    .values([
      { chatId: '700', piSession: '700', kind: 'thread', createdAt: 1 },
      { chatId: '701', piSession: '701', kind: 'subagent', parentSession: '700', createdAt: 1 },
      { chatId: '702', piSession: '702', kind: 'subagent', parentSession: '701', createdAt: 1 },
      { chatId: '703', piSession: '703', kind: 'thread', parentSession: '702', createdAt: 1 },
    ])
    .run()
  const profiles = new CapabilityProfiles(db, [], async () => undefined, new ChatDirectory(db))
  await profiles.configureHelper(
    '700',
    '701',
    [
      { kind: 'app', app: 'counter' },
      { kind: 'skills', serverId: 'lib' },
      { kind: 'tool', serverId: 'notes', name: 'write' },
      { kind: 'subagents' },
    ],
    2,
  )
  await profiles.configureHelper('701', '702', [], 2)
  const state = (id: string) => ({
    app: profiles.app(id, 'counter'),
    skills: profiles.scope(id).skills('lib'),
    tool: profiles.scope(id).tool('notes', 'write'),
    delegation: profiles.scope(id).subagents(),
  })
  const narrowed = state('702')
  profiles.copy('702', '703', 3)
  let foreignRefused = false
  try {
    await profiles.configureHelper('700', '702', [], 3)
  } catch {
    foreignRefused = true
  }
  await profiles.configureHelper('700', '701', [], 4)
  return { narrowed, restored: state('702'), copied: state('703'), foreignRefused }
}

/** Real owner submission rejects stale chips before model work and references helpers without routing to them. */
export async function composerSequence(agent: DurableObjectStub<PersonalAgentProbe>): Promise<Response> {
  const before = await agent.modelRequestCount()
  const invalid = await ownerSend(agent, PRIMARY_CHAT, 'Keep this draft', 'invalid-selection', {
    selections: [{ kind: 'skill', serverId: 'missing', uri: 'skill://missing/SKILL.md' }],
  })
  const noInvalidModelWork = before === (await agent.modelRequestCount())
  await exchange(
    agent,
    PRIMARY_CHAT,
    `call subagent_spawn ${JSON.stringify({ name: 'scout', message: 'bounded report' })}`,
    'helper-spawn',
  )
  const helper = (
    await threadsUntil(
      agent,
      (views) => views.some((view) => view.title === 'scout' && view.closedBy === 'done'),
      15_000,
    )
  ).find((view) => view.title === 'scout')
  if (helper === undefined) throw new Error('fixture helper missing')
  const thread = await ownerCreate(agent, {})
  if (!thread.ok) throw new Error('fixture thread missing')
  const helperBefore = await transcript(agent, helper.id)
  const referenced = await ownerSend(agent, thread.value.id, 'Answer here', 'helper-reference', {
    selections: [{ kind: 'subagent', conversationId: helper.id }],
  })
  await agent.settle(thread.value.id, 'helper-reference')
  const helperAfter = await transcript(agent, helper.id)
  return Response.json({
    exclusions: await agent.helperExclusionsProbe(),
    invalid,
    noInvalidModelWork,
    referenced,
    reference: await transcript(agent, thread.value.id),
    helperUnchanged: JSON.stringify(helperBefore) === JSON.stringify(helperAfter),
    tools: (await agent.requestFor('bounded report'))?.tools ?? [],
  })
}
