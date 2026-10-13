import { TopicView } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'
import { callOwner } from '../../owner-client.ts'
import { json, post, unrouted } from './fixture.ts'
import { organizing } from './organizing.ts'

/**
 * The owner API as the agent serves it, through the Topics group: the reference every area's test copies, over real
 * Topic and receipt stores on SQLite, with the plan and resident authority the only fakes.
 */
const fixture = organizing

describe('the owner API served by the agent', () => {
  it('creates a Topic with 201 and the API headers, quoting the edge reference', async () => {
    const { fetch, resident } = fixture()
    const response = await fetch(
      json(
        'POST',
        '/api/topics',
        { name: ' Garden ', operationId: 'op-1' },
        { 'x-goblin-ref': '8c1f2a3b4d5e6f70-AMS' },
      ),
    )
    expect(response.status).toBe(201)
    expect(Schema.decodeUnknownSync(TopicView)(await response.json())).toMatchObject({ name: 'Garden', revision: 1 })
    expect(response.headers.get('x-goblin-ref')).toBe('8c1f2a3b4d5e6f70-AMS')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(resident.renewals).toHaveLength(1)
  })

  it('answers a name clash with the 409 envelope carrying the reference', async () => {
    const { fetch } = fixture()
    await fetch(post('/api/topics', { name: 'Garden', operationId: 'op-1' }))
    const response = await fetch(
      post('/api/topics', { name: 'garden', operationId: 'op-2' }, { 'x-goblin-ref': 'ref-409' }),
    )
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: {
        code: 'conflict',
        message: 'That clashes with something that is already there.',
        recovery: 'Refresh and try again.',
        reason: 'topic_name_taken',
        ref: 'ref-409',
      },
    })
  })

  it('answers a body that does not decode as 400 invalid_input, and a path id that does not parse as 404', async () => {
    const { fetch, resident } = fixture()
    for (const body of [{ name: '', operationId: 'op-1' }, '{not json', { operationId: 'op-1' }]) {
      const response = await fetch(post('/api/topics', body, { 'x-goblin-ref': 'ref-400' }))
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: { code: 'invalid_input', ref: 'ref-400' } })
    }
    const unsupported = await fetch(
      new Request('https://agent/api/topics', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' }),
    )
    expect(unsupported.status).toBe(400)
    expect(await unsupported.json()).toMatchObject({ error: { code: 'invalid_input', reason: 'body is not JSON' } })
    const badId = await fetch(json('PATCH', '/api/topics/0', { name: 'x' }))
    expect(badId.status).toBe(404)
    expect(await badId.json()).toMatchObject({ error: { code: 'not_found', what: 'route' } })
    // The gate admits before the body is decoded, exactly as it ran before every owner RPC method.
    expect(resident.renewals).toHaveLength(5)
  })

  it('refuses to archive Personal (400)', async () => {
    const { fetch } = fixture()
    const archive = await fetch(json('PATCH', '/api/topics/1', { archived: true }))
    expect(archive.status).toBe(400)
    expect(await archive.json()).toMatchObject({ error: { code: 'invalid_input', reason: 'personal_topic' } })
  })

  it('admits an owner without a plan: the gate reads none, so Start and Settings work before Pro (ADR 0054)', async () => {
    const { fetch, resident } = fixture({ active: false })
    const response = await fetch(post('/api/topics', { name: 'Work', operationId: 'op-1' }))
    expect(response.status).toBe(201)
    expect(resident.renewals).toHaveLength(1)
  })

  it('answers every path that is no endpoint with the 404 envelope, quoting the reference', async () => {
    const { fetch, resident } = fixture()
    for (const request of [
      new Request('https://agent/home'),
      new Request('https://agent/conversations/1/snapshot'),
      new Request('https://agent/api/unknown', { headers: { 'x-goblin-ref': 'ref-404' } }),
      new Request('https://agent/api/topics', { method: 'DELETE' }),
    ]) {
      const response = await fetch(request)
      expect(response.status).toBe(404)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await unrouted(response)).toBe(true)
    }
    expect(resident.renewals).toEqual([])
  })

  it("serves the probes' typed client: a clash decodes as the Conflict class with its reference", async () => {
    const { fetch } = fixture()
    const agent = { fetch }
    const made = await callOwner(agent, (api) => api.topics.create({ payload: { name: 'Work', operationId: 'op-1' } }))
    expect(made).toMatchObject({ name: 'Work' })
    const clash = await callOwner(agent, (api) =>
      Effect.flip(api.topics.create({ payload: { name: 'work', operationId: 'op-2' } })),
    )
    expect(clash).toMatchObject({ _tag: 'Conflict', reason: 'topic_name_taken', ref: 'integration-probe' })
    const renamed = await callOwner(agent, (api) =>
      api.topics.update({ params: { id: made.id }, payload: { name: 'Work 2' } }),
    )
    expect(renamed).toMatchObject({ id: made.id, name: 'Work 2', revision: 2 })
  })
})
