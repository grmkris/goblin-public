import { OwnerApi } from '@goblin/contracts/api'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'

/** The `apps` group's handlers, empty until lane A moves its App RPC methods here the way `topics/api.ts` does. */
export const AppsHandlers = HttpApiBuilder.group(OwnerApi, 'apps', (handlers) => handlers)
