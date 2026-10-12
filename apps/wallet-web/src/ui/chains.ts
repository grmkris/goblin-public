import { ARBITRUM, BASE, ETHEREUM, TEMPO, type Chain } from '@goblin/wallet/chains'
import type { ChainKey } from '@goblin/wallet/contract'

const BY_KEY: Record<ChainKey, Chain> = { base: BASE, ethereum: ETHEREUM, arbitrum: ARBITRUM, tempo: TEMPO }

export const addressUrl = (key: ChainKey, address: string): string => `${BY_KEY[key].explorerUrl}/address/${address}`
export const txUrl = (key: ChainKey, hash: string): string => `${BY_KEY[key].explorerUrl}/tx/${hash}`
