import type { CreatePersona, CreateTopic, UpdatePersona, UpdateTopic } from '@goblin/contracts'
import { Agent } from 'agents'
import type * as Effect from 'effect/Effect'
import type { StopRuntime } from '../agent-program.ts'
import type { RuntimeEnv } from '../env.ts'
import type { AppError } from '../http/errors.ts'
import type { RpcResult } from '../http/rpc.ts'
import * as PersonaPrograms from '../personas/program.ts'
import type { AgentServices } from '../services.ts'
import * as TopicPrograms from '../topics/program.ts'
import * as OrganizePrograms from './program.ts'

/**
 * The owner's workspace organization on the Agent: Topics (ADR 0032), Personas and the receipts of what was organized
 * (ADR 0033). `PersonalAgent` supplies how an owner request runs and what a Stop reaches; each method is one program.
 */
export abstract class OrganizingAgent extends Agent<RuntimeEnv> {
  /** An owner request: renews resident authority, then runs the program. */
  protected abstract readonly owner: <A>(program: Effect.Effect<A, AppError, AgentServices>) => Promise<RpcResult<A>>
  /** What an archive or a Stop reaches. */
  protected abstract readonly stopping: () => StopRuntime

  /** The owner's Topics: each a channel with one Conversation. Archiving one stops its chats' work. */
  topics() {
    return this.owner(TopicPrograms.topicList)
  }
  createTopic(input: CreateTopic) {
    return this.owner(TopicPrograms.createTopic(input, { actor: 'owner' }))
  }
  updateTopic(id: number, change: UpdateTopic) {
    return this.owner(TopicPrograms.updateTopic(this.stopping(), id, change))
  }

  /** The owner's Personas: list, create (idempotent by operation id), one with its revisions, a new revision. */
  personas() {
    return this.owner(PersonaPrograms.personaList)
  }
  createPersona(input: CreatePersona) {
    return this.owner(PersonaPrograms.createPersona(input, { actor: 'owner' }))
  }
  personaDetail(id: number) {
    return this.owner(PersonaPrograms.personaDetail(id))
  }
  updatePersona(id: number, change: UpdatePersona) {
    return this.owner(PersonaPrograms.updatePersona(id, change, { actor: 'owner' }))
  }

  /** What organizing changed, newest first, and Undo for one change (refused as `touched` after a later edit). */
  organizeReceipts() {
    return this.owner(OrganizePrograms.receiptList)
  }
  undoOrganize(id: string) {
    return this.owner(OrganizePrograms.undoReceipt(this.stopping(), id))
  }
}
