import * as Context from 'effect/Context'
import * as Layer from 'effect/Layer'

/** Where the owner approves a waiting spend: the wallet app's `/approve/:operationId` page. */
export class Approvals extends Context.Service<Approvals, { readonly urlFor: (operationId: string) => string }>()(
  'goblin/wallet/Approvals',
) {}

export const approvalsLayer = (origin: string): Layer.Layer<Approvals> =>
  Layer.succeed(Approvals, { urlFor: (operationId) => `${origin}/approve/${encodeURIComponent(operationId)}` })
