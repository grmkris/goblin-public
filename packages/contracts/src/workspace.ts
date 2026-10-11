import * as Schema from 'effect/Schema'
import { AppView } from './apps.ts'
import { ConversationActivity, ConversationView } from './conversations.ts'
import { DecisionProposal } from './decisions.ts'
import { HomeLayout } from './home.ts'
import { NotificationView } from './notices.ts'
import { PersonaInvocationView, PersonaView } from './personas.ts'
import { OrganizeReceipt, TopicView } from './topics.ts'

/** The workspace feed's first event: every conversation and App, and the conversations not idle. */
export const WorkspaceSnapshot = Schema.Struct({
  primary: Schema.optional(Schema.String),
  conversations: Schema.Array(ConversationView),
  activity: Schema.Array(ConversationActivity),
  apps: Schema.Array(AppView),
  home: Schema.optional(HomeLayout),
  topics: Schema.optional(Schema.Array(TopicView)),
  personas: Schema.optional(Schema.Array(PersonaView)),
  /** Persona answers not yet settled, so a reload still shows who is answering. */
  invocations: Schema.optional(Schema.Array(PersonaInvocationView)),
  /** Recent organizing receipts, newest first, for Activity and Undo. */
  receipts: Schema.optional(Schema.Array(OrganizeReceipt)),
  /** The newest open and confirmed decision proposals (ADR 0031), oldest first. */
  proposals: Schema.optional(Schema.Array(DecisionProposal)),
  /** The newest notifications of the last thirty days (ADR 0041), newest first. */
  notifications: Schema.optional(Schema.Array(NotificationView)),
})
export type WorkspaceSnapshot = typeof WorkspaceSnapshot.Type

/** One change the workspace feed sends after its snapshot: a conversation or App as it is now, or what one is doing. */
export const WorkspaceChange = Schema.Union([
  Schema.Struct({ type: Schema.Literal('home'), home: HomeLayout }),
  Schema.Struct({ type: Schema.Literal('conversation'), conversation: ConversationView }),
  Schema.Struct({ type: Schema.Literal('activity'), activity: ConversationActivity }),
  Schema.Struct({ type: Schema.Literal('app'), app: AppView }),
  /** An App that is gone: the owner deleted the agent app it showed. */
  Schema.Struct({ type: Schema.Literal('app-removed'), id: Schema.String }),
  Schema.Struct({ type: Schema.Literal('topic'), topic: TopicView }),
  Schema.Struct({ type: Schema.Literal('persona'), persona: PersonaView }),
  Schema.Struct({ type: Schema.Literal('invocation'), invocation: PersonaInvocationView }),
  Schema.Struct({ type: Schema.Literal('receipt'), receipt: OrganizeReceipt }),
  /** A decision proposal as it is now: a new one, or one the owner labelled or a newer exchange made stale. */
  Schema.Struct({ type: Schema.Literal('proposal'), proposal: DecisionProposal }),
  /** A notification as it is now: a new one, or one the owner read. */
  Schema.Struct({ type: Schema.Literal('notification'), notification: NotificationView }),
])
export type WorkspaceChange = typeof WorkspaceChange.Type
