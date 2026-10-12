/**
 * Brings the live Privy agent policy in line with `agentPolicy` (src/policy) and probes it.
 *
 *   bun packages/wallet/scripts/privy-policy.ts                 dry run: compare the live policy with the desired one
 *   bun packages/wallet/scripts/privy-policy.ts --apply         PATCH it, signed with the policy-admin key, then re-read
 *   bun packages/wallet/scripts/privy-policy.ts --probe         sign-only checks against the test agent wallet
 *   … --env <file>   the env file (default: .local/wallet-dev.env); --testnets adds the testnet chains
 *
 * The env file is read directly, never through the process environment: the shell may export another app's
 * PRIVY_APP_ID. Only ids, rule names, statuses and Privy's machine codes are printed; never a key or a secret.
 * Probes sign and never send: typed data and Tempo transactions are signed and dropped, and the one `eth_sendTransaction`
 * probe runs only while the agent wallet holds no ETH, so nothing can be broadcast.
 */
import { readFileSync } from 'node:fs'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import {
  ARBITRUM,
  ARBITRUM_SEPOLIA,
  BASE,
  BASE_SEPOLIA,
  ETHEREUM,
  SEPOLIA,
  TEMPO,
  TEMPO_MODERATO,
} from '../src/chains/index.ts'
import { BASE_ROUTES, agentPolicy, samePolicy, writablePolicy } from '../src/policy/index.ts'
import { PrivyClient, PrivyError, authorizationSigner, privyId, walletRpc } from '../src/privy/index.ts'

type Env = Readonly<Record<string, string>>

const readEnv = (file: string): Env =>
  Object.fromEntries(
    readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => /^([A-Z0-9_]+)=(.*)$/u.exec(line.trim()))
      .filter((match) => match !== null)
      .map((match) => [match[1] ?? '', match[2] ?? '']),
  )

const required = (env: Env, name: string): string => {
  const value = env[name]
  if (value === undefined || value === '') throw new Error(`missing ${name} in the env file`)
  return value
}

const args = process.argv.slice(2)
const flag = (name: string): boolean => args.includes(name)
const envFile = args[args.indexOf('--env') + 1] ?? ''
const env = readEnv(
  args.includes('--env') ? envFile : new URL('../../../.local/wallet-dev.env', import.meta.url).pathname,
)
const appId = required(env, 'PRIVY_APP_ID')
const appSecret = required(env, 'PRIVY_APP_SECRET')
const policyId = required(env, 'PRIVY_POLICY_ID')
const adminId = required(env, 'PRIVY_POLICY_ADMIN_ID')

const chains = flag('--testnets')
  ? [BASE, ETHEREUM, ARBITRUM, TEMPO, BASE_SEPOLIA, SEPOLIA, ARBITRUM_SEPOLIA, TEMPO_MODERATO]
  : [BASE, ETHEREUM, ARBITRUM, TEMPO]
const desired = agentPolicy({ ownerId: adminId, chains, routes: BASE_ROUTES })

const reader = new PrivyClient({ appId, appSecret })
const route = `/policies/${privyId(policyId)}`

const ruleNames = (policy: Record<string, unknown>): string[] =>
  (Array.isArray(policy['rules']) ? policy['rules'] : []).map((rule: { name?: unknown }) => String(rule.name))

const compare = async () => {
  const live = await reader.request('GET', route)
  if (live['id'] !== policyId || live['owner_id'] !== adminId)
    throw new Error('the live policy has another id or owner than the env file names; refusing')
  return { live, current: samePolicy(writablePolicy(live), desired) }
}

const apply = async () => {
  const before = await compare()
  if (before.current) return { policyId, status: 'current', rules: ruleNames(before.live) }
  const admin = new PrivyClient({
    appId,
    appSecret,
    authorize: await authorizationSigner(required(env, 'PRIVY_POLICY_ADMIN_KEY')),
  })
  await admin.request('PATCH', route, { name: desired.name, rules: desired.rules }, { signed: true })
  const after = await compare()
  if (!after.current) throw new Error('the policy still differs after the PATCH; inspect it before retrying')
  return { policyId, status: 'updated', before: ruleNames(before.live), after: ruleNames(after.live) }
}

const outcome = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run()
    return 'allowed'
  } catch (error) {
    if (error instanceof PrivyError) return `refused ${error.status} ${error.code}`
    throw error
  }
}

const transferData = (to: string, amount: bigint, selector = '0xa9059cbb', memo = ''): string =>
  `${selector}${to.slice(2).toLowerCase().padStart(64, '0')}${amount.toString(16).padStart(64, '0')}${memo}`

const decodeBalance = Schema.decodeUnknownOption(Schema.Struct({ result: Schema.String }))

/** The agent's ETH on Base; unknown reads as non-zero, so the send probes are skipped rather than risked. */
const ethBalance = async (address: string): Promise<bigint> => {
  const response = await fetch(BASE.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, 'latest'] }),
  })
  return BigInt(Option.getOrUndefined(decodeBalance(await response.json()))?.result ?? '0x1')
}

const TWA_TYPES = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
  ],
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
}

interface Probe {
  readonly run: (body: Record<string, unknown>) => () => Promise<unknown>
  readonly agent: string
  readonly payee: string
  readonly now: number
}

/** x402's EIP-3009 authorization on Base for `value` USDC base units; signed, never submitted. */
const typed = (probe: Probe, value: string) =>
  probe.run({
    method: 'eth_signTypedData_v4',
    params: {
      typed_data: {
        types: TWA_TYPES,
        primary_type: 'TransferWithAuthorization',
        domain: { name: 'USD Coin', version: '2', chainId: BASE.id, verifyingContract: BASE.usdc.address },
        message: {
          from: probe.agent,
          to: probe.payee,
          value,
          validAfter: '0',
          validBefore: String(probe.now + 300),
          nonce: `0x${'00'.repeat(31)}01`,
        },
      },
    },
  })

