import { createApi } from './api/index.ts'
import type { WalletEnv } from './env.ts'
import { identityFor } from './identity.ts'
import { oauthAuthenticator } from './mcp/oauth-auth.ts'
import { createMcpEndpoint } from './mcp/handler.ts'
import { productionMerchant } from './merchant/production.ts'
import { createMerchantApi } from './merchant/routes.ts'
import { authStore, handleOAuth } from './oauth/index.ts'
import { createRouter } from './router.ts'
import { productionWiring } from './wiring.ts'

export { WalletLedger } from './ledger/durable.ts'
export { WalletAuth } from './oauth/index.ts'

const route = createRouter({
  oauth: handleOAuth,
  api: createApi({ identity: identityFor, auth: (env) => authStore(env.AUTH), wiring: productionWiring }),
  merchant: createMerchantApi(productionMerchant),
  mcp: createMcpEndpoint({ authenticate: oauthAuthenticator, wiring: productionWiring }),
})

export default {
  fetch: route,
} satisfies ExportedHandler<WalletEnv>
