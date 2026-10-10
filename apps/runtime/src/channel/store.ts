// The Telegram channel's rows: the connection that carries it (its Events or the doorbell), the inbox cursor, the sealed
// doorbell secret, and the turns whose answers are still to send. Plain functions over the agent's SQLite.
import type { ChannelStatus } from '@goblin/contracts'
import { and, asc, eq, isNull } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import { appChannel, appChannelReplies, appTelegramChannel } from '../storage/schema.ts'

type Db = DrizzleSqliteDODatabase

/** The channel while it is on: the connection that carries it and how. */
export type ChannelOn = NonNullable<ChannelStatus>

/** The connection that carries the channel, or null when it is off. */
export function channelStatus(db: Db): ChannelStatus {
  const events = db.select().from(appTelegramChannel).get()
  if (events !== undefined) return { serverId: events.serverId, enabledAt: events.enabledAt, transport: 'events' }
  const row = db.select({ serverId: appChannel.serverId, enabledAt: appChannel.enabledAt }).from(appChannel).get()
  return row === undefined ? null : { ...row, transport: 'doorbell' }
}

/** Whether `status` still carries the channel. */
export function carries(db: Db, status: ChannelOn): boolean {
  const current = channelStatus(db)
  return current?.serverId === status.serverId && current?.transport === status.transport
}

/** The inbox cursor stored for either transport, the Events one first; the inbox's start when there is none. */
export const storedCursor = (db: Db): string =>
  db.select().from(appTelegramChannel).get()?.inboxCursor ?? db.select().from(appChannel).get()?.cursor ?? ''

/** The inbox cursor `transport` keeps, while it carries the channel. */
export const inboxCursor = (db: Db, transport: ChannelOn['transport']): string | undefined =>
  transport === 'events'
    ? db.select().from(appTelegramChannel).get()?.inboxCursor
    : db.select().from(appChannel).get()?.cursor

/** Moves `status`'s inbox cursor to `cursor`, while the same connection still carries the channel. */
export function checkpoint(db: Db, status: ChannelOn, cursor: string): void {
  if (status.transport === 'events')
    db.update(appTelegramChannel)
      .set({ inboxCursor: cursor })
      .where(eq(appTelegramChannel.serverId, status.serverId))
      .run()
  else if (channelStatus(db)?.transport === 'doorbell')
    db.update(appChannel).set({ cursor }).where(eq(appChannel.serverId, status.serverId)).run()
}

/** `serverId`'s Events carry the channel from `cursor`; this row fences every older cursor writer. */
export function enableEvents(db: Db, serverId: string, cursor: string, now: number): ChannelStatus {
  const row = { id: 1, serverId, inboxCursor: cursor, enabledAt: now }
  db.insert(appTelegramChannel).values(row).onConflictDoUpdate({ target: appTelegramChannel.id, set: row }).run()
  return channelStatus(db)
}

/** `serverId`'s doorbell carries the channel from `cursor`, signed with the `secret` sealed under the credential key. */
export function enableDoorbell(
  db: Db,
  input: { readonly serverId: string; readonly cursor: string; readonly secret: string; readonly enabledAt: number },
): ChannelStatus {
  const row = { id: 1, ...input }
  db.insert(appChannel).values(row).onConflictDoUpdate({ target: appChannel.id, set: row }).run()
  db.delete(appTelegramChannel).run()
  return channelStatus(db)
}

/** Turns the channel off; answers still to send are dropped. */
export function disableChannel(db: Db): void {
  db.delete(appTelegramChannel).run()
  db.delete(appChannel).run()
  db.delete(appChannelReplies).run()
}

/** The doorbell secret, sealed, while the doorbell carries the channel. */
export function sealedSecret(db: Db): string | undefined {
  if (channelStatus(db)?.transport === 'events') return undefined
  return db.select({ secret: appChannel.secret }).from(appChannel).get()?.secret
}

/** Remembers a turn of main whose answer goes to Telegram, while the channel is on; whether it did. */
export function trackReply(db: Db, operationId: string, now: number): boolean {
  if (channelStatus(db) === null) return false
  db.insert(appChannelReplies).values({ operationId, createdAt: now }).onConflictDoNothing().run()
  return true
}

/** The turns whose answers are still to send, oldest first. */
export const pendingReplies = (db: Db) =>
  db
    .select()
    .from(appChannelReplies)
    .where(isNull(appChannelReplies.deliveredAt))
    .orderBy(asc(appChannelReplies.createdAt))
    .all()

/** A turn's answer went to Telegram at `now`. */
export function markDelivered(db: Db, operationId: string, now: number): void {
  db.update(appChannelReplies)
    .set({ deliveredAt: now })
    .where(and(eq(appChannelReplies.operationId, operationId), isNull(appChannelReplies.deliveredAt)))
    .run()
}
