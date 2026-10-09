import { OrganizeReceipt } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'
import { callOwner } from '../../integration/owner-api.ts'
import { json, organizing } from './organizing.ts'

const scout = {
  name: 'Scout',
  avatar: { glyph: 'S', hue: 120 },
  role: 'Finds things out',
  instructions: 'Be brief.',
  exclusions: [],
}

const decodeReceipts = Schema.decodeUnknownSync(Schema.Array(OrganizeReceipt))
const decodeReceipt = Schema.decodeUnknownSync(OrganizeReceipt)

describe('the organize group', () => {
  it('lists what organizing changed, newest first', async () => {
    const { fetch } = organizing()
    expect(await (await fetch(new Request('https://agent/api/organize'))).json()).toEqual([])
    await fetch(json('POST', '/api/personas', { ...scout, operationId: 'op-1' }))
    await fetch(json('PATCH', '/api/personas/1', { role: 'Scouts ahead', expectedRevision: 1 }))
    const list = await fetch(new Request('https://agent/api/organize'))
    expect(list.status).toBe(200)
    expect(decodeReceipts(await list.json()).map(({ kind, actor, undoable }) => [kind, actor, undoable])).toEqual([
      ['persona.update', 'owner', true],
      ['persona.create', 'owner', false],
    ])
  })

  it('undoes a change once, with the body the web sends, and refuses it again as undone', async () => {
    const { fetch, personas, receipts } = organizing()
    await fetch(json('POST', '/api/personas', { ...scout, operationId: 'op-1' }))
    await fetch(json('PATCH', '/api/personas/1', { role: 'Scouts ahead', expectedRevision: 1 }))
    const update = receipts.list()[0]
    const undone = await fetch(json('POST', `/api/organize/${update?.id ?? ''}/undo`, {}))
    expect(undone.status).toBe(200)
    expect(decodeReceipt(await undone.json())).toMatchObject({ id: update?.id, undoable: false })
    expect(personas.get(1)).toMatchObject({ role: scout.role, revision: 3 })
    const again = await fetch(json('POST', `/api/organize/${update?.id ?? ''}/undo`))
    expect(again.status).toBe(409)
    expect(await again.json()).toMatchObject({ error: { code: 'conflict', reason: 'undone' } })
  })

  it('refuses Undo as touched once the target changed since, and answers 404 for a receipt that is not there', async () => {
    const { fetch, topics, receipts } = organizing()
    await fetch(json('POST', '/api/topics', { name: 'Garden', operationId: 'topic-1' }))
    await fetch(json('PATCH', '/api/topics/2', { name: 'Garden shed' }))
    const rename = receipts.list()[0]
    await fetch(json('PATCH', '/api/topics/2', { searchExcluded: true }))
    const touched = await fetch(json('POST', `/api/organize/${rename?.id ?? ''}/undo`, {}))
    expect(touched.status).toBe(409)
    expect(await touched.json()).toMatchObject({ error: { code: 'conflict', reason: 'touched' } })
    expect(topics.get(2)).toMatchObject({ name: 'Garden shed' })
    const unknown = await fetch(json('POST', `/api/organize/org_${'0'.repeat(32)}/undo`, {}))
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toMatchObject({ error: { code: 'not_found', what: 'receipt' } })
    for (const id of ['org_1', 'other', `org_${'A'.repeat(32)}`])
      expect((await fetch(json('POST', `/api/organize/${id}/undo`, {}))).status).toBe(404)
  })

  it("serves the probes' typed client: Undo of a Topic's creation archives it", async () => {
    const { fetch, topics, flows } = organizing()
    const agent = { fetch }
    const made = await callOwner(agent, (api) =>
      api.topics.create({ payload: { name: 'Errands', operationId: 'topic-1' } }),
    )
    const [created] = await callOwner(agent, (api) => api.organize.list())
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
    await fetch(json('POST', '/api/topics', { name: 'Garden', operationId: 'op-1' }))
    await fetch(json('POST', '/api/topics', { name: 'Garden', operationId: 'op-1' }))
    await fetch(json('POST', '/api/topics', { name: 'garden', operationId: 'op-2' }))
    expect(flows.map(({ flow, operationId, status, errorType }) => [flow, operationId, status, errorType])).toEqual([
      ['topic_create', 'op-1', 'ok', undefined],
      ['topic_create', 'op-1', 'replayed', undefined],
      ['topic_create', 'op-2', 'refused', 'Conflict'],
    ])
  })
})
