import { OrganizeReceipt } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'
import { callOwner } from '../../owner-client.ts'
import { json, post } from './fixture.ts'
import { organizing } from './organizing.ts'

const scout = {
  name: 'Scout',
  avatar: { glyph: 'S', hue: 120 },
  role: 'Finds things out',
  instructions: 'Be brief.',
  exclusions: [],
}

const decodeReceipt = Schema.decodeUnknownSync(OrganizeReceipt)

/** `PATCH /api/topics/2/setup` with `body`. */
const setup = (fetch: (request: Request) => Promise<Response>, body: unknown) =>
  fetch(json('PATCH', '/api/topics/2/setup', body))

describe('the organize group', () => {
  it('undoes a change once, with the body the web sends, and refuses it again as undone', async () => {
    const { fetch, personas, receipts } = organizing()
    await fetch(post('/api/personas', { ...scout, operationId: 'op-1' }))
    await fetch(json('PATCH', '/api/personas/1', { role: 'Scouts ahead', expectedRevision: 1 }))
    const update = receipts.list()[0]
    const undone = await fetch(post(`/api/organize/${update?.id ?? ''}/undo`, {}))
    expect(undone.status).toBe(200)
    expect(decodeReceipt(await undone.json())).toMatchObject({ id: update?.id, undoable: false })
    expect(personas.get(1)).toMatchObject({ role: scout.role, revision: 3 })
    const again = await fetch(post(`/api/organize/${update?.id ?? ''}/undo`))
    expect(again.status).toBe(409)
    expect(await again.json()).toMatchObject({ error: { code: 'conflict', reason: 'undone' } })
  })

  it('refuses Undo as touched once the target changed since, and answers 404 for a receipt that is not there', async () => {
    const { fetch, topics, receipts } = organizing()
    await fetch(post('/api/topics', { name: 'Garden', operationId: 'topic-1' }))
    await fetch(json('PATCH', '/api/topics/2', { name: 'Garden shed' }))
    const rename = receipts.list()[0]
    await fetch(json('PATCH', '/api/topics/2', { searchExcluded: true }))
    const touched = await fetch(post(`/api/organize/${rename?.id ?? ''}/undo`, {}))
    expect(touched.status).toBe(409)
    expect(await touched.json()).toMatchObject({ error: { code: 'conflict', reason: 'touched' } })
    expect(topics.get(2)).toMatchObject({ name: 'Garden shed' })
    const unknown = await fetch(post(`/api/organize/org_${'0'.repeat(32)}/undo`, {}))
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toMatchObject({ error: { code: 'not_found', what: 'receipt' } })
    for (const id of ['org_1', 'other', `org_${'A'.repeat(32)}`])
      expect((await fetch(post(`/api/organize/${id}/undo`, {}))).status).toBe(404)
  })

  it("serves the probes' typed client: Undo of a Topic's creation archives it", async () => {
    const { fetch, topics, receipts, flows } = organizing()
    const agent = { fetch }
    const made = await callOwner(agent, (api) =>
      api.topics.create({ payload: { name: 'Errands', operationId: 'topic-1' } }),
    )
    const [created] = receipts.list()
    expect(created).toMatchObject({ kind: 'topic.create', target: String(made.id), undoable: true })
    const undone = await callOwner(agent, (api) => api.organize.undo({ params: { id: created?.id ?? '' } }))
    expect(undone.undoneAt).toBeTypeOf('number')
    expect(topics.get(made.id).archivedAt).toBeTypeOf('number')
    const again = await callOwner(agent, (api) => Effect.flip(api.organize.undo({ params: { id: created?.id ?? '' } })))
    expect(again).toMatchObject({ _tag: 'Conflict', reason: 'undone' })
    // Each step is one content-free flow event: the create, the archive the Undo made, the Undo, the refused repeat.
    expect(flows).toEqual([
      { flow: 'topic_create', via: 'app', actor: 'owner', operationId: 'topic-1', topic: made.id, status: 'ok' },
      { flow: 'topic_archive', via: 'app', actor: 'owner', topic: made.id, count: 0, status: 'ok' },
      { flow: 'organize_undo', via: 'app', actor: 'owner', topic: made.id, status: 'ok' },
      { flow: 'organize_undo', via: 'app', actor: 'owner', status: 'refused', errorType: 'Conflict' },
    ])
  })

  it('records a refused Topic create and a replayed one as flows', async () => {
    const { fetch, flows } = organizing()
    await fetch(post('/api/topics', { name: 'Garden', operationId: 'op-1' }))
    await fetch(post('/api/topics', { name: 'Garden', operationId: 'op-1' }))
    await fetch(post('/api/topics', { name: 'garden', operationId: 'op-2' }))
    expect(flows.map(({ flow, operationId, status, errorType }) => [flow, operationId, status, errorType])).toEqual([
      ['topic_create', 'op-1', 'ok', undefined],
      ['topic_create', 'op-1', 'replayed', undefined],
      ['topic_create', 'op-2', 'refused', 'Conflict'],
    ])
  })

  describe("a Topic's setup (ADR 0040)", () => {
    it('narrows from everything, adds back, and answers the routines it affects', async () => {
      const { fetch, topics } = organizing()
      await fetch(post('/api/topics', { name: 'Work', operationId: 'topic-1' }))
      const narrowed = await setup(fetch, { remove: [{ kind: 'tool', serverId: 'notes', name: 'read' }] })
      expect(narrowed.status).toBe(200)
      expect(await narrowed.json()).toMatchObject({ topic: { id: 2, setup: { mcpServers: [] } }, routines: [] })
      await setup(fetch, { add: [{ kind: 'server', serverId: 'notes' }] })
      expect(topics.get(2).setup).toMatchObject({ mcpServers: [{ serverId: 'notes', tools: 'all' }], skills: 'all' })
    })

    it('refuses a whole setup over a stale revision, and writes nothing for the same one', async () => {
      const { fetch, topics } = organizing()
      await fetch(post('/api/topics', { name: 'Work', operationId: 'topic-1' }))
      const { revision, setup: current } = topics.get(2)
      const stale = await setup(fetch, { set: { ...current, apps: [] }, expectedRevision: revision - 1 })
      expect(stale.status).toBe(409)
      expect(await stale.json()).toMatchObject({ error: { code: 'conflict', reason: 'revision' } })
      await setup(fetch, { set: current, expectedRevision: revision })
      expect(topics.get(2).revision).toBe(revision)
    })

    it('leaves a receipt Undo restores, and applies Pi filters again when subagents change', async () => {
      const { fetch, topics, receipts, retooled } = organizing()
      await fetch(post('/api/topics', { name: 'Work', operationId: 'topic-1' }))
      const before = topics.get(2)
      await setup(fetch, { remove: [{ kind: 'subagents' }] })
      expect(retooled).toEqual([2])
      const [changed] = receipts.list()
      expect(changed).toMatchObject({ kind: 'topic.setup', target: '2', actor: 'owner', undoable: true })
      const undone = await fetch(post(`/api/organize/${changed?.id ?? ''}/undo`, {}))
      expect(undone.status).toBe(200)
      expect(topics.get(2).setup).toEqual(before.setup)
      expect(retooled).toEqual([2, 2])
    })
  })
})
