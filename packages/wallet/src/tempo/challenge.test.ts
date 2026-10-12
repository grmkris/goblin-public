import { createClient, custom, keccak256, stringToHex } from 'viem'
import { tempo as tempoChain } from 'viem/chains'
import { describe, expect, test } from 'vitest'
import { TEMPO } from '../chains/index.ts'
import { b64url, fakeAgent, fakeNode, local, RECIPIENT, sentTransaction } from './fixtures.ts'
import { confirmReceipt, readChallenge, signChallenge } from './index.ts'

const NOW = new Date()
const LATER = new Date(NOW.getTime() + 240_000).toISOString()
const PATH_USD = '0x20c0000000000000000000000000000000000000'

const entry = (id: string, fields: { intent?: string; currency?: string; amount?: string; extra?: string } = {}) => {
  const request = {
    amount: fields.amount ?? '750',
    currency: fields.currency ?? TEMPO.usdc.address.toLowerCase(),
    methodDetails: { chainId: 4217, feePayer: true },
    recipient: RECIPIENT,
  }
  return `Payment id="${id}", realm="openrouter.mpp.tempo.xyz", method="tempo", intent="${fields.intent ?? 'charge'}", request="${b64url(request)}", expires="${LATER}"${fields.extra ?? ''}`
}

/** OpenRouter's shape: a pathUSD charge first, then the USDC.e charge, then a session. */
const HEADER = [
  entry('path-usd', { currency: PATH_USD }),
  entry('usdc-e'),
  entry('session', { intent: 'session' }),
].join(', ')

describe('reading a challenge', () => {
  test("picks the Tempo USDC.e charge among a header's entries, whatever their order", () => {
    expect(readChallenge(HEADER, NOW)).toMatchObject({
      challengeId: 'usdc-e',
      amountUsd: '0.00075',
      expiresAt: LATER,
      terms: { recipient: RECIPIENT, amount: '750', asset: TEMPO.usdc.address },
    })
  })

  test('refuses a header with no USDC.e charge, an expired one, one with no expiry and another credential header', () => {
    const code = (header: string) => {
      try {
        readChallenge(header, NOW)
      } catch (error) {
        // expected: the test reads the refusal itself.
        return error
      }
      return 'read'
    }
    expect(code(entry('p', { currency: PATH_USD }))).toMatchObject({ code: 'bad_challenge' })
    expect(code(entry('s', { intent: 'session' }))).toMatchObject({ code: 'bad_challenge' })
    expect(code('Bearer realm="x"')).toMatchObject({ code: 'bad_challenge' })
    expect(code(entry('h', { extra: ', header="X-Payment"' }))).toMatchObject({ code: 'bad_challenge' })
    expect(code(entry('e').replace(LATER, new Date(NOW.getTime() - 1000).toISOString()))).toMatchObject({
      code: 'challenge_expired',
    })
    expect(code(entry('n').replace(`, expires="${LATER}"`, ''))).toMatchObject({ code: 'challenge_expired' })
  })
})

describe('signing a challenge', () => {
  const sign = (overrides: { challengeId?: string; recipient?: string; amount?: bigint } = {}) => {
    const { agent, signed } = fakeAgent()
    const credential = signChallenge({
      header: HEADER,
      challengeId: overrides.challengeId ?? 'usdc-e',
      recipient: overrides.recipient ?? RECIPIENT,
      amount: overrides.amount ?? 750n,
      agent,
      operationKey: 'op-challenge-0001',
      client: fakeNode().client,
    })
    return { credential, signed }
  }

  test('returns the token after `Payment `: the frozen challenge, paid by the agent in the sponsored form', async () => {
    const { credential, signed } = sign()
    const token = await credential
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/u)
    expect(signed).toHaveLength(1)
    expect(signed[0]?.fee_payer_signature).toBeDefined()
    const sent = sentTransaction(`Payment ${token}`)
    expect(sent.from?.toLowerCase()).toBe(local.address.toLowerCase())
    expect(sent.feePayerSignature).toBeNull()
    expect(sent.calls).toHaveLength(1)
    expect(sent.calls[0]?.data?.slice(34, 74).toLowerCase()).toBe(RECIPIENT.slice(2).toLowerCase())
  })

  test('refuses a challenge other than the frozen one before anything is signed', async () => {
    const changed = [
      sign({ challengeId: 'path-usd' }),
      sign({ recipient: '0x0000000000000000000000000000000000000001' }),
      sign({ amount: 749n }),
    ]
    for (const { credential, signed } of changed) {
      await expect(credential).rejects.toMatchObject({ code: 'terms_changed' })
      expect(signed).toHaveLength(0)
    }
  })
})

