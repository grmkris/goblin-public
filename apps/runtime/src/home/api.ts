import { HomeStale } from '@goblin/contracts'
import { OwnerApi } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { expectedFailure } from '../observability/report.ts'
import { editHomeLayout, readHomeLayout } from './program.ts'

/**
 * The `home` group: the programs the agent's raw `/home` route ran (`home/routes.ts`), as the owner. A stale edit is the
 * owner's view catching up, not a fault, so it is answered without being reported.
 */
export const HomeHandlers = HttpApiBuilder.group(OwnerApi, 'home', (handlers) =>
  handlers
    .handle('read', () => readHomeLayout)
    .handle('edit', ({ payload }) =>
      Effect.flatMap(editHomeLayout(payload, 'owner'), (result) =>
        result.kind === 'stale'
          ? Effect.fail(expectedFailure(new HomeStale({ kind: 'stale', layout: result.layout }), 'skip'))
          : Effect.succeed(result),
      ),
    ),
)
