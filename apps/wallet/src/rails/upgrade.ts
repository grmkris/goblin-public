import { formatUnits } from '@goblin/wallet/amounts'
import {
  authorizationSignedBy,
  delegationOf,
  type EvmChain,
  erc20Balance,
  type JsonRpc,
  pendingNonce,
  TransferError,
} from '@goblin/wallet/balances'
import { prepareUserOp, type PreparedUserOp, type SubmittedUserOp, submitUserOp } from '@goblin/wallet/bundler'
import { type Chain, chainByKey } from '@goblin/wallet/chains'
import {
  Address,
  ChainKey,
  Hex,
  type Operation,
  type Payment,
  type Terms,
  termsHash,
  type TypedDataJson,
  UpgradePrepare,
} from '@goblin/wallet/contract'
import { delegatorTypedData, UPGRADE_FEE_CEILINGS } from '@goblin/wallet/userop'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { failure } from '../services/errors.ts'
import type { PendingUpgrade, PreparedUpgrade } from '../services/rails.ts'
import type { RailsDeps } from './deps.ts'

/** How long a prepared upgrade can be signed: after that its gas price is stale and the owner prepares it again. */
const UPGRADE_TTL_MS = 300_000

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
const isEvm = (chain: ChainKey): chain is EvmChain => chain !== 'tempo'

/** Whether the owner's code delegates to this network's DeleGator; null when the chain could not be read. */
const delegated = (rpc: JsonRpc, owner: string, delegator: string): Promise<boolean | null> =>
  delegationOf(rpc, owner).then(
    (current) => current !== null && same(current, delegator),
    // expected: unreadable code is reported as unknown; the caller decides what that means.
    () => null,
  )

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Reads the owner's code until it shows the delegation: right after the receipt, a load-balanced node one block behind
 * still serves the old code, and an applied upgrade would be reported as skipped.
 */
const delegatedAfterReceipt = async (
  rpc: JsonRpc,
  owner: string,
  delegator: string,
  wait: RailsDeps['wait'],
): Promise<boolean | null> => {
  let last: boolean | null = null
  for (let attempt = 0; attempt < (wait?.attempts ?? 5); attempt += 1) {
    last = await delegated(rpc, owner, delegator)
    if (last === true) return true
    await (wait?.sleep ?? pause)(wait?.intervalMs ?? 1500)
  }
  return last
}

/** What every upgrade step needs: mainnet, an EVM chain, a bundler and the owner's address. */
const upgradeContext = async (key: ChainKey, deps: RailsDeps) => {
  if (!deps.live)
    throw failure('mainnet_only', 'Account upgrades run on mainnet only; this wallet is on testnets.', 409)
  if (!isEvm(key)) throw failure('unsupported', 'Tempo has no account upgrade; nothing to sign there.', 400)
  if (deps.bundlerFor === undefined)
    throw failure('not_configured', 'No bundler is configured on this deployment.', 501)
  const owner = (await deps.profile()).ownerAddress
  if (owner === undefined) throw failure('not_onboarded', 'The owner address is not known yet.', 409)
  return { key, owner, network: chainByKey(key, true), node: deps.rpcFor(key), bundler: deps.bundlerFor(key) }
}

/** The authorization must point the owner's own account at this network's DeleGator, on this chain only. */
const checkAuthorization = async (auth: UpgradePrepare['authorization'], network: Chain, owner: string) => {
  if (auth.chainId !== network.id)
    throw failure('bad_authorization', `The authorization is not for ${network.name}, the network this wallet runs on.`)
  if (!same(auth.address, network.delegation.delegator))
    throw failure('bad_authorization', 'The authorization delegates to another contract than the DeleGator.')
  const signer = await authorizationSignedBy(auth).catch(
    // expected: a malformed signature recovers to nobody and is refused below.
    () => undefined,
  )
  if (signer === undefined || !same(signer, owner))
    throw failure('bad_authorization', 'The authorization is not signed by your account.')
}

const noUsdc = (network: Chain) =>
  failure(
    'insufficient_funds',
    `Add USDC to your account on ${network.name} first: the upgrade's gas is paid in USDC from it.`,
    409,
  )