/**
 * A Tempo type-118 transaction, in the fee-token form (S3') or MPP's sponsored form (D4); signed, never sent. Privy
 * accepts `nonce_key` and `valid_before` but refuses `fee_payer: true` as invalid_data (probed 2026-10-12).
 */
const tempo = (probe: Probe, to: string, data: string, sponsored = false) =>
  probe.run({
    method: 'eth_signTransaction',
    params: {
      transaction: {
        type: 118,
        chain_id: TEMPO.id,
        nonce: '0x0',
        gas_limit: '0x493e0',
        max_fee_per_gas: '0x4a817c800',
        max_priority_fee_per_gas: '0x3b9aca00',
        calls: [{ to, value: '0x0', data }],
        ...(sponsored
          ? { nonce_key: `0x${'f'.repeat(64)}`, valid_before: `0x${(probe.now + 25).toString(16)}`, fee_payer: true }
          : { fee_token: TEMPO.usdc.address }),
      },
    },
  })

const MEMO = '0x95777d59'

const signProbes = async (probe: Probe): Promise<Record<string, string>> => ({
  'typed data 0.001 USDC on Base (expect allowed)': await outcome(typed(probe, '1000')),
  'typed data 6 USDC on Base (expect refused)': await outcome(typed(probe, '6000000')),
  'Tempo transfer 0.01 USDC.e (expect allowed)': await outcome(
    tempo(probe, TEMPO.usdc.address, transferData(probe.payee, 10_000n)),
  ),
  'Tempo transferWithMemo 0.01 USDC.e (expect allowed)': await outcome(
    tempo(probe, TEMPO.usdc.address, transferData(probe.payee, 10_000n, MEMO, '00'.repeat(32))),
  ),
  'Tempo sponsored (fee_payer) transferWithMemo (Privy answers invalid_data, 2026-10-12)': await outcome(
    tempo(probe, TEMPO.usdc.address, transferData(probe.payee, 10_000n, MEMO, '00'.repeat(32)), true),
  ),
  'Tempo transfer 6 USDC.e (expect refused)': await outcome(
    tempo(probe, TEMPO.usdc.address, transferData(probe.payee, 6_000_000n)),
  ),
  'Tempo transfer of another token (expect refused)': await outcome(
    tempo(probe, TEMPO_MODERATO.usdc.address, transferData(probe.payee, 10_000n)),
  ),
})

/**
 * Refusal probes for eth_sendTransaction, only while the agent holds no ETH (nothing can be broadcast). Privy appears
 * to simulate before it checks the policy, so a send that would revert answers transaction_broadcast_failure.
 */
const sendProbes = async (probe: Probe): Promise<Record<string, string>> => {
  if ((await ethBalance(probe.agent)) !== 0n)
    return { 'Base send probes': 'skipped: the agent wallet holds ETH, so a probe could broadcast' }
  const send = (to: string, data: string) =>
    probe.run({
      method: 'eth_sendTransaction',
      caip2: BASE.caip2,
      chain_type: 'ethereum',
      params: { transaction: { to, data, value: '0x0', chain_id: BASE.id } },
    })
  const approve = (spender: string, amount: bigint) => transferData(spender, amount, '0x095ea7b3')
  const lifi = BASE_ROUTES[0]?.address ?? ''
  return {
    'Base send to another contract (expect refused)': await outcome(send(BASE.delegation.delegator, '0x')),
    'Base USDC transfer 6 USDC (expect refused, or broadcast failure from the simulation)': await outcome(
      send(BASE.usdc.address, transferData(probe.payee, 6_000_000n)),
    ),
    'Base USDC approve 0.01 to LI.FI (expect allowed: broadcast_failure, no ETH for gas)': await outcome(
      send(BASE.usdc.address, approve(lifi, 10_000n)),
    ),
    'Base USDC approve 6 USDC to LI.FI (expect refused)': await outcome(
      send(BASE.usdc.address, approve(lifi, 6_000_000n)),
    ),
    'Base USDC approve 0.01 to another spender (expect refused)': await outcome(
      send(BASE.usdc.address, approve(probe.payee, 10_000n)),
    ),
  }
}

const probeAll = async () => {
  const signer = new PrivyClient({
    appId,
    appSecret,
    authorize: await authorizationSigner(required(env, 'PRIVY_AUTHORIZATION_KEY')),
  })
  const walletId = required(env, 'TEST_AGENT_WALLET_ID')
  const probe: Probe = {
    run: (body) => () => walletRpc(signer, walletId, body, `goblin-policy-probe-${crypto.randomUUID()}`),
    agent: required(env, 'TEST_AGENT_WALLET_ADDRESS'),
    payee: required(env, 'TREASURY_ADDRESS'),
    now: Math.floor(Date.now() / 1000),
  }
  return { walletId, results: { ...(await signProbes(probe)), ...(await sendProbes(probe)) } }
}

try {
  if (flag('--probe')) console.log(JSON.stringify(await probeAll(), null, 2))
  else if (flag('--apply')) console.log(JSON.stringify(await apply(), null, 2))
  else {
    const { live, current } = await compare()
    console.log(
      JSON.stringify(
        {
          policyId,
          status: current ? 'current' : 'differs',
          live: ruleNames(live),
          desired: desired.rules.map((rule) => rule.name),
        },
        null,
        2,
      ),
    )
  }
} catch (error) {
  // expected: the failure is printed as Privy's status and code only (never a body or a key), and the exit code set.
  console.error(
    error instanceof PrivyError ? error.message : error instanceof Error ? error.message : 'privy-policy failed',
  )
  process.exitCode = 1
}
