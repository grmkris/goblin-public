import { describe, expect, test } from 'vitest'
import { defaultWiring, unconfiguredRails } from '../../context.ts'
import { LedgerObject } from '../../ledger/durable.ts'
import { alarmHost, T0 } from '../../ledger/fixtures.ts'
import { FUNDS_SHORT, REFILLING } from '../../rails/challenge.ts'
import type { RailsPort } from '../../services/rails.ts'
import { testEnv } from '../../test-env.ts'
import { type McpAuthenticator } from '../auth.ts'
import { createMcpEndpoint } from '../handler.ts'

const authenticate: McpAuthenticator = () =>
  Promise.resolve({
    ownerUserId: 'did:privy:owner1',
    clientId: 'c1',
    clientName: 'goblin',
    scopes: ['wallet:read', 'wallet:spend'],
    token: 'good',
  })

/** Rails that refuse every challenge for want of USDC.e: refilling for `refill`, plain for the rest. */
const rails: RailsPort = {
  ...unconfiguredRails,
  allowances: () => Promise.resolve([]),
  payChallenge: (_operation, _challenge, challengeId) =>
    Promise.resolve({
      outcome: 'failed',
      reason: challengeId === 'refill' ? REFILLING : `${FUNDS_SHORT} 0 USDC.e on Tempo; this payment needs 0.00075.`,
    }),
}

const ledger = new LedgerObject(alarmHost(), () => Date.now())
const endpoint = createMcpEndpoint({
  authenticate,
  wiring: { ...defaultWiring, ledger: () => ledger, rails: () => rails },
})

const challenge = (id: string) => {
  const request = Buffer.from(
    JSON.stringify({
      amount: '750',
      currency: '0x20c000000000000000000000b9537d11c60e8b50',
      methodDetails: { chainId: 4217, feePayer: true },
      recipient: '0xca4e835F803cB0b7C428222B3A3B98518d4779Fe',
    }),
  ).toString('base64url')
  const expires = new Date(Date.now() + 240_000).toISOString()
  return `Payment id="${id}", realm="openrouter.mpp.tempo.xyz", method="tempo", intent="charge", request="${request}", expires="${expires}"`
}

const pay = async (id: string) => {
  const response = await endpoint(
    new Request('https://wallet.test/mcp', {
      method: 'POST',
      headers: {
        host: 'wallet.test',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer good',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'pay_challenge',
          arguments: {
            url: 'https://openrouter.mpp.tempo.xyz/v1/chat/completions',
            method: 'POST',
            challenge: challenge(id),
            max_usd: '0.02',
            operation_id: `op-float-${id}-${T0}`,
          },
        },
      }),
    }),
    testEnv(),
  )
  const body = await response.text()
  const data = body.startsWith('event:')
    ? (body.split('\n').find((line) => line.startsWith('data:')) ?? '').slice(5)
    : body
  const parsed: unknown = JSON.parse(data)
  return parsed
}

describe('pay_challenge short of USDC.e', () => {
  test('while the float refills it answers insufficient_funds with when to try again', async () => {
    expect(await pay('refill')).toMatchObject({
      result: {
        isError: true,
        content: [
          { text: expect.stringContaining('Refilling from your Base allowance; try again in about a minute.') },
        ],
        structuredContent: { error: { code: 'insufficient_funds', message: REFILLING, retryAfterSeconds: 60 } },
      },
    })
  })

  test('when nothing refills it, the answer is as before, with no retry time', async () => {
    const short = await pay('short')
    expect(short).toMatchObject({
      result: { isError: true, structuredContent: { error: { code: 'insufficient_funds' } } },
    })
    expect(JSON.stringify(short)).not.toContain('retryAfterSeconds')
  })
})
