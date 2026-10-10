import type { PiHarness } from 'agents/harness/pi'
import type { JobSchedules, JobSlot } from '../../src/agent-apps/jobs.ts'
import type { RuntimeEnv } from '../../src/env.ts'
import type { EventsFixture } from '../mcp/events-fixture.ts'
import type { AgentFetch } from '../owner-client.ts'
import type { SeenRequest } from './model.ts'
import type { NativeLifecycleProbe } from './lifecycle-probe.ts'
import type { PersonalAgentProbe } from './worker.ts'

/** The probe agent as the Worker reaches it: its stub, with the reads the probes use (`settle`, `requestFor`). */
export type ProbeStub = DurableObjectStub<PersonalAgentProbe>

/** The native worker's bindings. */
export interface ProbeEnv {
  readonly AGENTS: DurableObjectNamespace<PersonalAgentProbe>
  readonly LIFECYCLE: DurableObjectNamespace<NativeLifecycleProbe>
  readonly FILES: R2Bucket
}

/** What a probe inside the agent works on: the object's own storage, Pi, bindings and levers. */
export interface Inside {
  readonly agent: PersonalAgentProbe
  readonly storage: DurableObjectStorage
  readonly harness: PiHarness
  readonly env: RuntimeEnv
  readonly name: string
  /** Every model request the agent made, oldest first. */
  readonly seen: readonly SeenRequest[]
  /** The agent's own APIs, as the Worker reaches them (`onRequest`). */
  readonly api: AgentFetch
  /** The object's native schedules, and its own app job callback. */
  readonly schedules: JobSchedules
  readonly fire: (slot: JobSlot) => Promise<void>
  /** Plan lookups: the `nth` coming one fails (0 for none), or every one fails while the outage is on. */
  readonly plan: { readonly failAt: (nth: number) => void; readonly outage: (on: boolean) => void }
  /** The routine Events producer the agent's MCP fetch reaches for `routine-events.test`. */
  readonly producer: EventsFixture
  /** Stops the object; the next request reconstructs it from storage. */
  readonly evict: (reason: string) => void
}

/** What a probe in the Worker works on: the agent under test by stub, its name, the request and the bindings. */
export interface Outside {
  readonly agent: ProbeStub
  readonly name: string
  readonly url: URL
  readonly env: ProbeEnv
}

/**
 * One named probe of the native worker: it runs inside the agent (reached over RPC) or in the Worker against the
 * agent's stub, and answers JSON.
 */
export type Probe =
  | { readonly where: 'agent'; readonly run: (inside: Inside) => unknown }
  | { readonly where: 'worker'; readonly run: (outside: Outside) => Promise<unknown> }

export type Probes = Readonly<Record<string, Probe>>

export const inAgent = (run: (inside: Inside) => unknown): Probe => ({ where: 'agent', run })
export const inWorker = (run: (outside: Outside) => Promise<unknown>): Probe => ({ where: 'worker', run })

/** Every module's probes as one record; a name two modules claim is a fixture bug, refused at load. */
export function registry(...modules: readonly Probes[]): Probes {
  const all: Record<string, Probe> = {}
  for (const probes of modules)
    for (const [name, probe] of Object.entries(probes)) {
      if (name in all) throw new Error(`probe ${name} is registered twice`)
      all[name] = probe
    }
  return all
}

/** A probe inside the agent, run from the Worker over RPC: its answer, parsed (RPC carries it as JSON text). */
export const agentProbe = async (agent: ProbeStub, name: string): Promise<unknown> => {
  const json: unknown = JSON.parse(await agent.probe(name))
  return json
}
