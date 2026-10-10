import { PRIMARY_CHAT } from '@goblin/contracts'
import type { PiHarness } from 'agents/harness/pi'
import { drizzle } from 'drizzle-orm/durable-sqlite'
import { ChatDirectory, registerPrimary } from '../../src/chats/directory.ts'
import { BUDGET_BLOCKS } from '../../src/pi/budget.ts'
import { type Probes, inAgent } from './probe.ts'

/**
 * The budget hook while auth D1 cannot answer (R1): a tool in main is blocked as a check that failed, never as a spent
 * budget, and runs again once the plan can be read. The turns go straight to Pi, as an alarm's would, so only the hook
 * reads the plan; `outage` switches the agent's plan reads off and on.
 */
async function budgetOutageProbe(storage: DurableObjectStorage, harness: PiHarness, outage: (on: boolean) => void) {
  const db = drizzle(storage)
  registerPrimary(db, Math.floor(Date.now() / 1000))
  const session = new ChatDirectory(db).session(PRIMARY_CHAT)
  outage(true)
  try {
    await harness.submit('call routine_list {}', { session, operationId: 'budget-outage' })
    const blocked = await harness.wait('budget-outage', { session })
    outage(false)
    await harness.submit('call routine_list {}', { session, operationId: 'budget-recovered' })
    const recovered = await harness.wait('budget-recovered', { session })
    return {
      blocked: blocked.text ?? '',
      recovered: recovered.text ?? '',
      failedCopy: BUDGET_BLOCKS.failed,
      spentCopy: BUDGET_BLOCKS.exhausted,
    }
  } finally {
    outage(false)
  }
}

export const probes: Probes = {
  'budget-outage': inAgent(({ storage, harness, plan }) => budgetOutageProbe(storage, harness, plan.outage)),
}
