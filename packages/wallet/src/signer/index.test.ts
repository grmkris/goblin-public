import { recoverTypedDataAddress } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { describe, expect, test } from 'vitest'
import { BASE, BASE_SEPOLIA, TEMPO } from '../chains/index.ts'
import type { TypedDataJson } from '../contract/signer.ts'
import { PrivyClient, PrivyError, formatAuthorizationPayload } from '../privy/client.ts'
import { generateAuthorizationKey, verifiesDer } from '../privy/fixtures.ts'
import { authorizationSigner } from '../privy/p256.ts'
import { agentWalletKey, createAgentWallet } from '../privy/wallets.ts'
import { PrivyAgentSigner } from './index.ts'

interface Seen {
  readonly method: string
  readonly url: string
  readonly headers: Headers
  readonly body: unknown
}

type Handler = (seen: Seen) => Response | Promise<Response>

/** Privy's typed_data as the fake receives it. */
interface Received {
  readonly domain: Record<string, never>
  readonly types: Record<string, { name: string; type: string }[]>
  readonly primary_type: string
  readonly message: Record<string, unknown>
}

/** A fake Privy that records every call and answers with `handler`. */
const fakePrivy = async (handler: Handler) => {
  const key = await generateAuthorizationKey()
  const seen: Seen[] = []
  const fetchFn: typeof fetch = async (input, init) => {
    const call: Seen = {
      method: init?.method ?? 'GET',
      url: input instanceof Request ? input.url : input instanceof URL ? input.href : input,
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    }
    seen.push(call)
    return handler(call)
  }
  const client = new PrivyClient({
    appId: 'app-1',
    appSecret: 'secret-1',
    authorize: await authorizationSigner(key.privateKey),
    fetch: fetchFn,
    now: () => 1_700_000_000_000,
  })
  return { client, seen, publicKey: key.publicKey }
}

const AGENT = '0xD354C247817d233Ee0abDB9ffcDF356b5E6B274F'
const signerOf = (client: PrivyClient, live = true) =>
  new PrivyAgentSigner({ privy: client, walletId: 'wallet-1', address: AGENT, live })

const typedData = (chainId: number): TypedDataJson => ({
  domain: { name: 'USD Coin', version: '2', chainId, verifyingContract: BASE.usdc.address },
  types: {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  },
  primaryType: 'TransferWithAuthorization',
  message: {
    from: AGENT,
    to: '0xB98eF29eb2be19Ae646A8FC0248255B90A332dbC',
    value: '7000',
    validAfter: '0',
    validBefore: '1700000600',
    nonce: `0x${'ab'.repeat(32)}`,
  },
})

describe('the Privy client', () => {
  test('signed calls carry a P-256 signature over the canonical request and its privy headers', async () => {
    const privy = await fakePrivy(() => Response.json({ data: { signature: `0x${'1'.repeat(130)}` } }))
    await signerOf(privy.client).signTypedData({ chain: 'base', typedData: typedData(8453), operationKey: 'op-1:sign' })
    const [call] = privy.seen
    if (call === undefined) throw new Error('no call')
    expect(call.headers.get('authorization')).toBe(`Basic ${btoa('app-1:secret-1')}`)
    expect(call.headers.get('privy-idempotency-key')).toBe('op-1:sign')
    expect(call.headers.get('privy-request-expiry')).toBe('1700000060000')
    const payload = formatAuthorizationPayload({
      method: 'POST',
      url: call.url,
      body: call.body,
      headers: {
        'privy-app-id': 'app-1',
        'privy-request-expiry': '1700000060000',
        'privy-idempotency-key': 'op-1:sign',
      },
    })
    const signature = call.headers.get('privy-authorization-signature') ?? ''
    expect(await verifiesDer(privy.publicKey, payload, signature)).toBe(true)
  })

  test('refusals expose the status and a bounded code, never the body', async () => {
    const answers: readonly [Response, number, string][] = [
      [
        Response.json({ error: 'policy_violation', message: 'echo: secret-1 0xdead' }, { status: 400 }),
        400,
        'policy_violation',
      ],
      [Response.json({ error: 'a message with spaces and secret-1' }, { status: 401 }), 401, 'refused'],
      [new Response('<html>', { status: 502 }), 502, 'refused'],
    ]
    for (const [answer, status, code] of answers) {
      const privy = await fakePrivy(() => answer)
      // expected: the refusal is the value under test.
      const failure = await privy.client.request('GET', '/wallets/w1').catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(PrivyError)
      expect(failure).toMatchObject({ status, code })
      expect(String(failure)).not.toContain('secret-1')
    }
    const down = new PrivyClient({ appId: 'a', appSecret: 's', fetch: () => Promise.reject(new Error('net')) })
    await expect(down.request('GET', '/users/u')).rejects.toMatchObject({ status: 0, code: 'unavailable' })
    await expect(down.request('GET', '/users/../policies')).rejects.toMatchObject({ code: 'invalid_route' })
    const unset = new PrivyClient({ appId: 'a', appSecret: '' })
    await expect(unset.request('GET', '/users/u')).rejects.toMatchObject({ code: 'unconfigured' })
  })
})

