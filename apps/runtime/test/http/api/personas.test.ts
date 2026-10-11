import { PersonaDetail, type PersonaDefinition, PersonaView } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'
import { callOwner } from '../../owner-client.ts'
import { get, json, post } from './fixture.ts'
import { organizing } from './organizing.ts'

const scout: PersonaDefinition = {
  name: 'Scout',
  avatar: { glyph: 'S', hue: 120 },
  role: 'Finds things out',
  instructions: 'Be brief.',
  setup: { mcpServers: [], skills: [], apps: [] },
}

const decodeView = Schema.decodeUnknownSync(PersonaView)

describe('the personas group', () => {
  it('creates a Persona with 201 and finds the same one for its operation id', async () => {
    const { fetch, resident, personas } = organizing()
    const first = await fetch(post('/api/personas', { ...scout, operationId: 'op-1' }))
    expect(first.status).toBe(201)
    const made = decodeView(await first.json())
    expect(made).toMatchObject({ id: 1, name: 'Scout', revision: 1 })
    const again = await fetch(post('/api/personas', { ...scout, name: 'Other', operationId: 'op-1' }))
    expect(again.status).toBe(201)
    expect(decodeView(await again.json())).toEqual(made)
    expect(personas.list()).toEqual([made])
    expect(resident.renewals).toHaveLength(2)
  })

  it('answers a taken name with 409 and a model the deployment does not offer with 400', async () => {
    const { fetch } = organizing()
    await fetch(post('/api/personas', { ...scout, operationId: 'op-1' }))
    const clash = await fetch(
      post('/api/personas', { ...scout, name: 'scout', operationId: 'op-2' }, { 'x-goblin-ref': 'ref-409' }),
    )
    expect(clash.status).toBe(409)
    expect(await clash.json()).toMatchObject({
      error: { code: 'conflict', reason: 'persona_name_taken', ref: 'ref-409' },
    })
    const model = await fetch(post('/api/personas', { ...scout, name: 'Other', model: 'x', operationId: 'op-3' }))
    expect(model.status).toBe(400)
    expect(await model.json()).toMatchObject({ error: { code: 'invalid_input', reason: 'persona_model' } })
  })

  it('reads one Persona with its revisions, and answers 404 for one that does not exist or a bad id', async () => {
    const { fetch } = organizing()
    await fetch(post('/api/personas', { ...scout, operationId: 'op-1' }))
    await fetch(json('PATCH', '/api/personas/1', { role: 'Digs deeper', expectedRevision: 1 }))
    const detail = await fetch(get('/api/personas/1'))
    expect(detail.status).toBe(200)
    expect(
      Schema.decodeUnknownSync(PersonaDetail)(await detail.json()).revisions.map((each) => [each.revision, each.role]),
    ).toEqual([
      [2, 'Digs deeper'],
      [1, 'Finds things out'],
    ])
    const missing = await fetch(get('/api/personas/999'))
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ error: { code: 'not_found', what: 'persona' } })
    expect((await fetch(get('/api/personas/0'))).status).toBe(404)
  })

  it('writes a new revision for the current one and refuses a stale one with 409', async () => {
    const { fetch } = organizing()
    await fetch(post('/api/personas', { ...scout, operationId: 'op-1' }))
    const edited = await fetch(json('PATCH', '/api/personas/1', { role: 'Scouts ahead', expectedRevision: 1 }))
    expect(edited.status).toBe(200)
    expect(decodeView(await edited.json())).toMatchObject({ role: 'Scouts ahead', revision: 2 })
    const stale = await fetch(json('PATCH', '/api/personas/1', { role: 'Stale', expectedRevision: 1 }))
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ error: { code: 'conflict', reason: 'revision' } })
    const body = await fetch(json('PATCH', '/api/personas/1', { role: 'No revision' }))
    expect(body.status).toBe(400)
  })

  it("refuses a reply to a hold in a chat that is not a Persona's fork, and a reply without words (ADR 0041)", async () => {
    const { fetch } = organizing()
    const nowhere = await fetch(
      post('/api/personas/reply', { fork: '50', operationId: 'op-r', text: 'Allowed. Go on.' }),
    )
    expect(nowhere.status).toBe(404)
    expect(await nowhere.json()).toMatchObject({ error: { code: 'not_found', what: 'persona fork' } })
    expect((await fetch(post('/api/personas/reply', { fork: '50', operationId: 'op-r', text: '' }))).status).toBe(400)
  })

  it("serves the probes' typed client: a stale edit decodes as the Conflict class", async () => {
    const { fetch } = organizing()
    const agent = { fetch }
    const made = await callOwner(agent, (api) => api.personas.create({ payload: { ...scout, operationId: 'op-1' } }))
    const edited = await callOwner(agent, (api) =>
      api.personas.update({ params: { id: made.id }, payload: { archived: true, expectedRevision: 1 } }),
    )
    expect(edited.archivedAt).toBeTypeOf('number')
    const detail = await callOwner(agent, (api) => api.personas.detail({ params: { id: made.id } }))
    expect(detail.revisions).toHaveLength(2)
    const stale = await callOwner(agent, (api) =>
      Effect.flip(api.personas.update({ params: { id: made.id }, payload: { archived: false, expectedRevision: 1 } })),
    )
    expect(stale).toMatchObject({ _tag: 'Conflict', reason: 'revision', ref: 'integration-probe' })
  })
})
