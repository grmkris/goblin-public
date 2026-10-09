import { HomeEditResult, type HomeOperation, HomeRead } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'
import { callOwner } from '../../integration/owner-api.ts'
import { json, organizing } from './organizing.ts'

const note = (id: string, title: string): HomeOperation => ({
  kind: 'add',
  tile: { kind: 'note', id, size: 'medium', title, markdown: `# ${title}` },
})

const decodeResult = Schema.decodeUnknownSync(HomeEditResult)

describe('the home group', () => {
  it('reads the empty layout and places a note, answering a replay as it answered the first time', async () => {
    const { fetch, resident } = organizing()
    const read = await fetch(new Request('https://agent/api/home'))
    expect(read.status).toBe(200)
    expect(Schema.decodeUnknownSync(HomeRead)(await read.json())).toEqual({
      layout: { revision: 0, tiles: [] },
      apps: [],
    })
    const edit = { operationId: 'home-1', expectedRevision: 0, ops: [note('plan', 'Plan')] }
    const placed = await fetch(json('POST', '/api/home', edit))
    expect(placed.status).toBe(200)
    const result = decodeResult(await placed.json())
    expect(result).toMatchObject({
      kind: 'applied',
      operationId: 'home-1',
      layout: { revision: 1, tiles: [expect.objectContaining({ id: 'plan', placedBy: 'owner' })] },
      message: 'Placed Plan on Home',
    })
    const replay = await fetch(json('POST', '/api/home', edit))
    expect(replay.status).toBe(200)
    expect(decodeResult(await replay.json())).toEqual(result)
    expect(resident.renewals).toHaveLength(3)
  })

  it('refuses an edit of an older revision with 409 and the layout as it is now, as it always has', async () => {
    const { fetch } = organizing()
    await fetch(json('POST', '/api/home', { operationId: 'home-1', expectedRevision: 0, ops: [note('plan', 'Plan')] }))
    const stale = await fetch(
      json(
        'POST',
        '/api/home',
        { operationId: 'home-2', expectedRevision: 0, ops: [note('later', 'Later')] },
        { 'x-goblin-ref': 'ref-stale' },
      ),
    )
    expect(stale.status).toBe(409)
    const body: unknown = await stale.json()
    expect(decodeResult(body)).toMatchObject({ kind: 'stale', layout: { revision: 1 } })
    expect(Object.keys(body ?? {}).toSorted()).toEqual(['kind', 'layout'])
  })

  it('undoes an edit, and answers an Undo after a later edit with the 409 conflict envelope', async () => {
    const { fetch } = organizing()
    await fetch(json('POST', '/api/home', { operationId: 'home-1', expectedRevision: 0, ops: [note('plan', 'Plan')] }))
    await fetch(json('POST', '/api/home', { operationId: 'home-2', expectedRevision: 1, ops: [note('more', 'More')] }))
    const late = await fetch(
      json('POST', '/api/home', { operationId: 'undo-1', expectedRevision: 2, ops: [], undoOf: 'home-1' }),
    )
    expect(late.status).toBe(409)
    expect(await late.json()).toMatchObject({ error: { code: 'conflict' } })
    const undone = await fetch(
      json('POST', '/api/home', { operationId: 'undo-2', expectedRevision: 2, ops: [], undoOf: 'home-2' }),
    )
    expect(undone.status).toBe(200)
    expect(decodeResult(await undone.json())).toMatchObject({
      kind: 'applied',
      message: 'Undid the Home edit',
      layout: { revision: 3, tiles: [expect.objectContaining({ id: 'plan' })] },
    })
    const missing = await fetch(
      json('POST', '/api/home', { operationId: 'undo-3', expectedRevision: 3, ops: [], undoOf: 'nothing' }),
    )
    expect(missing.status).toBe(404)
  })

  it("serves the probes' typed client: a stale edit and a conflict decode apart", async () => {
    const { fetch } = organizing()
    const agent = { fetch }
    const placed = await callOwner(agent, (api) =>
      api.home.edit({ payload: { operationId: 'home-1', expectedRevision: 0, ops: [note('plan', 'Plan')] } }),
    )
    expect(placed).toMatchObject({ kind: 'applied', layout: { revision: 1 } })
    const stale = await callOwner(agent, (api) =>
      Effect.flip(
        api.home.edit({ payload: { operationId: 'home-2', expectedRevision: 0, ops: [note('more', 'More')] } }),
      ),
    )
    expect(stale).toMatchObject({ kind: 'stale', layout: { revision: 1 } })
    const more = await callOwner(agent, (api) =>
      api.home.edit({ payload: { operationId: 'home-3', expectedRevision: 1, ops: [note('more', 'More')] } }),
    )
    const conflict = await callOwner(agent, (api) =>
      Effect.flip(
        api.home.edit({ payload: { operationId: 'undo-1', expectedRevision: 2, ops: [], undoOf: 'home-1' } }),
      ),
    )
    expect(conflict).toMatchObject({ _tag: 'Conflict', ref: 'integration-probe' })
    const read = await callOwner(agent, (api) => api.home.read())
    expect(read.layout).toEqual(more.layout)
  })
})