describe('the agent wallet', () => {
  const authority = { userId: 'did:privy:owner1', signerId: 'signer-1', policyId: 'policy-1' }
  const wallet = (id: string, signers: unknown[]) => ({
    id,
    address: AGENT,
    chain_type: 'ethereum',
    owner_id: 'quorum-1',
    additional_signers: signers,
  })
  const ours = [{ signer_id: 'signer-1', override_policy_ids: ['policy-1'] }]

  test('an existing wallet held by our signer under the policy is reused, not created again', async () => {
    const privy = await fakePrivy(({ url }) =>
      url.includes('/key_quorums/')
        ? Response.json({ user_ids: ['did:privy:owner1'] })
        : Response.json({ data: [wallet('embedded', []), wallet('agent', ours)] }),
    )
    expect((await createAgentWallet(privy.client, authority)).id).toBe('agent')
    expect(privy.seen.map((call) => call.method)).toEqual(['GET', 'GET'])
    expect(privy.seen[0]?.url).toContain('user_id=did%3Aprivy%3Aowner1')
  })

  test('otherwise it is created once, owned by the user, with our signer and policy only', async () => {
    const privy = await fakePrivy(({ method, url }) =>
      method === 'POST'
        ? Response.json(wallet('created', ours))
        : url.includes('/key_quorums/')
          ? Response.json({ user_ids: ['did:privy:owner1'] })
          : Response.json({ data: [wallet('embedded', [])] }),
    )
    expect((await createAgentWallet(privy.client, authority)).id).toBe('created')
    const post = privy.seen.find((call) => call.method === 'POST')
    expect(post?.body).toEqual({
      chain_type: 'ethereum',
      owner: { user_id: 'did:privy:owner1' },
      additional_signers: [{ signer_id: 'signer-1', override_policy_ids: ['policy-1'] }],
    })
    expect(post?.headers.get('privy-idempotency-key')).toBe(agentWalletKey('did:privy:owner1'))
  })

  test('a wallet whose owner quorum is not the user alone is refused', async () => {
    const privy = await fakePrivy(({ url }) =>
      url.includes('/key_quorums/')
        ? Response.json({ user_ids: ['did:privy:owner1', 'did:privy:someone'] })
        : Response.json({ data: [wallet('agent', ours)] }),
    )
    await expect(createAgentWallet(privy.client, authority)).rejects.toMatchObject({
      code: 'wallet_authority_mismatch',
    })
  })
})

/** Privy's answer to eth_sign7702Authorization, with some fields overridden. */
const answer = (overrides: Record<string, unknown>) =>
  Response.json({
    data: {
      authorization: {
        contract: BASE.delegation.delegator,
        chain_id: 8453,
        nonce: 7,
        r: `0x${'5'.repeat(64)}`,
        s: `0x${'6'.repeat(64)}`,
        y_parity: 1,
        ...overrides,
      },
    },
  })

