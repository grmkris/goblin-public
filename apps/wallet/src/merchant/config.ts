import type { WalletEnv } from '../env.ts'
import { returnUrl } from '../oauth/validation.ts'

/** The one merchant tonight: goblin, selling Pro (ADR 0054). */
export const GOBLIN_MERCHANT = 'goblin'

/** goblin's merchant settings on this deployment: its key, its collector and where its requests may return. */
export interface MerchantConfig {
  readonly key: string
  readonly collector: { readonly walletId: string; readonly address: string } | undefined
  readonly returnOrigins: readonly string[]
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/u

/** The origins in a comma-separated list, each as `URL.origin`; anything that is not a secure origin is dropped. */
const originsOf = (list: string): string[] =>
  list
    .split(',')
    .map((entry) => returnUrl(entry.trim()))
    .flatMap((url) => (url === undefined ? [] : [url.origin]))

export const merchantConfig = (env: WalletEnv): MerchantConfig => ({
  key: env.WALLET_MERCHANT_GOBLIN_KEY,
  collector:
    env.COLLECTOR_WALLET_ID !== '' && ADDRESS.test(env.COLLECTOR_ADDRESS)
      ? { walletId: env.COLLECTOR_WALLET_ID, address: env.COLLECTOR_ADDRESS }
      : undefined,
  returnOrigins: originsOf(env.MERCHANT_RETURN_ORIGINS),
})

/** Where a request may send the owner back: an HTTPS (or loopback) URL on one of the merchant's origins. */
export const allowedReturn = (config: MerchantConfig, value: string): URL | undefined => {
  const url = returnUrl(value)
  return url !== undefined && config.returnOrigins.includes(url.origin) ? url : undefined
}

const hex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')

const digest = async (text: string): Promise<string> =>
  hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))

/** Whether a request carries the merchant's bearer key; compared as SHA-256 digests, so the time says nothing. */
export const merchantAuthorized = async (config: MerchantConfig, request: Request): Promise<boolean> => {
  const header = request.headers.get('authorization') ?? ''
  if (config.key === '' || !header.startsWith('Bearer ')) return false
  const [given, expected] = await Promise.all([digest(header.slice('Bearer '.length)), digest(config.key)])
  return given === expected
}
