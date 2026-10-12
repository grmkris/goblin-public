/**
 * The chains Goblin Wallet knows: mainnets, the testnets that mirror them, and the MetaMask Delegation Framework
 * deployment on each. Every address here was read back from the chain (packages/wallet/AGENTS.md, "Verified").
 */

export type Address = `0x${string}`

/** The EIP-712 domain of a token that takes EIP-3009 `transferWithAuthorization` (x402's `exact` scheme). */
export interface Eip3009Domain {
  readonly name: string
  readonly version: string
}

export interface StableToken {
  readonly symbol: string
  readonly address: Address
  readonly decimals: number
  /** Present only where the token implements EIP-3009; null for TIP-20 tokens on Tempo. */
  readonly eip3009: Eip3009Domain | null
}

/** MetaMask Delegation Framework v1.3.0: the same CREATE2 addresses on every chain listed here. */
export interface DelegationFramework {
  readonly manager: Address
  /** EIP7702StatelessDeleGatorImpl. */
  readonly delegator: Address
  readonly enforcers: {
    readonly erc20TransferAmount: Address
    readonly erc20PeriodTransfer: Address
    readonly allowedCalldata: Address
    readonly valueLte: Address
    readonly allowedTargets: Address
    readonly allowedMethods: Address
    readonly limitedCalls: Address
    readonly timestamp: Address
  }
}

export interface Chain {
  readonly id: number
  readonly caip2: string
  readonly name: string
  readonly testnet: boolean
  readonly explorerUrl: string
  readonly rpcUrl: string
  /** The USD stablecoin the wallet settles in on this chain. */
  readonly usdc: StableToken
  readonly delegation: DelegationFramework
}

const DELEGATION_FRAMEWORK_V1_3_0: DelegationFramework = {
  manager: '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3',
  delegator: '0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B',
  enforcers: {
    erc20TransferAmount: '0xf100b0819427117EcF76Ed94B358B1A5b5C6D2Fc',
    erc20PeriodTransfer: '0x474e3Ae7E169e940607cC624Da8A15Eb120139aB',
    allowedCalldata: '0xc2b0d624c1c4319760C96503BA27C347F3260f55',
    valueLte: '0x92Bf12322527cAA612fd31a0e810472BBB106A8F',
    allowedTargets: '0x7F20f61b1f09b08D970938F6fa563634d65c4EeB',
    allowedMethods: '0x2c21fD0Cb9DC8445CB3fb0DC5E7Bb0Aca01842B5',
    limitedCalls: '0x04658B29F6b82ed55274221a06Fc97D318E25416',
    timestamp: '0x1046bb45C8d673d4ea75321280DB34899413c069',
  },
}

const usdCoin = (address: Address): StableToken => ({
  symbol: 'USDC',
  address,
  decimals: 6,
  eip3009: { name: 'USD Coin', version: '2' },
})

/** Circle's testnet deployments report the name "USDC" rather than "USD Coin" (Base Sepolia, Sepolia). */
const testnetUsdc = (address: Address): StableToken => ({
  symbol: 'USDC',
  address,
  decimals: 6,
  eip3009: { name: 'USDC', version: '2' },
})

const chain = (spec: Omit<Chain, 'caip2' | 'delegation'>): Chain => ({
  ...spec,
  caip2: `eip155:${spec.id}`,
  delegation: DELEGATION_FRAMEWORK_V1_3_0,
})

export const BASE = chain({
  id: 8453,
  name: 'Base',
  testnet: false,
  explorerUrl: 'https://basescan.org',
  rpcUrl: 'https://mainnet.base.org',
  usdc: usdCoin('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
})
export const ETHEREUM = chain({
  id: 1,
  name: 'Ethereum',
  testnet: false,
  explorerUrl: 'https://etherscan.io',
  rpcUrl: 'https://ethereum-rpc.publicnode.com',
  usdc: usdCoin('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'),
})
export const ARBITRUM = chain({
  id: 42161,
  name: 'Arbitrum One',
  testnet: false,
  explorerUrl: 'https://arbiscan.io',
  rpcUrl: 'https://arb1.arbitrum.io/rpc',
  usdc: usdCoin('0xaf88d065e77c8cC2239327C5EDb3A432268e5831'),
})
/** Tempo's TIP-20 USDC.e (Stargate bridged): no EIP-3009, so x402 `exact` does not run here; Tempo has its own rail. */
export const TEMPO = chain({
  id: 4217,
  name: 'Tempo',
  testnet: false,
  explorerUrl: 'https://explore.tempo.xyz',
  rpcUrl: 'https://rpc.tempo.xyz',
  usdc: { symbol: 'USDC.e', address: '0x20C000000000000000000000b9537d11c60E8b50', decimals: 6, eip3009: null },
})
export const BASE_SEPOLIA = chain({
  id: 84532,
  name: 'Base Sepolia',
  testnet: true,
  explorerUrl: 'https://sepolia.basescan.org',
  rpcUrl: 'https://sepolia.base.org',
  usdc: testnetUsdc('0x036CbD53842c5426634e7929541eC2318f3dCF7e'),
})
export const SEPOLIA = chain({
  id: 11155111,
  name: 'Sepolia',
  testnet: true,
  explorerUrl: 'https://sepolia.etherscan.io',
  rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
  usdc: testnetUsdc('0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'),
})
export const ARBITRUM_SEPOLIA = chain({
  id: 421614,
  name: 'Arbitrum Sepolia',
  testnet: true,
  explorerUrl: 'https://sepolia.arbiscan.io',
  rpcUrl: 'https://sepolia-rollup.arbitrum.io/rpc',
  usdc: usdCoin('0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d'),
})
/** Tempo's testnet has no USDC; its stablecoin is the TIP-20 pathUSD. */
export const TEMPO_MODERATO = chain({
  id: 42431,
  name: 'Tempo Moderato',
  testnet: true,
  explorerUrl: 'https://explore.moderato.tempo.xyz',
  rpcUrl: 'https://rpc.moderato.tempo.xyz',
  usdc: { symbol: 'pathUSD', address: '0x20c0000000000000000000000000000000000000', decimals: 6, eip3009: null },
})

export const CHAINS: readonly Chain[] = [
  BASE,
  ETHEREUM,
  ARBITRUM,
  TEMPO,
  BASE_SEPOLIA,
  SEPOLIA,
  ARBITRUM_SEPOLIA,
  TEMPO_MODERATO,
]

export const chainById = (id: number): Chain | undefined => CHAINS.find((candidate) => candidate.id === id)

/** A chain by its CAIP-2 id ("eip155:8453"), the form x402 and the wallet contract use. */
export const chainByCaip2 = (caip2: string): Chain | undefined => CHAINS.find((candidate) => candidate.caip2 === caip2)

/** The chains a wallet operation names (the contract's `ChainKey`). */
export type ChainKey = 'base' | 'ethereum' | 'arbitrum' | 'tempo'

const MAINNETS: Readonly<Record<ChainKey, Chain>> = { base: BASE, ethereum: ETHEREUM, arbitrum: ARBITRUM, tempo: TEMPO }
const TESTNETS: Readonly<Record<ChainKey, Chain>> = {
  base: BASE_SEPOLIA,
  ethereum: SEPOLIA,
  arbitrum: ARBITRUM_SEPOLIA,
  tempo: TEMPO_MODERATO,
}

/** The chain a key names: the mainnet when the wallet is live (`WALLET_LIVE=1`), its testnet otherwise. */
export const chainByKey = (key: ChainKey, live: boolean): Chain => (live ? MAINNETS : TESTNETS)[key]