describe('the Privy agent signer', () => {
  test('typed data reaches Privy with its EIP712Domain type and means what the caller asked for', async () => {
    const account = privateKeyToAccount(generatePrivateKey())
    // The fake signs what it received, as Privy's wallet would: uint fields as bigints, the domain type dropped.
    const privy = await fakePrivy(async ({ body }) => {
      // SAFETY: the signer under test sent this body; the assertions below pin its shape.
      const sent = (body as { params: { typed_data: Received } }).params.typed_data
      const { EIP712Domain: _domainType, ...types } = sent.types
      const fields = types[sent.primary_type] ?? []
      const message = Object.fromEntries(
        fields.map(({ name, type }) => [
          name,
          type.startsWith('uint') ? BigInt(String(sent.message[name])) : sent.message[name],
        ]),
      )
      const signature = await account.signTypedData({
        domain: sent.domain,
        types,
        primaryType: sent.primary_type,
        message,
      })
      return Response.json({ data: { signature } })
    })
    const input = typedData(8453)
    const signature = await signerOf(privy.client).signTypedData({
      chain: 'base',
      typedData: input,
      operationKey: 'op-2',
    })
    expect(privy.seen[0]?.body).toMatchObject({
      method: 'eth_signTypedData_v4',
      params: {
        typed_data: {
          primary_type: 'TransferWithAuthorization',
          types: {
            EIP712Domain: [
              { name: 'name', type: 'string' },
              { name: 'version', type: 'string' },
              { name: 'chainId', type: 'uint256' },
              { name: 'verifyingContract', type: 'address' },
            ],
          },
        },
      },
    })
    const recovered = await recoverTypedDataAddress({
      domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: BASE.usdc.address },
      types: { TransferWithAuthorization: [...(input.types['TransferWithAuthorization'] ?? [])] },
      primaryType: 'TransferWithAuthorization',
      message: {
        from: AGENT,
        to: '0xB98eF29eb2be19Ae646A8FC0248255B90A332dbC',
        value: 7000n,
        validAfter: 0n,
        validBefore: 1_700_000_600n,
        nonce: `0x${'ab'.repeat(32)}`,
      },
      signature: `0x${signature.slice(2)}`,
    })
    expect(recovered).toBe(account.address)
  })

  test('a domain for another chain than the one named is refused before Privy is called', async () => {
    const privy = await fakePrivy(() => Response.json({ data: { signature: `0x${'3'.repeat(130)}` } }))
    await expect(
      signerOf(privy.client).signTypedData({ chain: 'base', typedData: typedData(1), operationKey: 'op-3' }),
    ).rejects.toMatchObject({ code: 'chain_mismatch' })
    // Testnet mode maps "base" to Base Sepolia.
    await signerOf(privy.client, false).signTypedData({
      chain: 'base',
      typedData: typedData(BASE_SEPOLIA.id),
      operationKey: 'op-4',
    })
    expect(privy.seen).toHaveLength(1)
  })

  test('signUserOperation asks Privy to sign for the DeleGator on the chain, in its snake-case form', async () => {
    const privy = await fakePrivy(() => Response.json({ data: { signature: `0x${'ab'.repeat(65)}` } }))
    const userOp = {
      sender: AGENT,
      nonce: 3n,
      callData: '0xcafe',
      callGasLimit: 10n,
      verificationGasLimit: 11n,
      preVerificationGas: 12n,
      maxFeePerGas: 13n,
      maxPriorityFeePerGas: 14n,
      signature: '0x',
    }
    const signature = await signerOf(privy.client).signUserOperation({ chain: 'base', userOp, operationKey: 'op-5' })
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/u)
    expect(privy.seen[0]?.body).toMatchObject({
      method: 'eth_signUserOperation',
      params: {
        contract: BASE.delegation.delegator,
        chain_id: '0x2105',
        user_operation: {
          sender: AGENT,
          nonce: '0x3',
          call_data: '0xcafe',
          call_gas_limit: '0xa',
          paymaster_data: '0x',
        },
      },
    })
  })

  test('7702 authorizations come back for exactly the contract, chain and nonce asked for', async () => {
    const input = { chain: 'base', contract: BASE.delegation.delegator, nonce: 7, operationKey: 'op-7' } as const
    const good = await fakePrivy(() => answer({}))
    expect(await signerOf(good.client).signAuthorization(input)).toEqual({
      address: BASE.delegation.delegator,
      chainId: 8453,
      nonce: 7,
      r: `0x${'5'.repeat(64)}`,
      s: `0x${'6'.repeat(64)}`,
      yParity: 1,
    })
    expect(good.seen[0]?.body).toEqual({
      method: 'eth_sign7702Authorization',
      params: { contract: BASE.delegation.delegator, chain_id: 8453, nonce: 7 },
    })
    for (const wrong of [{ nonce: 8 }, { chain_id: 1 }, { contract: AGENT }, { y_parity: 2 }]) {
      const privy = await fakePrivy(() => answer(wrong))
      await expect(signerOf(privy.client).signAuthorization(input)).rejects.toMatchObject({
        code: 'invalid_authorization_response',
      })
    }
  })

  test('Tempo transactions are signed through eth_signTransaction and must come back as 0x76 bytes', async () => {
    const transaction = {
      type: 118,
      chain_id: TEMPO.id,
      nonce: '0x0',
      nonce_key: '0x0',
      gas_limit: '0x30d40',
      max_fee_per_gas: '0x1',
      max_priority_fee_per_gas: '0x1',
      calls: [{ to: TEMPO.usdc.address, value: '0x0', data: '0xa9059cbb' }],
      fee_token: TEMPO.usdc.address,
    } as const
    const privy = await fakePrivy(() => Response.json({ data: { signed_transaction: '0x76f8aa', encoding: 'rlp' } }))
    expect(await signerOf(privy.client).signTempoTransaction({ operationKey: 'op-8', transaction })).toBe('0x76f8aa')
    expect(privy.seen[0]?.body).toEqual({ method: 'eth_signTransaction', params: { transaction } })
    await expect(
      signerOf(privy.client, false).signTempoTransaction({ operationKey: 'op-9', transaction }),
    ).rejects.toMatchObject({ code: 'chain_mismatch' })
    const wrong = await fakePrivy(() => Response.json({ data: { signed_transaction: '0x02f8aa' } }))
    await expect(
      signerOf(wrong.client).signTempoTransaction({ operationKey: 'op-10', transaction }),
    ).rejects.toMatchObject({ code: 'invalid_tempo_response' })
  })
})
