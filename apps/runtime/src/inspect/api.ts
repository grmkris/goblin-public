import { OwnerApi } from '@goblin/contracts/api'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'

/** The `inspect` group's handlers, empty until lane O moves its inspection reads here the way `topics/api.ts` does. */
export const InspectHandlers = HttpApiBuilder.group(OwnerApi, 'inspect', (handlers) => handlers)
