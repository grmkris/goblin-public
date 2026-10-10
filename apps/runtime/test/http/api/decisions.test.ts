import { DecisionProposal } from '@goblin/contracts'
import { DecisionsGroup } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'
import { DecisionsHandlers } from '../../../src/decisions/api.ts'
import { Decisions } from '../../../src/decisions/service.ts'
import { addProposal } from '../../../src/decisions/store.ts'
import { Resident } from '../../../src/mcp/service.ts'
import { callOwner } from '../../owner-client.ts'
import { decisionsFixture } from '../../decisions-services.ts'
import { currentResident, plans, post, serve, served, unrouted } from './fixture.ts'

const decode = Schema.decodeUnknownSync(DecisionProposal)

/** The decisions group as the agent serves it, over the real service and an open report highlight in Personal. */
async function fixture() {
  const f = decisionsFixture()
  f.sqlite.exec(
    "INSERT INTO app_conversations (session_id, pi_session, role, kind, created_at, topic_id) VALUES ('1', '1', 'primary', 'main', 1, 1)",
  )
  addProposal(
    f.db,
    {
      id: 'dp_report_r1',
      chatId: '1',
      kind: 'attention-triage',
      subject: 'r1',
      payload: { type: 'highlight', relayId: 'r1', text: 'Done.' },
      state: 'open',
      probability: 0.85,
      provider: 'cloudflare/clef',
      createdAt: 1,
    },
    { session: '1', epoch: 0 },
  )
  const decisions = await f.run(Decisions.use(Effect.succeed))
  const { fetch } = serve(
    served([DecisionsGroup], DecisionsHandlers).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(Decisions, decisions),
          Layer.succeed(Resident, currentResident().service),
          plans(),
        ),
      ),
    ),
  )
  return { ...f, fetch }
}

describe('the decisions group', () => {
  it("keeps the owner's first label, answers it again, and refuses the other one", async () => {
    const { fetch } = await fixture()
    const first = await fetch(post('/api/decisions/dp_report_r1', { label: 'confirm' }))
    expect(first.status).toBe(200)
    const confirmed = decode(await first.json())
    expect(confirmed).toMatchObject({ id: 'dp_report_r1', state: 'confirmed' })
    expect(decode(await (await fetch(post('/api/decisions/dp_report_r1', { label: 'confirm' }))).json())).toEqual(
      confirmed,
    )
    const opposite = await fetch(post('/api/decisions/dp_report_r1', { label: 'dismiss' }))
    expect(opposite.status).toBe(409)
    expect(await opposite.json()).toMatchObject({ error: { code: 'conflict', reason: 'settled' } })
  })

  it('refuses a label it does not know, a proposal that is not there and a path that names none', async () => {
    const { fetch } = await fixture()
    expect((await fetch(post('/api/decisions/dp_report_r1', { label: 'automatic' }))).status).toBe(400)
    const missing = await fetch(post('/api/decisions/dp_report_none', { label: 'dismiss' }))
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ error: { code: 'not_found', what: 'decision proposal' } })
    for (const id of ['report_r1', 'dp_', `dp_${'x'.repeat(121)}`, 'dp_a.b'])
      expect(await unrouted(await fetch(post(`/api/decisions/${id}`, { label: 'confirm' })))).toBe(true)
  })

  it("serves the web's typed client", async () => {
    const { fetch } = await fixture()
    const dismissed = await callOwner({ fetch }, (api) =>
      api.decisions.label({ params: { id: 'dp_report_r1' }, payload: { label: 'dismiss' } }),
    )
    expect(dismissed).toMatchObject({ state: 'dismissed', decidedAt: expect.any(Number) })
  })
})
