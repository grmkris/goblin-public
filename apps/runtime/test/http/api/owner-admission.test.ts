import { ResidentGroup, ownerApiOf } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as HttpServer from 'effect/http/HttpServer'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { afterEach, describe, expect, it } from 'vitest'
import { OwnerAdmissionLive } from '../../../src/http/api/middleware.ts'
import { OwnerHttp } from '../../../src/http/api/server.ts'
import { ResidentLive } from '../../../src/layers/core.ts'
import { ResidentHandlers } from '../../../src/mcp/resident-api.ts'
import { Events, Resident } from '../../../src/mcp/service.ts'
import { chatDatabase } from '../../chats-sqlite.ts'
import { json, partial, plans, serve, sqliteDb } from './mcp-serve.ts'

const API = ownerApiOf(ResidentGroup)
const RESIDENT = HttpApiBuilder.layer(API).pipe(
  Layer.provide(ResidentHandlers),
  Layer.provide(OwnerAdmissionLive),
  Layer.provide(HttpServer.layerServices),
)

/** Resident authority on SQLite (lane M's layer), counting the renewals asked of it from outside. */
const countingResident = (db: ReturnType<typeof chatDatabase>['db'], renewals: number[]) =>
  Layer.effect(
    Resident,
    Effect.gen(function* () {
      const resident = yield* Resident
      return Resident.of({
        ...resident,
        renew: () =>
          Effect.andThen(
            Effect.sync(() => renewals.push(1)),
            resident.renew(),
          ),
      })
    }),
  ).pipe(Layer.provide(ResidentLive.pipe(Layer.provide(sqliteDb(db)))))

const closes: (() => void)[] = []
afterEach(() => {
  for (const close of closes.splice(0)) close()
})

describe('owner admission', () => {
  it('renews resident authority before an owner endpoint, but not before changing it (RenewsResident)', async () => {
    const { db, close } = chatDatabase()
    closes.push(close)
    const renewals: number[] = []
    const events = partial<Events['Service']>({ disableServer: () => Effect.void })
    const { fetch } = serve(
      OwnerHttp.serve(API, RESIDENT).pipe(
        Layer.provide(Layer.mergeAll(countingResident(db, renewals), Layer.succeed(Events, events), plans())),
      ),
    )
    expect((await fetch(new Request('https://agent/api/agent/resident'))).status).toBe(200)
    const renewed = renewals.length
    expect(renewed).toBeGreaterThan(0)
    const revoked = await fetch(json('POST', '/api/agent/resident', { enabled: false }))
    expect(revoked.status).toBe(200)
    expect(await revoked.json()).toMatchObject({ state: 'revoked' })
    expect(renewals).toHaveLength(renewed)
  })
})
