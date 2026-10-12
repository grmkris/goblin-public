import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { Attention, NotificationView, OrganizeReceipt, ServerView } from '@goblin/contracts'
import { Button } from '@goblin/ui'
import {
  AlarmClockIcon,
  AppWindowIcon,
  BellIcon,
  CircleDotIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  LayersIcon,
  MessageCircleQuestionIcon,
  MessageSquareTextIcon,
  PlugIcon,
  RadioTowerIcon,
  Settings2Icon,
  WandSparklesIcon,
} from 'lucide-react'
import { type NeedsYou, needsYou, unreadChats, unreadNotifications } from '../../../lib/rail.ts'
import { threadTitle } from '../../../lib/threads.ts'
import { useApps, useConversations, useNotifications, useReceipts } from '../../../lib/workspace/hooks.ts'
import { undoWorkspaceReceiptMutation } from '../../../lib/workspace/mutations.ts'
import { dismissEventsMutation, serversQuery } from '../../../mcp/queries.ts'
import { readNotificationsMutation } from '../../../notices/queries.ts'
import { connectionAnchor } from '../../server-card.tsx'
import { PageSection } from '../../page-section.tsx'
import { useMinute } from '../../use-now.ts'
import { undoRefusal } from '../organize.ts'
import { messageOf } from '../../../lib/query/app-error.ts'
import { ChatRow, RowContents } from './chat-link.tsx'
import { ConnectOffers, useConnectOffers } from '../../connect-offer.tsx'
import { relativeTime } from '../../../lib/format.ts'

const ASKS: Readonly<Record<Attention['kind'], { readonly icon: typeof KeyRoundIcon; readonly label: string }>> = {
  question: { icon: MessageCircleQuestionIcon, label: 'A question for you' },
  approval: { icon: KeyRoundIcon, label: 'A call to approve' },
  grant: { icon: KeyRoundIcon, label: 'A tool to allow' },
  setup: { icon: Settings2Icon, label: 'Something to add to a Topic' },
  'app-power': { icon: AppWindowIcon, label: 'An app power to allow' },
  access: { icon: KeyRoundIcon, label: 'A connection that needs more access' },
  connect: { icon: PlugIcon, label: 'A connection to sign in to' },
  link: { icon: ExternalLinkIcon, label: 'A step to finish on a server’s site' },
}

/** One thing that waits for the owner, linked to where it waits. */
function NeedRow({ need, now }: { readonly need: NeedsYou; readonly now: number }) {
  if (need.kind === 'app')
    return (
      <li>
        <Link
          to="/apps/$name"
          params={{ name: need.app.source.kind === 'agent' ? need.app.source.name : need.app.title }}
          className="list-row"
        >
          <RowContents mark={<AppWindowIcon aria-hidden />} title={need.app.title} meta="Its schedule needs you" />
        </Link>
      </li>
    )
  const ask = ASKS[need.attention.kind]
  const Icon = ask.icon
  return (
    <li>
      <ChatRow chat={need.chat.id}>
        <RowContents
          mark={<Icon aria-hidden />}
          title={need.attention.label === undefined ? ask.label : `${ask.label}: ${need.attention.label}`}
          meta={`${threadTitle(need.chat)} · ${relativeTime(need.attention.since, now)}`}
        />
      </ChatRow>
    </li>
  )
}

const SOURCES: Readonly<Record<NotificationView['source'], typeof BellIcon>> = {
  event: BellIcon,
  reminder: AlarmClockIcon,
  report: MessageSquareTextIcon,
  digest: LayersIcon,
}

/** How many read notifications Activity shows under the unread ones at first; Show older adds as many again. */
const READ_SHOWN = 10

/** A notification (ADR 0041), linked to the chat it was posted in: opening the chat reads it. */
function NotificationRow({
  notification,
  unread,
  now,
}: {
  readonly notification: NotificationView
  readonly unread: boolean
  readonly now: number
}) {
  const Icon = SOURCES[notification.source]
  return (
    <li>
      <ChatRow chat={notification.chat} unread={unread}>
        <RowContents
          mark={<Icon aria-hidden />}
          title={notification.title}
          meta={`${notification.label} · ${relativeTime(notification.at, now)}`}
        />
      </ChatRow>
    </li>
  )
}

/** Tell me's notifications: the unread ones, then the newest read, with Mark all read while any is unread. */
function Notifications({
  notifications,
  unread,
  now,
}: {
  readonly notifications: readonly NotificationView[]
  readonly unread: readonly NotificationView[]
  readonly now: number
}) {
  const reading = useMutation(readNotificationsMutation)
  const [shown, setShown] = useState(READ_SHOWN)
  const fresh = new Set(unread)
  const older = notifications.filter((notification) => !fresh.has(notification))
  const read = older.slice(0, shown)
  return (
    <PageSection
      id="notifications"
      title="Notifications"
      {...(unread.length > 0 && { count: unread.length })}
      action={
        unread.length > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            pending={reading.isPending}
            onClick={() => reading.mutate(unread.map(({ id }) => id))}
          >
            Mark all read
          </Button>
        ) : undefined
      }
    >
      <ul className="list-rows">
        {[...unread, ...read].map((notification) => (
          <NotificationRow
            key={notification.id}
            notification={notification}
            unread={fresh.has(notification)}
            now={now}
          />
        ))}
      </ul>
      {older.length > shown && (
        <Button variant="ghost" size="sm" onClick={() => setShown((count) => count + READ_SHOWN)}>
          Show older
        </Button>
      )}
    </PageSection>
  )
}