const TX = `0x${'ab'.repeat(32)}`
const TRANSFER_WITH_MEMO = '0x57bc7354aa85aed339e000bccffabbc529466af35f0772c8f8ee1145927de7f0'
const word = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, '0')}`
const memoOf = (challengeId: string) =>
  `0xef1ed71201${'00'.repeat(20)}${keccak256(stringToHex(challengeId)).slice(2, 16)}`

const nodeWith = (log: { from?: string; amount?: bigint; memo?: string } | 'missing', status = '0x1') =>
  createClient({
    chain: tempoChain,
    transport: custom({
      request: async ({ method }: { method: string }) => {
        if (method !== 'eth_getTransactionReceipt') throw new Error(`unexpected ${method}`)
        if (log === 'missing') return null
        return {
          transactionHash: TX,
          status,
          blockNumber: '0x1',
          blockHash: `0x${'33'.repeat(32)}`,
          transactionIndex: '0x0',
          from: local.address,
          to: TEMPO.usdc.address,
          cumulativeGasUsed: '0x1',
          gasUsed: '0x1',
          effectiveGasPrice: '0x1',
          logsBloom: `0x${'00'.repeat(256)}`,
          type: '0x76',
          contractAddress: null,
          logs: [
            {
              address: TEMPO.usdc.address.toLowerCase(),
              topics: [
                TRANSFER_WITH_MEMO,
                word(log.from ?? local.address),
                word(RECIPIENT),
                log.memo ?? memoOf('usdc-e'),
              ],
              data: `0x${(log.amount ?? 750n).toString(16).padStart(64, '0')}`,
              blockNumber: '0x1',
              blockHash: `0x${'33'.repeat(32)}`,
              transactionHash: TX,
              transactionIndex: '0x0',
              logIndex: '0x0',
              removed: false,
            },
          ],
        }
      },
    }),
  })

const tempoReceipt = (fields: { method?: string; reference?: string } = {}) =>
  b64url({
    method: fields.method ?? 'tempo',
    reference: fields.reference ?? TX,
    status: 'success',
    timestamp: '2026-10-12T12:51:24.774Z',
  })

const check = (client: ReturnType<typeof nodeWith>, receipt = tempoReceipt()) =>
  confirmReceipt({ receipt, agent: local.address, recipient: RECIPIENT, amount: 750n, challengeId: 'usdc-e', client })

describe('confirming a reported receipt', () => {
  test("is paid when the chain shows the agent's transfer under this challenge's memo", async () => {
    expect(await check(nodeWith({}))).toMatchObject({ kind: 'paid', payment: { rail: 'mpp', txHash: TX } })
  })

  test('is unknown while the node does not show the transaction', async () => {
    expect((await check(nodeWith('missing'))).kind).toBe('unknown')
  })

  test("is a mismatch for another challenge's memo, another amount or sender, a revert or a foreign receipt", async () => {
    const mismatches = [
      check(nodeWith({ memo: memoOf('another-challenge') })),
      check(nodeWith({ amount: 749n })),
      check(nodeWith({ from: RECIPIENT })),
      check(nodeWith({}, '0x0')),
      check(nodeWith({}), tempoReceipt({ method: 'stripe' })),
      check(nodeWith({}), tempoReceipt({ reference: 'pi_123' })),
      check(nodeWith({}), 'not a receipt'),
    ]
    for (const finding of await Promise.all(mismatches)) expect(finding.kind).toBe('mismatch')
  })
})
