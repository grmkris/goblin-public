import { ResidentGroup, ownerApiOf } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as HttpServer from 'effect/http/HttpServer'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { afterEach, describe, expect, it } from 'vitest'
import { OwnerGateLive } from '../../../src/http/api/middleware.ts'
import { OwnerHttp } from '../../../src/http/api/server.ts'
import { ResidentLive } from '../../../src/layers/mcp.ts'
import { ResidentHandlers } from '../../../src/mcp/resident-api.ts'
import { Events } from '../../../src/mcp/service.ts'
import { ResidentAuthority } from '../../../src/resident.ts'
import { Resident as LegacyResident } from '../../../src/services.ts'
import { chatDatabase } from '../../chats-sqlite.ts'
import { json, partial, plans, serve, sqliteDb } from './mcp-serve.ts'

const API = ownerApiOf(ResidentGroup)
const RESIDENT = HttpApiBuilder.layer(API).pipe(
  Layer.provide(ResidentHandlers),
  Layer.provide(OwnerGateLive),
  Layer.provide(HttpServer.layerServices),
)

/** Resident authority on SQLite that counts the renewals asked for from outside (revoking renews on its own). */
class CountingResident extends ResidentAuthority {
  readonly renewals: number[] = []
  #revoking = false
  override renew(now: number): void {
    if (!this.#revoking) this.renewals.push(now)
    super.renew(now)
  }
  override revoke(now: number): void {
    this.#revoking = true
    try {
      super.revoke(now)
    } finally {
      this.#revoking = false
    }
  }
}

const closes: (() => void)[] = []
afterEach(() => {
  for (const close of closes.splice(0)) close()
})

describe('the owner gate', () => {
  it('renews resident authority before an owner endpoint, but not before changing it (RenewsResident)', async () => {
    const { db, close } = chatDatabase()
    closes.push(close)
    const authority = new CountingResident(db)
    const events = partial<Events['Service']>({ disableServer: () => Effect.void })
    const { fetch } = serve(
      OwnerHttp.serve(API, RESIDENT).pipe(
        Layer.provide(
          Layer.mergeAll(
            ResidentLive.pipe(Layer.provide(sqliteDb(db))),
            Layer.succeed(LegacyResident, authority),
            Layer.succeed(Events, events),
            plans(),
          ),
        ),
      ),
    )
    expect((await fetch(new Request('https://agent/api/agent/resident'))).status).toBe(200)
    const renewed = authority.renewals.length
    expect(renewed).toBeGreaterThan(0)
    const revoked = await fetch(json('POST', '/api/agent/resident', { enabled: false }))
    expect(revoked.status).toBe(200)
    expect(await revoked.json()).toMatchObject({ state: 'revoked' })
    expect(authority.renewals).toHaveLength(renewed)
  })
})
