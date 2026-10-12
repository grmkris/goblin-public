import type { Address, Hex } from 'viem'

const HEX = /^0x[0-9a-fA-F]*$/u
const ADDRESS = /^0x[0-9a-fA-F]{40}$/u

/** The contract types hex as `string`; viem wants `0x${string}`. These guards are the one door between them. */
export const toHex = (value: string): Hex => {
  if (!HEX.test(value)) throw new TypeError('not a hex string')
  // SAFETY: matched the 0x-hex pattern above.
  return value as Hex
}

export const toAddress = (value: string): Address => {
  if (!ADDRESS.test(value)) throw new TypeError('not an address')
  // SAFETY: matched the 40-hex-digit pattern above.
  return value as Address
}
