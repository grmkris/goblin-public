import { DecisionProposal } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { expect } from 'vitest'
import { callOwner } from '../owner-client.ts'
import { call, grantPlan, lever, ownerFetch, person, signedIn, workspaceOf } from './owner-requests.ts'

const decode = Schema.decodeUnknownSync(DecisionProposal)

/**
 * A decision proposal's label through the Worker (ADR 0031): a write without the CSRF header or from no origin is
 * refused at the edge, another account reaches only its own agent whatever it selects, and an unknown label is
 * invalid. The owner's feed alone shows the proposal; the first label wins and the feed shows it settled.
 */
export async function decisionsOwnerCase(base: string): Promise<void> {
  const owner = await person(base)
  const other = await person(base)
  for (const who of [owner, other]) await grantPlan(base, who)
  const seeded = decode(await (await lever(base, owner, 'decisions/seed')).json())
  const path = `/api/decisions/${seeded.id}`
  const body = JSON.stringify({ label: 'confirm' })
  const json = { cookie: owner.cookie, 'cf-connecting-ip': owner.ip, 'content-type': 'application/json' }
  for (const headers of [
    { ...json, origin: 'https://goblin.test' },
    { ...json, 'x-goblin-csrf': '1' },
  ])
    expect((await ownerFetch(`${base}${path}`, { method: 'POST', headers, body })).status).toBe(403)
  const foreign = await call(
    base,
    other,
    `${path}?agent=${owner.userId}`,
    { label: 'confirm' },
    {
      'x-goblin-workspace': owner.userId,
    },
  )
  expect(foreign.status).toBe(404)
  expect((await call(base, owner, path, { label: 'automatic' })).status).toBe(400)
  expect((await workspaceOf(base, owner)).proposals).toEqual([seeded])
  expect((await workspaceOf(base, other)).proposals).toEqual([])
  const browser = signedIn(base, owner)
  const label = (as: 'confirm' | 'dismiss') =>
    callOwner(browser, (api) => api.decisions.label({ params: { id: seeded.id }, payload: { label: as } }))
  const confirmed = await label('confirm')
  expect(confirmed.state).toBe('confirmed')
  expect(await label('confirm')).toEqual(confirmed)
  expect(
    await callOwner(browser, (api) =>
      Effect.flip(api.decisions.label({ params: { id: seeded.id }, payload: { label: 'dismiss' } })),
    ),
  ).toMatchObject({ _tag: 'Conflict', reason: 'settled' })
  expect((await workspaceOf(base, owner)).proposals).toEqual([confirmed])
}