/** A connection whose events the owner has not set up yet (ADR 0041): Set up on its card, or Not now. */
function EventOfferRow({ server }: { readonly server: ServerView }) {
  const dismissing = useMutation(dismissEventsMutation)
  // expected: a dismissal that failed shows why in place of the row's line, and the row stays
  const error = dismissing.error === null ? '' : messageOf(dismissing.error, 'dismiss it')
  return (
    <li className="list-row" data-static>
      <RowContents
        mark={<RadioTowerIcon aria-hidden />}
        title={`Set up events for ${server.label}`}
        meta={error === '' ? 'Choose what goblin does with what it sends' : error}
        end={
          <span className="row-actions">
            <Button
              variant="ghost"
              size="sm"
              pending={dismissing.isPending}
              onClick={() => dismissing.mutate(server.connectionId)}
            >
              Not now
            </Button>
            <Button
              variant="outline"
              size="sm"
              nativeButton={false}
              render={<Link to="/connections" hash={connectionAnchor(server.connectionId)} />}
            >
              Set up
            </Button>
          </span>
        }
      />
    </li>
  )
}

/** What organizing did (a Topic made, renamed, archived; a Persona changed), with Undo while nothing else touched it. */
function ReceiptRow({ receipt, now }: { readonly receipt: OrganizeReceipt; readonly now: number }) {
  const undo = useMutation(undoWorkspaceReceiptMutation)
  // expected: the receipt's row shows why it cannot be undone in place of its time
  const error = undo.error === null ? '' : undoRefusal(undo.error)
  const who = receipt.actor === 'agent' ? 'Goblin' : 'You'
  return (
    <li className="list-row" data-static>
      <RowContents
        mark={<WandSparklesIcon aria-hidden />}
        title={receipt.summary}
        meta={error === '' ? `${who} · ${relativeTime(receipt.at, now)}` : error}
        end={
          receipt.undoneAt !== undefined ? (
            <span className="list-row-meta">Undone</span>
          ) : (
            receipt.undoable && (
              <Button variant="outline" size="sm" pending={undo.isPending} onClick={() => undo.mutate(receipt.id)}>
                Undo
              </Button>
            )
          )
        }
      />
    </li>
  )
}

/**
 * `/activity`: what needs the owner across every Topic (questions, approvals, grants, App schedules), linked to where
 * it waits; Tell me's notifications; the chats with unread replies; and what organizing did, with Undo.
 */
export function ActivityPage() {
  const conversations = useConversations()
  const receipts = useReceipts()
  const notifications = useNotifications()
  const now = useMinute()
  const needs = needsYou(conversations, useApps())
  const unread = unreadChats(conversations)
  const offers = (useQuery(serversQuery).data ?? []).filter((server) => server.events === 'open')
  const connects = useConnectOffers()
  if (needs.length + offers.length + connects.count + notifications.length + receipts.length + unread.length === 0)
    return <p className="page-empty">Nothing needs you.</p>
  return (
    <div className="page-stack">
      <ConnectOffers connects={connects} />
      {needs.length > 0 && (
        <PageSection id="needs" title="Needs you" count={needs.length}>
          <ul className="list-rows">
            {needs.map((need) => (
              <NeedRow
                key={
                  need.kind === 'app'
                    ? `app:${need.app.id}`
                    : `${need.chat.id}:${need.attention.kind}:${need.attention.since}:${String(need.attention.entry ?? '')}:${need.attention.label ?? ''}`
                }
                need={need}
                now={now}
              />
            ))}
          </ul>
        </PageSection>
      )}
      {offers.length > 0 && (
        <PageSection id="event-offers" title="Set up events">
          <ul className="list-rows">
            {offers.map((server) => (
              <EventOfferRow key={server.connectionId} server={server} />
            ))}
          </ul>
        </PageSection>
      )}
      {notifications.length > 0 && (
        <Notifications
          notifications={notifications}
          unread={unreadNotifications(notifications, conversations)}
          now={now}
        />
      )}
      {unread.length > 0 && (
        <PageSection id="unread" title="Unread" count={unread.length}>
          <ul className="list-rows">
            {unread.map((view) => (
              <li key={view.id}>
                <ChatRow chat={view.id} unread>
                  <RowContents
                    mark={<CircleDotIcon aria-hidden />}
                    title={threadTitle(view)}
                    meta={view.lastReplyAt === undefined ? undefined : relativeTime(view.lastReplyAt, now)}
                  />
                </ChatRow>
              </li>
            ))}
          </ul>
        </PageSection>
      )}
      {receipts.length > 0 && (
        <PageSection id="organized" title="Organized">
          <ul className="list-rows">
            {receipts.map((receipt) => (
              <ReceiptRow key={receipt.id} receipt={receipt} now={now} />
            ))}
          </ul>
        </PageSection>
      )}
    </div>
  )
}
