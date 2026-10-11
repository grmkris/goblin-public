import { OwnerApi } from '@goblin/contracts/api'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { Changes } from '../runtime/changes.ts'
import { Notices } from './service.ts'

/** The `notices` group (ADR 0041): the owner reads notifications in Activity, and the feed shows them read. */
export const NoticesHandlers = HttpApiBuilder.group(OwnerApi, 'notices', (handlers) =>
  handlers.handle('read', ({ payload }) =>
    Effect.gen(function* () {
      yield* (yield* Notices).read(payload.ids, yield* Clock.currentTimeMillis)
      yield* (yield* Changes).publish('notices.changed', { ids: payload.ids })
      return null
    }),
  ),
)
