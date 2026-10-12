import { AllowanceConfirm, AllowancePrepare, type ChainSetup, UpgradeRequest } from '@goblin/wallet/contract'
import { apiError, json } from '../http.ts'
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

/**
 * `POST /api/onboarding/upgrade`: relays the owner's signed EIP-7702 authorization through the rails. The chain is
 * recorded as upgraded only once the rails confirmed the owner's code delegates to the DeleGator; a submitted or failed
 * upgrade leaves it as it was, so the owner's next attempt finds the same stored transaction.
 */
export async function upgrade(call: ApiCall): Promise<Response> {
  const body = await readBody(call.request, UpgradeRequest)
  if (!body.ok) return body.response
  if ((await call.ledger.profile()).agentAddress === undefined)
    return apiError('not_onboarded', 'Create the agent wallet first.', 409)
  const operation = await call.rails.upgrade(body.value)
  if (operation.status === 'confirmed') {
    const setup = await chainSetup(call, body.value.chain)
    await call.ledger.updateProfile({ chains: [{ ...setup, upgraded: true }] })
  }
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
