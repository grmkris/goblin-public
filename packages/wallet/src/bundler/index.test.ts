import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, test } from 'vitest'
import { toHex } from '../balances/hex.ts'
import { JsonRpcError, type JsonRpc } from '../balances/rpc.ts'
import { BASE, TEMPO } from '../chains/index.ts'
import { decodeBatch, delegatorTypedData, type Call } from '../userop/index.ts'
import { DUMMY_SIGNATURE, prepareUserOp, submitUserOp, type PrepareInput } from './index.ts'

const account = privateKeyToAccount(`0x${'42'.repeat(32)}`)
const stranger = privateKeyToAccount(`0x${'43'.repeat(32)}`)
const PAYMASTER = '0x777777777777AeC03fd955926DbF81597e66834C'
const HASH = `0x${'ab'.repeat(32)}`
const TX = `0x${'cd'.repeat(32)}`
const hex = (value: bigint) => `0x${value.toString(16)}`

const node: JsonRpc = async (method) => {
  if (method !== 'eth_call') throw new Error(`unexpected ${method}`)
  return `0x${'0'.repeat(63)}7`
}

/** Pimlico as the spike saw it on Base: a USDC quote, a fast gas price, stub and final paymaster data, estimates. */
const pimlico = (options: { receipt?: unknown; refuse?: string; paymaster?: string } = {}) => {
  const calls: string[] = []
  const rpc: JsonRpc = async (method) => {
    calls.push(method)
    if (method === options.refuse)
      throw new JsonRpcError(method, 'UserOperation reverted: transfer-amount-exceeded', -32_521)
    switch (method) {
      case 'pimlico_getTokenQuotes':
        return {
          quotes: [
            { paymaster: options.paymaster ?? PAYMASTER, exchangeRate: hex(2_788_189_200n), postOpGas: hex(18_990n) },
          ],
        }
      case 'pimlico_getUserOperationGasPrice':
        return { fast: { maxFeePerGas: hex(8_855_000n), maxPriorityFeePerGas: hex(1_265_000n) } }
      case 'pm_getPaymasterStubData':
        return { paymaster: PAYMASTER, paymasterData: '0x0300', paymasterPostOpGasLimit: hex(68_990n) }
      case 'eth_estimateUserOperationGas':
        return {
          callGasLimit: hex(275_767n),
          verificationGasLimit: hex(61_585n),
          preVerificationGas: hex(104_329n),
          paymasterVerificationGasLimit: hex(46_456n),
          paymasterPostOpGasLimit: hex(43_715n),
        }
      case 'pm_getPaymasterData':
        return { paymaster: PAYMASTER, paymasterData: '0x0200' }
      case 'eth_sendUserOperation':
        return HASH
      case 'eth_getUserOperationReceipt':
        return options.receipt ?? null
      default:
        throw new Error(`unexpected ${method}`)
    }
  }
  return { rpc, calls }
}

const transfer: Call = { target: BASE.usdc.address, value: 0n, callData: '0xa9059cbb' }
const input = (bundler: JsonRpc, overrides: Partial<PrepareInput> = {}): PrepareInput => ({
  chain: BASE,
  node,
  bundler,
  sender: account.address,
  calls: [transfer],
  feeCeiling: 100_000n,
  ...overrides,
})
const instant = { attempts: 2, sleep: async () => undefined }