/** The bundler's refusals in the owner API's words; it not answering is a 502 to retry. */
export const prepared = async (prepare: () => Promise<PreparedUserOp>, network: Chain): Promise<PreparedUserOp> => {
  try {
    return await prepare()
  } catch (error) {
    if (!(error instanceof TransferError)) throw error
    if (error.code === 'insufficient_funds') throw noUsdc(network)
    if (error.code === 'rpc_unavailable')
      throw failure('bundler_unavailable', error.message.slice(0, 300), 502, 'Try again in a moment.')
    throw failure(error.code, error.message.slice(0, 300), 409)
  }
}

/** The upgrade as an operation: its gas, at most `maxFee` USDC, goes to the chain's paymaster. */
const termsOf = (key: EvmChain, network: Chain, maxFee: bigint, expiresAt: string): Terms => ({
  kind: 'upgrade',
  chain: key,
  rail: 'userop',
  subject: 'EIP-7702 account upgrade',
  token: { symbol: network.usdc.symbol, address: network.usdc.address, decimals: network.usdc.decimals },
  amount: formatUnits(maxFee, network.usdc.decimals),
  amountUsd: formatUnits(maxFee, network.usdc.decimals),
  recipient: network.aa?.paymaster ?? network.usdc.address,
  expiresAt,
})

const operationOf = async (id: string, terms: Terms, createdAt: string) => ({
  id,
  terms,
  termsHash: await termsHash(terms),
  limitsVersion: 0,
  createdAt,
})

/** The DeleGator's typed data over the operation as JSON: its two bigints as decimal strings, as Privy takes them. */
export const typedDataOf = (op: PreparedUserOp, network: Chain): TypedDataJson => {
  const typed = delegatorTypedData(op.op, network, op.entryPoint)
  return {
    ...typed,
    message: {
      ...typed.message,
      nonce: typed.message.nonce.toString(),
      preVerificationGas: typed.message.preVerificationGas.toString(),
    },
  }
}

/**
 * Prepares the owner's EIP-7702 upgrade as a UserOperation from their own address, carrying their authorization, whose
 * gas Pimlico's paymaster takes in their USDC. The authorization must be theirs, for this chain's DeleGator, at their
 * account's pending nonce; their USDC must cover the most the gas may cost. An account that already delegates to the
 * DeleGator (a re-run of onboarding) is confirmed with nothing to sign. Signs and sends nothing.
 */
export const prepareUpgrade = async (request: UpgradePrepare, deps: RailsDeps): Promise<PreparedUpgrade> => {
  const { key, owner, network, node, bundler } = await upgradeContext(request.chain, deps)
  await checkAuthorization(request.authorization, network, owner)
  const now = (deps.now ?? (() => new Date()))()
  const expiresAt = new Date(now.getTime() + UPGRADE_TTL_MS).toISOString()
  if ((await delegated(node, owner, network.delegation.delegator)) === true) {
    const id = `upgrade:${key}:${owner.toLowerCase()}:${request.authorization.nonce}`
    const base = await operationOf(id, termsOf(key, network, 0n, expiresAt), now.toISOString())
    const operation: Operation = {
      ...base,
      status: 'confirmed',
      updatedAt: now.toISOString(),
      payment: { rail: 'userop' },
    }
    return { kind: 'upgraded', operation }
  }
  const [current, held] = await Promise.all([
    pendingNonce(node, owner),
    erc20Balance(node, network.usdc.address, owner),
  ])
  if (BigInt(request.authorization.nonce) !== current)
    throw failure(
      'stale_authorization',
      `The authorization names account nonce ${request.authorization.nonce}, but your account is at ${current}; sign it again.`,
      409,
    )
  // Without any USDC the bundler cannot even estimate the operation; say so before asking it.
  if (held === 0n) throw noUsdc(network)
  const input = { chain: network, node, bundler, sender: owner, calls: [], authorization: request.authorization }
  const op = await prepared(() => prepareUserOp({ ...input, feeCeiling: UPGRADE_FEE_CEILINGS[key] }), network)
  if (held < op.feeBound)
    throw failure(
      'insufficient_funds',
      `The upgrade's gas costs up to ${formatUnits(op.feeBound, 6)} USDC from your account on ${network.name}, which holds ${formatUnits(held, 6)} USDC. Add USDC there first.`,
      409,
    )
  const upgradeId = `upgrade:${key}:${crypto.randomUUID()}`
  const pending = { upgradeId, chain: key, prepared: op, createdAt: now.toISOString(), expiresAt }
  return { kind: 'draft', pending, typedData: typedDataOf(op, network), maxFeeUsdc: formatUnits(op.feeBound, 6) }
}

