import * as HttpApi from 'effect/http-api/HttpApi'
import { BillingGroup } from './billing.ts'
import { ClientErrorsGroup } from './client-errors.ts'
import { ClientsGroup } from './clients.ts'

/** What the Worker answers itself, without waking the agent: billing, inbound clients and client crash reports. */
export class AccountApi extends HttpApi.make('goblin-account')
  .add(BillingGroup, ClientsGroup, ClientErrorsGroup)
  .prefix('/api') {}
