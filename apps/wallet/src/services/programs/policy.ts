import type { PolicyChangeInput } from '@goblin/wallet/contract'
import * as Effect from 'effect/Effect'
import { Ledger } from '../ledger.ts'

const sha256Hex = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Records what the agent asks the owner to change. Asking twice for the same thing records it once. */
export const requestPolicyChange = (input: PolicyChangeInput, client: string) =>
  Effect.gen(function* () {
    const id = `pc-${(yield* Effect.promise(() => sha256Hex(`${input.change}\n${input.reason}`))).slice(0, 24)}`
    return yield* (yield* Ledger).use((api) => api.recordPolicyChange(id, input.change, input.reason, client))
  })
