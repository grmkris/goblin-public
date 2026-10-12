/** Test fakes for the Tempo rail: an agent that signs like Privy with a local key, a Tempo node, and 402 challenges. */
import { Credential } from 'mppx'
import { createClient, custom } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { tempo as tempoChain } from 'viem/chains'
import { Transaction } from 'viem/tempo'
import { toHex } from '../balances/hex.ts'
import { TEMPO } from '../chains/index.ts'
import type { TempoAgent, TempoTerms, TempoTransactionJson } from './account.ts'

/** viem signs a sponsored transaction locally in the fee-payer (`0x78`) form; Privy answers with `0x76` bytes. */
const isSponsorBytes = (raw: string): raw is `0x78${string}` => raw.startsWith('0x78')

export const local = privateKeyToAccount(generatePrivateKey())
export const RECIPIENT = '0xB98eF29eb2be19Ae646A8FC0248255B90A332dbC'
export const REQUEST = { method: 'POST', url: 'https://api.exa.ai/search', body: '{"query":"goblin"}' } as const
export const TERMS: TempoTerms = {
  network: 'eip155:4217',
  asset: TEMPO.usdc.address,
  recipient: RECIPIENT,
  amount: '7000',
}

export const b64url = (value: unknown) =>
  btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')

export const challengeHeader = (overrides: { amount?: string; recipient?: string; expires?: string } = {}) => {
  const request = {
    amount: overrides.amount ?? '7000',
    currency: TEMPO.usdc.address,
    methodDetails: { chainId: 4217, feePayer: true, supportedModes: ['pull'] },
    recipient: overrides.recipient ?? RECIPIENT,
  }
  const expires = overrides.expires ?? new Date(Date.now() + 240_000).toISOString()
  return `Payment id="abc123", realm="api.exa.ai", method="tempo", intent="charge", request="${b64url(request)}", expires="${expires}"`
}

/** An AgentSigner whose Tempo signing rebuilds the viem transaction from the JSON and signs it locally. */
export const fakeAgent = () => {
  const signed: TempoTransactionJson[] = []
  const agent: TempoAgent = {
    address: local.address,
    signTypedData: () => Promise.reject(new Error('not used')),
    signUserOperation: () => Promise.reject(new Error('not used')),
    signAuthorization: () => Promise.reject(new Error('not used')),
    signTempoTransaction: async ({ transaction }) => {
      signed.push(transaction)
      const placeholder = transaction.fee_payer_signature
      // SAFETY: the JSON rebuilds a viem Tempo transaction request; viem's account types do not model chain-specific types.
      const raw = await local.signTransaction(
        {
          type: 'tempo',
          chainId: transaction.chain_id,
          nonce: Number(BigInt(transaction.nonce)),
          nonceKey: BigInt(transaction.nonce_key),
          gas: BigInt(transaction.gas_limit),
          maxFeePerGas: BigInt(transaction.max_fee_per_gas),
          maxPriorityFeePerGas: BigInt(transaction.max_priority_fee_per_gas),
          calls: transaction.calls.map((call) => ({
            to: toHex(call.to),
            data: toHex(call.data),
            value: BigInt(call.value),
          })),
          ...(transaction.valid_before === undefined ? {} : { validBefore: Number(BigInt(transaction.valid_before)) }),
          ...(placeholder === undefined ? {} : { feePayer: true }),
          ...(transaction.fee_token === undefined ? {} : { feeToken: toHex(transaction.fee_token) }),
        } as never,
        { serializer: tempoChain.serializers?.transaction },
      )
      if (placeholder === undefined || !isSponsorBytes(raw)) return raw
      // Like Privy: the sender signs the sponsored payload and the bytes carry the fee-payer signature it was given.
      const { r, s, y_parity: yParity } = placeholder
      return Transaction.serialize({
        ...Transaction.deserialize(raw),
        feePayerSignature: { r: toHex(r), s: toHex(s), yParity },
      })
    },
  }
  return { agent, signed }
}

/** A fake Tempo node: fills transactions the way `eth_fillTransaction` does and accepts raw sends. */
export const fakeNode = () => {
  const sent: string[] = []
  const client = createClient({
    chain: tempoChain,
    transport: custom({
      request: async ({ method, params }: { method: string; params?: unknown }) => {
        const first: unknown = Array.isArray(params) ? params.at(0) : undefined
        switch (method) {
          case 'eth_chainId':
            return '0x1079'
          case 'eth_fillTransaction':
            return {
              tx: {
                ...(typeof first === 'object' && first !== null ? first : {}),
                type: '0x76',
                chainId: '0x1079',
                nonce: '0x0',
                gas: '0x30000',
                maxFeePerGas: '0x23c34600',
                maxPriorityFeePerGas: '0x0',
                hash: `0x${'11'.repeat(32)}`,
                input: '0x',
                value: '0x0',
              },
              raw: '0x',
            }
          case 'eth_sendRawTransactionSync':
            sent.push(String(first))
            return {
              transactionHash: `0x${'22'.repeat(32)}`,
              status: '0x1',
              blockNumber: '0x1',
              blockHash: `0x${'33'.repeat(32)}`,
              transactionIndex: '0x0',
              from: local.address,
              to: TEMPO.usdc.address,
              cumulativeGasUsed: '0x1',
              gasUsed: '0x1',
              effectiveGasPrice: '0x1',
              logs: [],
              logsBloom: `0x${'00'.repeat(256)}`,
              type: '0x76',
              contractAddress: null,
            }
          default:
            throw new Error(`unexpected ${method}`)
        }
      },
    }),
  })
  return { client, sent }
}

export const exaFetch = (header: string, paid: () => Response) => {
  const calls: { headers: Headers }[] = []
  const fn = async (_input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    calls.push({ headers })
    if (headers.has('authorization')) return paid()
    return new Response('{}', { status: 402, headers: { 'www-authenticate': header } })
  }
  return { fn, calls }
}

export const RECEIPT_TX = `0x${'ee'.repeat(32)}`
export const receipt = () =>
  b64url({ method: 'tempo', reference: RECEIPT_TX, status: 'success', timestamp: '2026-10-12T06:00:00Z' })

const isTempoBytes = (raw: string): raw is `0x76${string}` => raw.startsWith('0x76')

/** The Tempo transaction inside a `Payment <credential>` header value, as the service deserializes it. */
export const sentTransaction = (authorization: string) => {
  const { payload } = Credential.deserialize(authorization)
  const signature = typeof payload === 'object' && payload !== null && 'signature' in payload ? payload.signature : ''
  if (typeof signature !== 'string' || !isTempoBytes(signature))
    throw new Error('no Tempo transaction in the credential')
  return Transaction.deserialize(signature)
}
