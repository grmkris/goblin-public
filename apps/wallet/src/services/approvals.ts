import * as Context from 'effect/Context'
import * as Layer from 'effect/Layer'

/**
 * Where the owner acts on the wallet: its app (`site`), whose `/approve/:operationId` page is where a waiting spend is
 * approved.
 */
export class Approvals extends Context.Service<
  Approvals,
  { readonly site: string; readonly urlFor: (operationId: string) => string }
>()('goblin/wallet/Approvals') {}

export const approvalsLayer = (origin: string): Layer.Layer<Approvals> =>
  Layer.succeed(Approvals, {
    site: origin,
    urlFor: (operationId) => `${origin}/approve/${encodeURIComponent(operationId)}`,
  })
