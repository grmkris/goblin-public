import type {
  CreatePersona,
  PersonaDetail,
  PersonaInvocationView,
  PersonaRevisionView,
  PersonaView,
  UpdatePersona,
} from '@goblin/contracts'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type * as Option from 'effect/Option'
import type { AppError } from '../http/errors.ts'
import type { NewInvocation } from './invocations.ts'
import type { PersonaActor } from './registry.ts'

/** What `create` answers: the Persona, and whether this call made it rather than finding it by its operation id. */
type MadePersona = { readonly persona: PersonaView; readonly created: boolean }

/**
 * The owner's Personas (ADR 0033): named, versioned agent definitions. Every change is a new revision of the one it
 * names (`expectedRevision`), a model must be one the deployment offers, and archiving keeps the history and frees the
 * name.
 */
export class Personas extends Context.Service<
  Personas,
  {
    /** Every Persona, archived ones included, in creation order. */
    readonly list: Effect.Effect<readonly PersonaView[]>
    /** The Personas that can answer now. */
    readonly active: Effect.Effect<readonly PersonaView[]>
    /** One Persona; `NotFound` when there is none with `id`. */
    readonly get: (id: number) => Effect.Effect<PersonaView, AppError>
    /** The active Persona named `name`, ignoring case. */
    readonly byName: (name: string) => Effect.Effect<Option.Option<PersonaView>>
    /** A Persona with its revisions, newest first. */
    readonly detail: (id: number) => Effect.Effect<PersonaDetail, AppError>
    /** One stored revision, as an invocation froze it. */
    readonly revision: (id: number, revision: number) => Effect.Effect<PersonaRevisionView, AppError>
    /** Whether this deployment offers `model` now. */
    readonly offers: (model: string | undefined) => Effect.Effect<boolean>
    /** A new Persona at revision 1, or the one `input.operationId` already made. A taken name is a `Conflict`. */
    readonly create: (input: CreatePersona, actor: PersonaActor, now: number) => Effect.Effect<MadePersona, AppError>
    /** A new revision with `change` applied, if `change.expectedRevision` is the current one (else `Conflict`). */
    readonly update: (
      id: number,
      change: UpdatePersona,
      actor: PersonaActor,
      now: number,
    ) => Effect.Effect<PersonaView, AppError>
  }
>()('goblin/personas/Personas') {}

/**
 * Which Persona answers which owner message, and how far it got (ADR 0033). A settled invocation never moves again, so
 * a replayed step or a Stop after the answer changes nothing.
 */
export class Invocations extends Context.Service<
  Invocations,
  {
    /** Records the tagged Personas of one send, once per operation and Persona; answers the rows it wrote. */
    readonly insert: (
      invocations: readonly NewInvocation[],
      now: number,
    ) => Effect.Effect<readonly PersonaInvocationView[]>
    readonly get: (operationId: string, persona: number) => Effect.Effect<Option.Option<PersonaInvocationView>>
    /** The invocations not settled yet, oldest first. */
    readonly live: Effect.Effect<readonly PersonaInvocationView[]>
    /** Every invocation of one send, in order. */
    readonly of: (operationId: string) => Effect.Effect<readonly PersonaInvocationView[]>
    /** The Persona started working; only a pending invocation moves. */
    readonly running: (operationId: string, persona: number) => Effect.Effect<void>
    /** Settles one invocation; a settled one stays as it is. */
    readonly settle: (
      operationId: string,
      persona: number,
      state: 'answered' | 'failed' | 'stopped',
      now: number,
      answerEntry?: number,
    ) => Effect.Effect<void>
    /** Stops every unsettled invocation in `chat` (the owner's Stop); answers how many it stopped. */
    readonly stopChat: (chat: string, now: number) => Effect.Effect<number>
  }
>()('goblin/personas/Invocations') {}
