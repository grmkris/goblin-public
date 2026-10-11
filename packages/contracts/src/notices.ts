import * as Schema from 'effect/Schema'

/** Where a notice came from (ADR 0041): an event of a connection, a routine's reminder, or a digest of a burst. */
export const NoticeSource = Schema.Literals(['event', 'reminder', 'digest'])
export type NoticeSource = typeof NoticeSource.Type

/**
 * A notice as the transcript keeps it (`app.notice`, ADR 0041): what Tell me posts for an event or a reminder, in plain
 * text with at most one http(s) link, attributed to the connection it came from (or to the routine). The text is the
 * producer's, untrusted: the model reads it framed as data, never as an instruction.
 */
export const NoticeData = Schema.Struct({
  notice: Schema.String,
  routine: Schema.String,
  source: NoticeSource,
  from: Schema.Struct({ connectionId: Schema.optional(Schema.String), label: Schema.String }),
  title: Schema.String,
  body: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  event: Schema.optional(Schema.Struct({ name: Schema.String, occurredAt: Schema.Number })),
  /** A digest's count: how many notices past the hour's cap it stands for. */
  folded: Schema.optional(Schema.Int),
})
export type NoticeData = typeof NoticeData.Type

/**
 * A notification as Activity lists it (ADR 0041): an event's notice, a reminder, a digest or a hand-over's answer,
 * from whom, its title and link, in which chat, and when the owner read it there. Times are in seconds. It is unread
 * while `readAt` is null and the chat's read mark is older.
 */
export const NotificationView = Schema.Struct({
  id: Schema.String,
  source: Schema.Literals(['event', 'reminder', 'report', 'digest']),
  chat: Schema.String,
  label: Schema.String,
  title: Schema.String,
  url: Schema.optional(Schema.String),
  at: Schema.Number,
  readAt: Schema.NullOr(Schema.Number),
})
export type NotificationView = typeof NotificationView.Type

/** Notifications the owner read in Activity, at most two hundred at once. */
export const NotificationsRead = Schema.Struct({ ids: Schema.Array(Schema.String).check(Schema.isMaxLength(200)) })
export type NotificationsRead = typeof NotificationsRead.Type