describe('preparing a UserOperation', () => {
  test('estimates with a well-formed 65-byte signature that recovers to some other address', async () => {
    expect(DUMMY_SIGNATURE).toMatch(/^0x[0-9a-f]{130}$/u)
    const { recoverAddress } = await import('viem')
    expect(await recoverAddress({ hash: `0x${'ab'.repeat(32)}`, signature: toHex(DUMMY_SIGNATURE) })).not.toBe(
      account.address,
    )
  })

  test("prices the gas in USDC, bounds it and appends the paymaster's approval of exactly that bound", async () => {
    const { rpc, calls } = pimlico()
    const prepared = await prepareUserOp(input(rpc))
    expect(calls).toEqual([
      'pimlico_getTokenQuotes',
      'pimlico_getUserOperationGasPrice',
      'pm_getPaymasterStubData',
      'eth_estimateUserOperationGas',
      'pm_getPaymasterData',
    ])
    // The spike's numbers: 13,599 USDC units at most, plus 20%.
    expect(prepared.feeBound).toBe(16_319n)
    expect(prepared.op).toMatchObject({ nonce: 7n, callGasLimit: 275_767n, paymasterData: '0x0200' })
    const batch = decodeBatch(prepared.op.callData)
    expect(batch?.[0]).toEqual(transfer)
    expect(batch?.[1]?.target).toBe(BASE.usdc.address)
    expect(batch?.[1]?.callData).toContain(16_319n.toString(16))
  })

  test("refuses gas above the ceiling, a paymaster other than the chain's, a chain without UserOperations", async () => {
    await expect(prepareUserOp(input(pimlico().rpc, { feeCeiling: 10_000n }))).rejects.toMatchObject({
      code: 'fee_ceiling',
    })
    await expect(prepareUserOp(input(pimlico({ paymaster: account.address }).rpc))).rejects.toMatchObject({
      code: 'rpc_unavailable',
    })
    await expect(prepareUserOp(input(pimlico().rpc, { chain: TEMPO }))).rejects.toMatchObject({ code: 'unsupported' })
  })

  test("a batch the chain would revert is the bundler's refusal, in the wallet's words", async () => {
    await expect(prepareUserOp(input(pimlico({ refuse: 'eth_estimateUserOperationGas' }).rpc))).rejects.toMatchObject({
      code: 'allowance_exhausted',
    })
  })
})

describe('submitting a UserOperation', () => {
  const signed = async (bundler: JsonRpc, signer = account) => {
    const prepared = await prepareUserOp(input(bundler))
    const signature = await signer.signTypedData(delegatorTypedData(prepared.op, BASE, prepared.entryPoint))
    return { prepared, signature }
  }

  test('hands the hash back before waiting, then reports the mined batch', async () => {
    const { rpc, calls } = pimlico({ receipt: { success: true, receipt: { transactionHash: TX } } })
    const seen: string[] = []
    const { prepared, signature } = await signed(rpc)
    const sent = await submitUserOp({
      chain: BASE,
      bundler: rpc,
      prepared,
      signature,
      onSubmitted: (hash) => {
        seen.push(`${hash}@${calls.length}`)
      },
      wait: instant,
    })
    expect(sent).toEqual({ userOpHash: HASH, txHash: TX, status: 'success' })
    expect(seen).toEqual([`${HASH}@${calls.indexOf('eth_sendUserOperation') + 1}`])
  })

  test('a reverted batch, and one not mined in time, are told apart', async () => {
    const reverted = pimlico({ receipt: { success: false, receipt: { transactionHash: TX } } })
    const one = await signed(reverted.rpc)
    expect(await submitUserOp({ chain: BASE, bundler: reverted.rpc, ...one, wait: instant })).toMatchObject({
      status: 'reverted',
    })
    const slow = pimlico()
    const two = await signed(slow.rpc)
    expect(await submitUserOp({ chain: BASE, bundler: slow.rpc, ...two, wait: instant })).toEqual({
      userOpHash: HASH,
      status: 'pending',
    })
  })

  test("a signature that is not the sender's is refused before anything is sent", async () => {
    const { rpc, calls } = pimlico()
    const { prepared, signature } = await signed(rpc, stranger)
    await expect(submitUserOp({ chain: BASE, bundler: rpc, prepared, signature, wait: instant })).rejects.toMatchObject(
      { code: 'bad_signature' },
    )
    expect(calls).not.toContain('eth_sendUserOperation')
  })
})
