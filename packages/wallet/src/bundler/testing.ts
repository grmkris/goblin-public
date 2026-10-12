/**
 * Test doubles for UserOperation sends: Pimlico as the Base spike saw it (`/tmp/wallet-run/spike-aa/run-send.json`), a
 * chain node with the agent's USDC and code, and an agent signer over a viem local account that signs the DeleGator's
 * typed data the way Privy's `eth_signUserOperation` does. Imported by tests only.
 */
import { privateKeyToAccount } from 'viem/accounts'
import { toAddress } from '../balances/hex.ts'
import { field, JsonRpcError, type JsonRpc } from '../balances/rpc.ts'
import { BASE, type Chain, chainByKey } from '../chains/index.ts'
import type { AgentSigner, TypedDataJson } from '../contract/signer.ts'
import { decodeBatch, delegatorTypedData, type Call } from '../userop/index.ts'
import { aaOf } from './index.ts'

const hex = (value: bigint) => `0x${value.toString(16)}`
const word = (value: bigint) => `0x${value.toString(16).padStart(64, '0')}`

export const TEST_USEROP_HASH = `0x${'ab'.repeat(32)}`
export const TEST_TX = `0x${'cd'.repeat(32)}`
/** The USDC fee bound the fake's numbers give (the spike's 13,599 units plus 20%). */
export const TEST_FEE_BOUND = 16_319n

export interface FakeBundler {
  readonly rpc: JsonRpc
  readonly methods: string[]
  /** The batch of every operation sent, decoded. */
  readonly batches: Call[][]
  /** The `eip7702Auth` of every operation sent that carried one. */
  readonly authorizations: unknown[]
}

export const fakeBundler = (
  options: { receipt?: 'success' | 'reverted' | 'none'; refuse?: { method: string; message: string } } = {},
): FakeBundler => {
  const methods: string[] = []
  const batches: Call[][] = []
  const authorizations: unknown[] = []
  const paymaster = aaOf(BASE).paymaster
  const answers: Record<string, unknown> = {
    pimlico_getTokenQuotes: { quotes: [{ paymaster, exchangeRate: hex(2_788_189_200n), postOpGas: hex(18_990n) }] },
    pimlico_getUserOperationGasPrice: {
      fast: { maxFeePerGas: hex(8_855_000n), maxPriorityFeePerGas: hex(1_265_000n) },
    },
    pm_getPaymasterStubData: { paymaster, paymasterData: '0x0300', paymasterPostOpGasLimit: hex(68_990n) },
    eth_estimateUserOperationGas: {
      callGasLimit: hex(275_767n),
      verificationGasLimit: hex(61_585n),
      preVerificationGas: hex(104_329n),
      paymasterVerificationGasLimit: hex(46_456n),
      paymasterPostOpGasLimit: hex(43_715n),
    },
    pm_getPaymasterData: { paymaster, paymasterData: '0x0200' },
  }
  const rpc: JsonRpc = async (method, params) => {
    methods.push(method)
    if (options.refuse?.method === method) throw new JsonRpcError(method, options.refuse.message, -32_521)
    if (method in answers) return answers[method]
    if (method === 'eth_sendUserOperation') {
      batches.push(decodeBatch(String(field(params[0], 'callData'))) ?? [])
      const auth = field(params[0], 'eip7702Auth')
      if (auth !== undefined) authorizations.push(auth)
      return TEST_USEROP_HASH
    }
    if (method === 'eth_getUserOperationReceipt')
      return options.receipt === 'none'
        ? null
        : { success: options.receipt !== 'reverted', receipt: { transactionHash: TEST_TX } }
    throw new Error(`unexpected bundler call ${method}`)
  }
  return { rpc, methods, batches, authorizations }
}

/**
 * A chain node for agent sends: the agent's USDC (`usdc()` is read on every balance call, so a test can raise it after
 * a top-up), whether its code delegates to the DeleGator, and anything else through `extra`.
 */
export const fakeNode = (options: {
  usdc: () => bigint
  delegated?: boolean
  chain?: Chain
  extra?: JsonRpc
}): JsonRpc => {
  const chain = options.chain ?? BASE
  return async (method, params) => {
    if (method === 'eth_getCode')
      return options.delegated === false ? '0x' : `0xef0100${chain.delegation.delegator.slice(2).toLowerCase()}`
    if (method === 'eth_getTransactionCount') return '0x5'
    const to = String(field(params[0], 'to')).toLowerCase()
    if (method === 'eth_call' && to === aaOf(chain).entryPoint.toLowerCase()) return word(0n)
    if (method === 'eth_call' && to === chain.usdc.address.toLowerCase()) return word(options.usdc())
    if (options.extra !== undefined) return options.extra(method, params)
    throw new Error(`unexpected node call ${method}`)
  }
}

/** An agent signer over a viem local account: typed data, 7702 authorizations and UserOperations, as Privy signs them. */
export const localAgent = (key: `0x${string}` = `0x${'42'.repeat(32)}`, live = true): AgentSigner => {
  const account = privateKeyToAccount(key)
  return {
    address: account.address,
    signTypedData: ({ typedData }: { typedData: TypedDataJson }) => account.signTypedData(typedData),
    signAuthorization: async ({ chain, contract, nonce }) => {
      const signed = await account.signAuthorization({
        contractAddress: toAddress(contract),
        chainId: chainByKey(chain, live).id,
        nonce,
      })
      return {
        address: contract,
        chainId: signed.chainId,
        nonce,
        r: signed.r,
        s: signed.s,
        yParity: signed.yParity ?? 0,
      }
    },
    signUserOperation: ({ chain, userOp }) => {
      const on = chainByKey(chain, live)
      return account.signTypedData(delegatorTypedData(userOp, on, aaOf(on).entryPoint))
    },
  }
}
