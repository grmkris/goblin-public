import {
  AppView,
  ConversationActivity,
  ConversationView,
  DecisionProposal,
  OrganizeReceipt,
  PersonaInvocationView,
  PersonaView,
  TopicView,
  WorkspaceChange,
  type WorkspaceSnapshot,
} from '@goblin/contracts'
import { Option, Schema } from 'effect'

const Items = Schema.Array(Schema.Unknown)
const decodeSnapshotFrame = Schema.decodeUnknownSync(
  Schema.Struct({
    conversations: Items,
    activity: Items,
    apps: Items,
    topics: Schema.optional(Items),
    personas: Schema.optional(Items),
    invocations: Schema.optional(Items),
    receipts: Schema.optional(Items),
    proposals: Schema.optional(Items),
  }),
)
const decodeChangeFrame = Schema.decodeUnknownSync(Items)
const decodeConversation = Schema.decodeUnknownOption(ConversationView)
const decodeActivity = Schema.decodeUnknownOption(ConversationActivity)
const decodeApp = Schema.decodeUnknownOption(AppView)
const decodeChange = Schema.decodeUnknownOption(WorkspaceChange)

/** The items `decode` reads, in order: one this tab cannot read (a newer server's kind or field) is skipped. */
const readable = <A>(items: readonly unknown[], decode: (item: unknown) => Option.Option<A>): A[] =>
  items.flatMap((item) => Option.toArray(decode(item)))

/**
 * A snapshot frame: its shape must hold, but each conversation, activity and App is read on its own, so a server newer
 * than this tab never stops the feed. A frame of another shape throws, and the connection starts again.
 */
export function decodeSnapshot(data: unknown): WorkspaceSnapshot {
  const frame = decodeSnapshotFrame(data)
  const { topics, personas, invocations, receipts, proposals } = frame
  return {
    conversations: readable(frame.conversations, decodeConversation),
    activity: readable(frame.activity, decodeActivity),
    apps: readable(frame.apps, decodeApp),
    ...(topics !== undefined && { topics: readable(topics, Schema.decodeUnknownOption(TopicView)) }),
    ...(personas !== undefined && { personas: readable(personas, Schema.decodeUnknownOption(PersonaView)) }),
    ...(invocations !== undefined && {
      invocations: readable(invocations, Schema.decodeUnknownOption(PersonaInvocationView)),
    }),
    ...(receipts !== undefined && { receipts: readable(receipts, Schema.decodeUnknownOption(OrganizeReceipt)) }),
    ...(proposals !== undefined && { proposals: readable(proposals, Schema.decodeUnknownOption(DecisionProposal)) }),
  }
}

/** A change frame: a list, of which each change this tab can read applies and any other is skipped. */
export const decodeChanges = (data: unknown): WorkspaceChange[] => readable(decodeChangeFrame(data), decodeChange)
