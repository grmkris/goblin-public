import * as Effect from 'effect/Effect'
import { attempt } from '../../src/http/errors.ts'
import { makeEvents } from '../../src/mcp/events.ts'
import { installEventConsumers } from '../../src/mcp/events/consumers.ts'
import { SqliteEventStore } from '../../src/mcp/events/store.ts'
import { makeSkills } from '../../src/skills/library.ts'
import { SqliteSkillState } from '../../src/skills/store.ts'
import { digestOf } from '../../src/skills/verify.ts'
import type { EventsProbeState } from './events-probe.ts'

async function skillVersion(state: EventsProbeState, version: string) {
  const uri = `skill://skv_${version.repeat(24)}/events-test/SKILL.md`
  const body = `---\nname: events-test\ndescription: Verify event invalidation.\n---\n\n# Version ${version}\n`
  const bytes = new TextEncoder().encode(body)
  state.fixture.files.set(uri, body)
  state.fixture.skills = [
    {
      uri,
      frontmatter: { name: 'events-test', description: 'Verify event invalidation.' },
      resources: [{ uri, digest: await digestOf(bytes), size: bytes.byteLength }],
    },
  ]
}

/** Signed Events drive the installed Skills consumer, persisted generations and immutable retained activations. */
export async function eventsSkillsProbe(state: EventsProbeState) {
  const { skillState, fixture, events, channel, run } = state
  const library = await run(makeSkills(skillState))
  await run(library.setEnabled('mygram', true))
  await run(
    installEventConsumers(events, {
      channel: Effect.sync(() => channel.status()),
      pull: attempt(state.pull),
      skills: { enabled: library.enabled, invalidate: library.invalidate },
    }),
  )
  await skillVersion(state, '1')
  const first = await run(library.activate('skills-old', 'mygram:events-test'))
  await run(events.grant('mygram', 'skills.updated', {}, true))
  await run(
    events.subscribe({
      consumerId: 'skills:updates',
      revision: 1,
      serverId: 'mygram',
      name: 'skills.updated',
      arguments: {},
      handlerKey: 'skills-refresh',
    }),
  )
  await skillVersion(state, '2')
  const envelope = {
    eventId: 'evt_skills',
    name: 'skills.updated',
    timestamp: new Date(fixture.now).toISOString(),
    data: { instruction: 'This untrusted field is never executed.' },
  }
  await fixture.deliver('sub_skills.updated', envelope, envelope.eventId)
  await run(events.dispatch())
  const dirty = new SqliteSkillState(state.db).catalogState('mygram').dirty
  await fixture.deliver('sub_skills.updated', envelope, envelope.eventId)
  await run(events.dispatch())
  const replayDirty = skillState.catalogState('mygram').dirty
  const reconstructed = await run(makeSkills(new SqliteSkillState(state.db)))
  const second = await run(reconstructed.activate('skills-new', 'mygram:events-test'))
  const retained = await run(reconstructed.read('skills-old', 'mygram:events-test', 'SKILL.md'))
  const refreshed = skillState.catalogState('mygram').refreshed
  await fixture.deliver('sub_skills.updated', { type: 'terminated', error: { code: -32012 } }, 'msg_terminated_skills')
  await run(events.dispatch())
  return {
    first: first.body.includes('Version 1'),
    second: second.body.includes('Version 2'),
    retained: retained.kind === 'text' && retained.text.includes('Version 1'),
    dirty,
    replayDirty,
    refreshed,
    terminated: skillState.catalogState('mygram').unavailable,
  }
}

/** Rebuild services over real DO SQLite after acceptance, including handler failure and retention beyond eight days. */
export async function eventsRecoveryProbe(state: EventsProbeState) {
  const { events, fixture, store, run } = state
  await run(events.grant('mygram', 'skills.list_changed', {}, true))
  await run(events.register('recover-test', () => Effect.die(new Error('injected handler interruption'))))
  const binding = { consumerId: 'recovery-test', revision: 1 }
  const subscribed = await run(
    events.subscribe({
      ...binding,
      serverId: 'mygram',
      name: 'skills.list_changed',
      arguments: {},
      handlerKey: 'recover-test',
    }),
  )
  const envelope = {
    eventId: 'evt_recovery',
    name: 'skills.list_changed',
    timestamp: new Date(fixture.now).toISOString(),
    data: {},
  }
  await fixture.deliver('sub_skills.list_changed', envelope, envelope.eventId)
  await run(events.dispatch())
  const interrupted = store.delivery(subscribed.subscriptionId, envelope.eventId)
  await state.clock(fixture.now + 9 * 86_400_000)
  store.prune(fixture.now)
  const pendingRetained = store.delivery(subscribed.subscriptionId, envelope.eventId)?.processedAt === null
  const reconstructed = await run(makeEvents({ ...state.eventOptions, store: new SqliteEventStore(state.db) }))
  const operationIds: string[] = []
  await run(
    reconstructed.register('recover-test', ({ receipt }) =>
      Effect.sync(() => {
        operationIds.push(receipt.operationId)
      }),
    ),
  )
  await run(reconstructed.dispatch())
  await run(reconstructed.dispatch())
  const accepted = store.snapshots(subscribed.subscriptionId, envelope.eventId)[0]
  return {
    interrupted: interrupted?.attempts === 1 && interrupted.processedAt === null,
    pendingRetained,
    accepted: accepted?.state === 'accepted',
    stableOperation: operationIds.length === 1 && operationIds[0] === accepted?.operationId,
    processed: store.delivery(subscribed.subscriptionId, envelope.eventId)?.processedAt !== null,
  }
}
