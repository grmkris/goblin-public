import { OwnerApi } from '@goblin/contracts/api'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'

/** The `home` group's handlers, empty until lane D moves its Home reads here the way `topics/api.ts` does. */
export const HomeHandlers = HttpApiBuilder.group(OwnerApi, 'home', (handlers) => handlers)
