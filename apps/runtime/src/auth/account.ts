import type { RuntimeEnv } from '../env.ts'
import { unwrap } from '../http/rpc.ts'

/**
 * Erase a user's agent before their account goes. `Agent.destroy()` aborts the agent's isolate right after wiping
 * storage, so the RPC can fail with that abort even though the wipe finished; only that failure is tolerated. Any
 * other failure aborts the account deletion, leaving the account to retry.
 */
export const deleteAgentOf = async (
  env: { readonly AGENTS: Pick<RuntimeEnv['AGENTS'], 'getByName'> },
  userId: string,
): Promise<void> => {
  try {
    unwrap(await env.AGENTS.getByName(userId).deleteAgentData())
  } catch (cause) {
    if (!(cause instanceof Error) || !/destroyed/u.test(cause.message)) throw cause
  }
}

/** The id of the account a user id or email names, for an operator's read (ADR 0024). Never lists accounts. */
export const userIdOf = async (env: Pick<RuntimeEnv, 'AUTH_DB'>, user: string): Promise<string | undefined> => {
  const email = user.includes('@')
  const row = await env.AUTH_DB.prepare(`SELECT id FROM user WHERE ${email ? 'email' : 'id'} = ?`)
    .bind(email ? user.trim().toLowerCase() : user)
    .first<{ id: string }>()
  return row?.id
}
