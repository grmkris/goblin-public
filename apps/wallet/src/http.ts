import type { WalletFailure } from './services/errors.ts'

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })

/** The `ApiError` envelope of the contract. */
export const apiError = (code: string, message: string, status: number, recovery?: string): Response =>
  json({ error: { code, message, ...(recovery === undefined ? {} : { recovery }) } }, status)

export const failureResponse = (failure: WalletFailure): Response =>
  apiError(failure.code, failure.message, failure.status, failure.recovery)
