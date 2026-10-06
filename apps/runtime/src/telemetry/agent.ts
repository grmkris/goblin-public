import { RunAttribute } from '@goblin/contracts/telemetry'
import type { Extension } from '@earendil-works/pi-durable'
import { drizzle } from 'drizzle-orm/durable-sqlite'
import { diagnoseExtension } from '../pi/diagnose.ts'
import type { RunProgram } from '../pi/resident-mcp.ts'
import { RunTelemetry } from './events.ts'
import { RunLedger } from './ledger.ts'
import { RunLog } from './log.ts'
import { PiRunRecorder } from './pi.ts'

/** One agent's run telemetry (ADR 0024): its ledger, its log lines, and the recorder that follows Pi's commits. */
export type AgentTelemetry = {
  readonly telemetry: RunTelemetry
  readonly ledger: RunLedger
  readonly recorder: PiRunRecorder
  /** At the object's start, before new work: interrupt what the last run left started, drop what is past retention. */
  readonly restarted: (now: number) => void
  /** The agent's own read-only `diagnose` tool over this ledger, for main. */
  readonly diagnose: Extension
}

export function agentTelemetry(storage: DurableObjectStorage, agent: () => string, run: RunProgram): AgentTelemetry {
  const ledger = new RunLedger(drizzle(storage))
  const telemetry = new RunTelemetry([ledger, new RunLog(agent)], (id) => ledger.read(id))
  const recorder = new PiRunRecorder(telemetry, ledger)
  return {
    telemetry,
    ledger,
    recorder,
    diagnose: diagnoseExtension(run),
    restarted: (now) => {
      try {
        const interrupted = ledger.sweep(now)
        if (interrupted === 0) return
        telemetry.record({
          id: `restart:${now}`,
          kind: 'recovery',
          status: 'ok',
          startedAt: now,
          endedAt: now,
          attributes: { [RunAttribute.recovery]: 'restarted', [RunAttribute.interrupted]: interrupted },
        })
      } catch (error) {
        // Telemetry never stops the agent from starting.
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 300)
        console.warn(JSON.stringify({ level: 'warn', event: 'telemetry', where: 'restart', error: message }))
      }
    },
  }
}
