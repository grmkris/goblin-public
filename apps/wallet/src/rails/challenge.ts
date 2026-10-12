import { formatUnits, parseUnits } from '@goblin/wallet/amounts'
import { erc20Balance } from '@goblin/wallet/balances'
import { TEMPO } from '@goblin/wallet/chains'
import type { Operation } from '@goblin/wallet/contract'
import {
  confirmReceipt,
  isTempoAgent,
  type ReceiptFinding,
  signChallenge,
  TempoError,
  tempoClient,
} from '@goblin/wallet/tempo'
import type { PayOutcome } from '../services/rails.ts'
import type { RailsDeps } from './deps.ts'
import { afterPayment, REFILLING, refillForShort } from './float.ts'

/** The reason an operation keeps once its credential left: the caller sends it, and only its receipt settles it. */
const HANDED_OVER =
  'The payment credential went to the caller, who sends it to the service; the outcome is unknown until its receipt is reported.'

const client = (deps: RailsDeps) => tempoClient(undefined, deps.fetchFn)

/** How a challenge refused for want of USDC.e starts its reason; `pay_challenge` answers it as `insufficient_funds`. */
export const FUNDS_SHORT = 'The agent wallet holds'
export { REFILLING, REFILL_RETRY_AFTER_SECONDS } from './float.ts'

/** The agent's USDC.e on Tempo, or undefined when Tempo did not answer: unknown is not short. */
const heldOnTempo = (deps: RailsDeps, agent: string): Promise<bigint | undefined> =>
  // expected: a Tempo read that fails leaves the balance unknown; the service refuses a credential its payer cannot cover.
  erc20Balance(deps.rpcFor('tempo'), TEMPO.usdc.address, agent).catch(() => undefined)

/**
 * Why the agent cannot pay `amount` USDC.e on Tempo. When the owner's Base allowance can refill the float (ADR 0051),
 * the refill is asked for and the reason says to try again shortly; otherwise it says where to send USDC.e.
 */
const fundsShort = async (deps: RailsDeps, agent: string, held: bigint, amount: bigint): Promise<string> => {
  if (await refillForShort(deps, amount)) return REFILLING
  const { decimals } = TEMPO.usdc
  return `${FUNDS_SHORT} ${formatUnits(held, decimals)} USDC.e on Tempo; this payment needs ${formatUnits(amount, decimals)}. Send USDC.e on Tempo to ${agent}, or add funds from any chain (add_funds).`
}

/**
 * Signs a reserved `pay_challenge` operation: the challenge must still be the one its terms froze (id, recipient,
 * amount), and the agent signs it under those terms. Once the credential exists it is `uncertain`, never settled: the
 * service may redeem it at any moment. A refusal before that means nothing was signed that can pay.
 */
export const payChallenge = async (
  operation: Operation,
  challenge: string,
  challengeId: string,
  deps: RailsDeps,
): Promise<PayOutcome> => {
  const { signer } = deps
  if (signer === undefined) return { outcome: 'failed', reason: 'The owner has not created the agent wallet yet.' }
  if (!deps.live)
    return { outcome: 'failed', reason: 'MPP payees take mainnet payments only; this wallet is on testnets.' }
  const { terms } = operation
  const amount = parseUnits(terms.amount, terms.token.decimals)
  const held = await heldOnTempo(deps, signer.address)
  if (held !== undefined && held < amount)
    return { outcome: 'failed', reason: await fundsShort(deps, signer.address, held, amount) }
  if (!isTempoAgent(signer)) return { outcome: 'failed', reason: 'The agent wallet cannot sign on Tempo yet.' }
  let credential: string
  try {
    credential = await signChallenge({
      header: challenge,
      challengeId,
      recipient: terms.recipient,
      amount,
      agent: signer,
      operationKey: operation.id,
      client: client(deps),
      ...(deps.now === undefined ? {} : { now: deps.now }),
    })
  } catch (error) {
    // expected: a refusal or a signer error before the credential exists leaves nothing that can pay.
    if (error instanceof TempoError) return { outcome: 'failed', reason: error.message }
    return { outcome: 'failed', reason: 'The challenge could not be signed; nothing was paid.' }
  }
  await afterPayment(deps, held, amount)
  return { outcome: 'uncertain', reason: HANDED_OVER, credential }
}

/** Checks a reported Payment-Receipt for a `pay_challenge` operation against Tempo. */
export const confirmChallenge = async (
  operation: Operation,
  challengeId: string,
  receipt: string,
  deps: RailsDeps,
): Promise<ReceiptFinding> => {
  const agent = deps.signer?.address ?? (await deps.profile()).agentAddress
  if (agent === undefined) return { kind: 'mismatch', reason: 'The wallet has no agent that could have paid this.' }
  const { terms } = operation
  return confirmReceipt({
    receipt,
    agent,
    recipient: terms.recipient,
    amount: parseUnits(terms.amount, terms.token.decimals),
    challengeId,
    client: client(deps),
    ...(deps.now === undefined ? {} : { now: deps.now }),
  })
}
