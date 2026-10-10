import * as Schema from 'effect/Schema'

/** A string of 1 to `max` characters. */
export const NonEmptyString = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max))

/** A logical chat id: a Topic's Conversation or a Thread (ADR 0030). URLs carry it as `/c/<id>`. */
export const ChatId = Schema.String.check(Schema.isPattern(/^\d{1,12}$/u))
export type ChatId = typeof ChatId.Type

/** An App's id (ADRs 0020, 0021): 1 to 12 digits. */
export const AppId = Schema.String.check(Schema.isPattern(/^\d{1,12}$/u))
export type AppId = typeof AppId.Type

/** A client-chosen id that makes a write idempotent: the same id finds the same result. */
export const OperationId = NonEmptyString(200)
export type OperationId = typeof OperationId.Type

/** Topic ids are positive integers; Personal is always 1. */
export const TopicId = Schema.Int.check(Schema.isGreaterThan(0))
export type TopicId = typeof TopicId.Type
export const PERSONAL_TOPIC = 1

/** Persona ids are positive integers. */
export const PersonaId = Schema.Int.check(Schema.isGreaterThan(0))
export type PersonaId = typeof PersonaId.Type

/** A Pi entry id: positive, unique across the agent's sessions. */
export const EntryId = Schema.Int.check(Schema.isGreaterThan(0))
