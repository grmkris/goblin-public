import type { Me } from '@goblin/wallet/contract'
import { readStatus } from '../services/programs/status.ts'
import { answerWith, type ApiCall } from './call.ts'
import { json } from '../http.ts'

/** The owner's setup as the app shows it. Also remembers the owner's address, which the MCP server reads later. */
export async function readMe(call: ApiCall): Promise<Me> {
  const profile = await call.ledger.updateProfile({ ownerAddress: call.owner.ownerAddress })
  return {
    userId: call.owner.userId,
    owner: call.owner.ownerAddress,
    ...(profile.agentAddress === undefined ? {} : { agent: profile.agentAddress, limits: await call.ledger.limits() }),
    chains: [...profile.chains],
  }
}

export const me = async (call: ApiCall): Promise<Response> => json(await readMe(call))

export const status = (call: ApiCall): Promise<Response> => answerWith(call, readStatus)
