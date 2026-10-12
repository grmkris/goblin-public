import type { WalletEnv } from './env.ts'
import { apiError } from './http.ts'
import { createRouter } from './router.ts'

export { WalletLedger } from './ledger/durable.ts'

/** A singleton for OAuth state. Filled in by the OAuth lane. */
export class WalletAuth implements DurableObject {
  fetch(): Response {
    return apiError('not_found', 'The auth store has no routes yet.', 404)
  }
}

const notYet = (): Promise<Response> => Promise.resolve(apiError('not_found', 'No such route.', 404))

const route = createRouter({
  oauth: () => Promise.resolve(undefined),
  api: notYet,
  mcp: notYet,
})

export default {
  fetch: route,
} satisfies ExportedHandler<WalletEnv>