/**
 * Sends the owner's signed upgrade to the bundler and reports it as an operation. `confirmed` means the owner's code
 * now delegates to this network's DeleGator, read back from the chain; one still in flight is `submitted`; one the
 * bundler refused (nothing was sent), or that landed without the delegation, is `failed`. A repeated confirm of an
 * upgrade that already landed is confirmed without sending again.
 */
export const confirmUpgrade = async (
  pending: PendingUpgrade,
  signature: string,
  deps: RailsDeps,
): Promise<Operation> => {
  const { key, owner, network, node, bundler } = await upgradeContext(pending.chain, deps)
  const now = (deps.now ?? (() => new Date()))().toISOString()
  const terms = termsOf(key, network, pending.prepared.feeBound, pending.expiresAt)
  const base = await operationOf(pending.upgradeId, terms, pending.createdAt)
  const delegator = network.delegation.delegator
  const result = (status: Operation['status'], payment: Payment, reason?: string): Operation => ({
    ...base,
    status,
    updatedAt: now,
    payment,
    ...(reason === undefined ? {} : { reason: reason.slice(0, 240) }),
  })
  if ((await delegated(node, owner, delegator)) === true) return result('confirmed', { rail: 'userop' })
  let sent: SubmittedUserOp
  try {
    sent = await submitUserOp({ chain: network, bundler, prepared: pending.prepared, signature, wait: deps.wait })
  } catch (error) {
    // expected: a refusal before or at the bundler sent nothing; the owner prepares and signs again.
    if (error instanceof TransferError && !error.uncertain) return result('failed', { rail: 'userop' }, error.message)
    if (error instanceof TransferError) return result('submitted', { rail: 'userop' }, error.message)
    throw error
  }
  const payment: Payment = {
    rail: 'userop',
    userOpHash: sent.userOpHash,
    ...(sent.txHash === undefined
      ? {}
      : { txHash: sent.txHash, explorerUrl: `${network.explorerUrl}/tx/${sent.txHash}` }),
    settledAt: now,
  }
  if (sent.status === 'pending') return result('submitted', payment)
  const applied = await delegatedAfterReceipt(node, owner, delegator, deps.wait)
  if (applied === true) return result('confirmed', payment)
  if (applied === null) return result('submitted', payment)
  return result(
    'failed',
    payment,
    sent.status === 'reverted'
      ? 'The upgrade operation reverted.'
      : 'The upgrade landed but the chain did not apply the authorization.',
  )
}

const Big = Schema.BigIntFromString

/** A prepared upgrade as the ledger keeps it: JSON, with the operation's bigints as decimal strings. */
const StoredUpgrade = Schema.fromJsonString(
  Schema.Struct({
    upgradeId: Schema.String,
    chain: ChainKey,
    createdAt: Schema.String,
    expiresAt: Schema.String,
    prepared: Schema.Struct({
      op: Schema.Struct({
        sender: Address,
        nonce: Big,
        callData: Hex,
        callGasLimit: Big,
        verificationGasLimit: Big,
        preVerificationGas: Big,
        maxFeePerGas: Big,
        maxPriorityFeePerGas: Big,
        paymaster: Schema.optionalKey(Address),
        paymasterVerificationGasLimit: Schema.optionalKey(Big),
        paymasterPostOpGasLimit: Schema.optionalKey(Big),
        paymasterData: Schema.optionalKey(Hex),
        signature: Hex,
      }),
      authorization: Schema.optional(UpgradePrepare.fields.authorization),
      entryPoint: Address,
      feeBound: Big,
    }),
  }),
)

export const encodePendingUpgrade: (pending: PendingUpgrade) => string = Schema.encodeSync(StoredUpgrade)

/** The prepared upgrade the ledger kept, or undefined when what it holds is not one. */
export const decodePendingUpgrade = (json: string): PendingUpgrade | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(StoredUpgrade)(json))
