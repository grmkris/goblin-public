import { parseUnits } from '@goblin/wallet/amounts'
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

/** The reason an operation keeps once its credential left: the caller sends it, and only its receipt settles it. */
const HANDED_OVER =
  'The payment credential went to the caller, who sends it to the service; the outcome is unknown until its receipt is reported.'

const client = (deps: RailsDeps) => tempoClient(undefined, deps.fetchFn)

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
  if (!isTempoAgent(signer)) return { outcome: 'failed', reason: 'The agent wallet cannot sign on Tempo yet.' }
  const { terms } = operation
  try {
    const credential = await signChallenge({
      header: challenge,
      challengeId,
      recipient: terms.recipient,
      amount: parseUnits(terms.amount, terms.token.decimals),
      agent: signer,
      operationKey: operation.id,
      client: client(deps),
      ...(deps.now === undefined ? {} : { now: deps.now }),
    })
    return { outcome: 'uncertain', reason: HANDED_OVER, credential }
  } catch (error) {
    // expected: a refusal or a signer error before the credential exists leaves nothing that can pay.
    if (error instanceof TempoError) return { outcome: 'failed', reason: error.message }
    return { outcome: 'failed', reason: 'The challenge could not be signed; nothing was paid.' }
  }
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
