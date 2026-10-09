import { AccountApi, OwnerApi } from '@goblin/contracts/api'
import type * as HttpClientRequest from 'effect/http/HttpClientRequest'
import * as HttpApiClient from 'effect/http-api/HttpApiClient'
import { makeApiQuery } from './query/api-query.ts'
import { crashReporter } from './query/crash-report.ts'

/** A short id for one request: what a failure quotes when no answer came back. */
const requestId = (): string => crypto.randomUUID().replaceAll('-', '').slice(0, 8)

/**
 * What every API request carries: a fresh `x-goblin-request` id, the CSRF header on every write, and the operation a
 * write runs as (`withOperation`).
 */
const apiHeaders = (
  request: HttpClientRequest.HttpClientRequest,
  operation: string | undefined,
): Readonly<Record<string, string>> => ({
  'x-goblin-request': requestId(),
  ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { 'x-goblin-csrf': '1' }),
  ...(operation === undefined ? {} : { 'x-goblin-operation': operation }),
})

/** The owner's API, served by their own agent: same-origin, with the session cookie. */
export const owner = makeApiQuery({ id: 'goblin/OwnerApi', client: HttpApiClient.make(OwnerApi), headers: apiHeaders })
/** The account's own API, answered by the Worker without waking the agent: billing, inbound clients, crash reports. */
export const account = makeApiQuery({
  id: 'goblin/AccountApi',
  client: HttpApiClient.make(AccountApi),
  headers: apiHeaders,
})

/** Reports a crash nothing on the page caught (`crash-report.ts`) to `POST /api/client-errors`. */
export const reportCrash = crashReporter((report) => {
  account
    .run((api) => api.clientErrors.report({ payload: report }))
    .catch(() => {
      // expected: a report that cannot be sent is dropped; it must never become another crash.
    })
})
