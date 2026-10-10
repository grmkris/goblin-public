import { ResidentStatus } from '@goblin/contracts'
import { OwnerApi, RenewsResident, ResidentGroup } from '@goblin/contracts/api'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'
import { ResidentLive } from '../../../src/layers/core.ts'
import { ResidentHandlers } from '../../../src/mcp/resident-api.ts'
import { Events } from '../../../src/mcp/service.ts'
import { callOwner } from '../../owner-client.ts'
import { database, get, plans, post, serve, served, sqliteDb, stub } from './fixture.ts'

const fixture = () => {
  const disabled: (string | undefined)[] = []
  const events = stub(Events, {
    disableServer: (serverId?: string) => Effect.sync(() => void disabled.push(serverId)),
  })
  const { fetch } = serve(
    served([ResidentGroup], ResidentHandlers).pipe(
      Layer.provide(Layer.mergeAll(ResidentLive.pipe(Layer.provide(sqliteDb(database()))), events, plans())),
    ),
  )
  return { fetch, disabled }
}

const decode = Schema.decodeUnknownSync(ResidentStatus)

describe('the resident group', () => {
  it('answers the status after the gate renewed it, then revokes with the Events cleanup first and stays revoked', async () => {
    const { fetch, disabled } = fixture()
    const first = await fetch(get('/api/agent/resident'))
    expect(first.status).toBe(200)
    expect(decode(await first.json())).toMatchObject({ state: 'active' })
    const revoked = await fetch(post('/api/agent/resident', { enabled: false }))
    expect(revoked.status).toBe(200)
    expect(decode(await revoked.json())).toMatchObject({ state: 'revoked' })
    expect(disabled).toEqual([undefined])
    // An ordinary owner request renews the window but never clears a revocation.
    const after = decode(await (await fetch(get('/api/agent/resident'))).json())
    expect(after.state).toBe('revoked')
    const enabled = decode(await (await fetch(post('/api/agent/resident', { enabled: true }))).json())
    expect(enabled).toMatchObject({ state: 'active' })
    expect(enabled.revokedAt).toBeUndefined()
    expect(disabled).toHaveLength(1)
  })

  it('answers a body that is not a change as 400 invalid_input', async () => {
    const { fetch } = fixture()
    const response = await fetch(post('/api/agent/resident', { enabled: 'yes' }))
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_input' } })
  })

  it('marks only `set` as the endpoint owner admission does not renew authority for', () => {
    const { endpoints } = OwnerApi.groups.resident
    expect(Context.get(endpoints.status.annotations, RenewsResident)).toBe(true)
    expect(Context.get(endpoints.set.annotations, RenewsResident)).toBe(false)
  })

  it("serves the probes' typed client", async () => {
    const { fetch } = fixture()
    const agent = { fetch }
    expect(await callOwner(agent, (api) => api.resident.set({ payload: { enabled: false } }))).toMatchObject({
      state: 'revoked',
    })
    expect(await callOwner(agent, (api) => api.resident.status())).toMatchObject({ state: 'revoked' })
  })
})
