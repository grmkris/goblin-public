import { type HomeEditResult, HomeStale } from '@goblin/contracts'
import { OwnerApi } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { expectedFailure } from '../observability/report.ts'
import { editHomeLayout, readHomeLayout } from './program.ts'

type Answered = Exclude<HomeEditResult, { readonly kind: 'stale' }>

/**
 * The `home` group: the programs the agent's raw `/home` route ran before the typed API, as the owner. A stale edit is
 * the owner's view catching up, not a fault, so it is refused without being reported.
 */
export const HomeHandlers = HttpApiBuilder.group(OwnerApi, 'home', (handlers) =>
  handlers
    .handle('read', () => readHomeLayout)
    .handle('edit', ({ payload }) =>
      editHomeLayout(payload, 'owner').pipe(
        Effect.filterOrFail(
          (result): result is Answered => result.kind !== 'stale',
          (stale) => expectedFailure(new HomeStale({ kind: 'stale', layout: stale.layout }), 'skip'),
        ),
      ),
    ),
)
