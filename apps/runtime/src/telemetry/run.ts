import { RunAttribute } from '@goblin/contracts/telemetry'
import { drizzle } from 'drizzle-orm/durable-sqlite'
import { RunTelemetry, type RunSink, reportTelemetryFailure } from './events.ts'
import { RunLedger } from './ledger.ts'
import { RunLog } from './log.ts'
import { PiRunRecorder } from './pi.ts'

/** One agent's run telemetry (ADR 0024): its ledger, its log lines, and the recorder that follows Pi's commits. */
export type RunTelemetryKit = {
  readonly telemetry: RunTelemetry
  readonly ledger: RunLedger
  readonly recorder: PiRunRecorder
  /** At the object's start, before new work: interrupt what the last run left started, drop what is past retention. */
  readonly restarted: (now: number) => void
}

/**
 * Run telemetry for any object that runs Pi on its own SQLite: the ledger, one log line per event, and `sinks` beside
 * them (a benchmark's `CollectedRuns`). Attach `recorder` to the harness as soon as it opens.
 */
export function runTelemetry(
  storage: DurableObjectStorage,
  agent: () => string,
  sinks: readonly RunSink[] = [],
): RunTelemetryKit {
  const ledger = new RunLedger(drizzle(storage))
  const telemetry = new RunTelemetry([ledger, new RunLog(agent), ...sinks], (id) => ledger.read(id))
  const recorder = new PiRunRecorder(telemetry, ledger)
  return {
    telemetry,
    ledger,
    recorder,
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
        reportTelemetryFailure('restart', error)
      }
    },
  }
}
