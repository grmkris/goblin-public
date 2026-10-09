import { ResidentStatus } from '@goblin/contracts'
import { OwnerApi, RenewsResident, ResidentGroup, ownerApiOf } from '@goblin/contracts/api'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as HttpServer from 'effect/http/HttpServer'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { afterEach, describe, expect, it } from 'vitest'
import { OwnerGateLive } from '../../../src/http/api/middleware.ts'
import { OwnerHttp } from '../../../src/http/api/server.ts'
import { ResidentLive } from '../../../src/layers/mcp.ts'
import { ResidentHandlers } from '../../../src/mcp/resident-api.ts'
import { Events } from '../../../src/mcp/service.ts'
import { chatDatabase } from '../../chats-sqlite.ts'
import { callOwner } from '../../integration/owner-api.ts'
import { json, partial, plans, serve, sqliteDb } from './mcp-serve.ts'

/** Only the resident group, behind the real gate, router and failure rendering (`owner-http.test.ts`). */
const API = ownerApiOf(ResidentGroup)
const RESIDENT = HttpApiBuilder.layer(API).pipe(
  Layer.provide(ResidentHandlers),
  Layer.provide(OwnerGateLive),
  Layer.provide(HttpServer.layerServices),
)

const closes: (() => void)[] = []
afterEach(() => {
  for (const close of closes.splice(0)) close()
})

/**
 * The resident group over real resident authority on SQLite (lane M's layer), which the owner gate also renews. Events
 * are a fake that records the cleanup a revocation runs first.
 */
const fixture = () => {
  const { db, close } = chatDatabase()
  closes.push(close)
  const disabled: (string | undefined)[] = []
  const events = partial<Events['Service']>({
    disableServer: (serverId?: string) => Effect.sync(() => void disabled.push(serverId)),
  })
  const { fetch } = serve(
    OwnerHttp.serve(API, RESIDENT).pipe(
      Layer.provide(
        Layer.mergeAll(ResidentLive.pipe(Layer.provide(sqliteDb(db))), Layer.succeed(Events, events), plans()),
      ),
    ),
  )
  return { fetch, disabled }
}

const decode = Schema.decodeUnknownSync(ResidentStatus)

describe('the resident group', () => {
  it('answers the status after the gate renewed it, then revokes with the Events cleanup first and stays revoked', async () => {
    const { fetch, disabled } = fixture()
    const first = await fetch(new Request('https://agent/api/agent/resident'))
    expect(first.status).toBe(200)
    expect(decode(await first.json())).toMatchObject({ state: 'active' })
    const revoked = await fetch(json('POST', '/api/agent/resident', { enabled: false }))
    expect(revoked.status).toBe(200)
    expect(decode(await revoked.json())).toMatchObject({ state: 'revoked' })
    expect(disabled).toEqual([undefined])
    // An ordinary owner request renews the window but never clears a revocation.
    const after = decode(await (await fetch(new Request('https://agent/api/agent/resident'))).json())
    expect(after.state).toBe('revoked')
    const enabled = decode(await (await fetch(json('POST', '/api/agent/resident', { enabled: true }))).json())
    expect(enabled).toMatchObject({ state: 'active' })
    expect(enabled.revokedAt).toBeUndefined()
    expect(disabled).toHaveLength(1)
  })

  it('answers a body that is not a change as 400 invalid_input', async () => {
    const { fetch } = fixture()
    const response = await fetch(json('POST', '/api/agent/resident', { enabled: 'yes' }))
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_input' } })
  })

  it('marks only `set` as the endpoint the owner gate does not renew authority for', () => {
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
