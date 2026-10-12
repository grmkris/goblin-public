import {
  AllowanceConfirm,
  AllowancePrepare,
  type ChainSetup,
  type Operation,
  UpgradeConfirm,
  UpgradePrepare,
} from '@goblin/wallet/contract'
import { apiError, failureResponse, json } from '../http.ts'
import { RailError } from '../rails/deps.ts'
import { decodePendingUpgrade, encodePendingUpgrade } from '../rails/upgrade.ts'
import { WalletFailure } from '../services/errors.ts'
import type { PreparedUpgrade } from '../services/rails.ts'
import { type ApiCall, readBody } from './call.ts'
import { readMe } from './me.ts'

/** `POST /api/onboarding/agent`: creates the owner's agent wallet once and records where it is. */
export async function createAgent(call: ApiCall): Promise<Response> {
  const existing = await call.ledger.profile()
  if (existing.agentAddress === undefined) {
    const created = await call.wiring.createAgent(call.env, {
      userId: call.owner.userId,
      address: call.owner.ownerAddress,
    })
    await call.ledger.updateProfile({
      ownerAddress: call.owner.ownerAddress,
      agentAddress: created.address,
      agentWalletId: created.walletId,
    })
  }
  return json(await readMe(call))
}

const chainSetup = async (call: ApiCall, chain: ChainSetup['chain']): Promise<ChainSetup> => {
  const profile = await call.ledger.profile()
  return profile.chains.find((entry) => entry.chain === chain) ?? { chain, upgraded: false }
}

/** Records the chain as upgraded: only once the owner's code delegates to the DeleGator. */
const recordUpgraded = async (call: ApiCall, chain: ChainSetup['chain']): Promise<void> => {
  const setup = await chainSetup(call, chain)
  await call.ledger.updateProfile({ chains: [{ ...setup, upgraded: true }] })
}

/** A rail's refusal as the error envelope it carries; anything else is a chain or bundler that did not answer. */
const railRefusal = (error: unknown): Response => {
  if (error instanceof WalletFailure) return failureResponse(error)
  if (error instanceof RailError) return apiError('upgrade_refused', error.message, 409)
  return apiError('rail_unavailable', 'The chain or the bundler did not answer; nothing was sent.', 502, 'Try again.')
}

/**
 * `POST /api/onboarding/upgrade/prepare`: turns the owner's signed EIP-7702 authorization into a UserOperation from
 * their own address, whose gas their USDC pays, and keeps it in the ledger for five minutes. The owner reviews and
 * signs its typed data, then confirms it. An account that already delegates to the DeleGator is recorded as upgraded,
 * with nothing to sign.
 */
export async function upgradePrepare(call: ApiCall): Promise<Response> {
  const body = await readBody(call.request, UpgradePrepare)
  if (!body.ok) return body.response
  if ((await call.ledger.profile()).agentAddress === undefined)
    return apiError('not_onboarded', 'Create the agent wallet first.', 409)
  const { chain } = body.value
  let prepared: PreparedUpgrade
  try {
    prepared = await call.rails.prepareUpgrade(body.value)
  } catch (error) {
    // expected: a rail's refusal is the owner's error envelope, and a rail that did not answer a 502 to retry.
    return railRefusal(error)
  }
  if (prepared.kind === 'upgraded') {
    await recordUpgraded(call, chain)
    return json({ chain, operation: prepared.operation })
  }
  const { pending, typedData, maxFeeUsdc } = prepared
  await call.ledger.putPreparedUpgrade(pending.upgradeId, encodePendingUpgrade(pending))
  return json({ chain, upgradeId: pending.upgradeId, typedData, maxFeeUsdc, expiresAt: pending.expiresAt })
}

/**
 * `POST /api/onboarding/upgrade`: sends a prepared upgrade with the owner's signature. The chain is recorded as
 * upgraded only once the rails confirmed the owner's code delegates to the DeleGator; a submitted or failed upgrade
 * leaves it as it was, and the owner prepares it again.
 */
export async function upgrade(call: ApiCall): Promise<Response> {
  const body = await readBody(call.request, UpgradeConfirm)
  if (!body.ok) return body.response
  if ((await call.ledger.profile()).agentAddress === undefined)
    return apiError('not_onboarded', 'Create the agent wallet first.', 409)
  const { chain, upgradeId, signature } = body.value
  const stored = await call.ledger.preparedUpgrade(upgradeId)
  const pending = stored === undefined ? undefined : decodePendingUpgrade(stored)
  if (pending === undefined || pending.chain !== chain || Date.parse(pending.expiresAt) <= Date.now())
    return apiError('upgrade_unknown', 'This upgrade is not known or has expired.', 409, 'Prepare it again.')
  let operation: Operation
  try {
    operation = await call.rails.confirmUpgrade(pending, signature)
  } catch (error) {
    // expected: a rail's refusal is the owner's error envelope, and a rail that did not answer a 502 to retry.
    return railRefusal(error)
  }
  if (operation.status === 'confirmed') await recordUpgraded(call, chain)
  return json(operation)
}

async function agentOf(call: ApiCall) {
  const { agentAddress } = await call.ledger.profile()
  return agentAddress === undefined
    ? undefined
    : { userId: call.owner.userId, address: call.owner.ownerAddress, agent: agentAddress }
}

/** `POST /api/allowance/prepare`: the exact delegation the owner signs. */
export async function allowancePrepare(call: ApiCall): Promise<Response> {
  const body = await readBody(call.request, AllowancePrepare)
  if (!body.ok) return body.response
  const parties = await agentOf(call)
  if (parties === undefined) return apiError('not_onboarded', 'Create the agent wallet first.', 409)
  const draft = await call.wiring.allowance.prepare(call.env, parties, body.value)
  return json({ chain: body.value.chain, ...draft })
}

/** `POST /api/allowance/confirm`: verifies the owner's signature, stores the delegation and records the allowance. */
export async function allowanceConfirm(call: ApiCall): Promise<Response> {
  const body = await readBody(call.request, AllowanceConfirm)
  if (!body.ok) return body.response
  const parties = await agentOf(call)
  if (parties === undefined) return apiError('not_onboarded', 'Create the agent wallet first.', 409)
  const allowance = await call.wiring.allowance.confirm(call.env, parties, body.value)
  const setup = await chainSetup(call, body.value.chain)
  await call.ledger.updateProfile({ chains: [{ ...setup, allowance }] })
  return json(await readMe(call))
}
