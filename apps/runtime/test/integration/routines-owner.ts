import type { RoutineDefinition, RoutineEdit, RoutineRevision } from '@goblin/contracts'
import type * as Effect from 'effect/Effect'
import { type AgentFetch, type OwnerClient, callOwner } from '../owner-client.ts'
import type { RoutineRunStore } from '../../src/routines/runs.ts'
import { ownerResult } from './probe-reads.ts'
import { waitFor } from './until.ts'

/** The owner's routine calls the probes make, through the typed owner API as the Worker forwards them. */
export const proposeRoutine = (agent: AgentFetch, definition: RoutineDefinition, operationId: string) =>
  callOwner(agent, (api) => api.routines.propose({ payload: { definition, operationId } }))

export const changeRoutine = (
  agent: AgentFetch,
  id: string,
  payload: RoutineRevision,
  action: 'confirm' | 'pause' | 'archive',
) => callOwner(agent, (api) => api.routines[action]({ params: { id }, payload }))

export const editRoutine = (agent: AgentFetch, id: string, payload: RoutineEdit) =>
  callOwner(agent, (api) => api.routines.edit({ params: { id }, payload }))

/** "Run now" at `revision`, as the owner confirms it. */
export const runRoutineNow = (agent: AgentFetch, id: string, revision: number, operationId: string) =>
  callOwner(agent, (api) => api.routines.run({ params: { id }, payload: { revision, operationId, confirmRun: true } }))

/** Whether the owner API refused `call` (any typed failure), for the probes that expect a refusal. */
const refused = async <A, E>(agent: AgentFetch, call: (api: OwnerClient) => Effect.Effect<A, E>) =>
  !(await ownerResult(agent, call)).ok

/** Whether the owner API refused a confirm, pause or archive. */
export const changeRefused = (
  agent: AgentFetch,
  id: string,
  payload: RoutineRevision,
  action: 'confirm' | 'pause' | 'archive',
) => refused(agent, (api) => api.routines[action]({ params: { id }, payload }))

/** Whether the owner API refused "run now". */
export const runRefused = (agent: AgentFetch, id: string, revision: number, operationId: string) =>
  refused(agent, (api) => api.routines.run({ params: { id }, payload: { revision, operationId, confirmRun: true } }))

/** Until run `id` is in `state`, read from the run store; it rejects after `ms` (2 s by default). */
export const runReached = (store: RoutineRunStore, id: string, state: string, ms = 2000) =>
  waitFor(
    () => store.get(id).state,
    (now) => now === state,
    `routine run ${state}`,
    ms,
  )
