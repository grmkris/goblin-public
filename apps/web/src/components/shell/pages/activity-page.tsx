import { useMutation } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { Attention, OrganizeReceipt } from '@goblin/contracts'
import { Button } from '@goblin/ui'
import {
  AppWindowIcon,
  CircleDotIcon,
  KeyRoundIcon,
  MessageCircleQuestionIcon,
  PowerIcon,
  WandSparklesIcon,
} from 'lucide-react'
import { type NeedsYou, needsYou, unreadChats } from '../../../lib/rail.ts'
import { threadTitle } from '../../../lib/threads.ts'
import { useApps, useConversations, useReceipts } from '../../../lib/workspace/hooks.ts'
import { undoWorkspaceReceiptMutation } from '../../../lib/workspace/mutations.ts'
import { PageSection } from '../../page-section.tsx'
import { useMinute } from '../../use-now.ts'
import { undoRefusal } from '../organize.ts'
import { ChatRow, RowContents } from './chat-link.tsx'
import { relativeTime } from '../../../lib/format.ts'

const ASKS: Readonly<Record<Attention['kind'], { readonly icon: typeof KeyRoundIcon; readonly label: string }>> = {
  question: { icon: MessageCircleQuestionIcon, label: 'A question for you' },
  approval: { icon: KeyRoundIcon, label: 'A call to approve' },
  grant: { icon: KeyRoundIcon, label: 'A tool to allow' },
  capability: { icon: PowerIcon, label: 'Something to turn on' },
  'app-power': { icon: AppWindowIcon, label: 'An app power to allow' },
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
          title={need.attention.label ?? ask.label}
          meta={`${threadTitle(need.chat)} · ${relativeTime(need.attention.since, now)}`}
        />
      </ChatRow>
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
 * it waits; what organizing did, with Undo; and the chats with unread replies.
 */
export function ActivityPage() {
  const conversations = useConversations()
  const receipts = useReceipts()
  const now = useMinute()
  const needs = needsYou(conversations, useApps())
  const unread = unreadChats(conversations)
  if (needs.length + receipts.length + unread.length === 0) return <p className="page-empty">Nothing needs you.</p>
  return (
    <div className="page-stack">
      {needs.length > 0 && (
        <PageSection id="needs" title="Needs you" count={needs.length}>
          <ul className="list-rows">
            {needs.map((need) => (
              <NeedRow
                key={
                  need.kind === 'app'
                    ? `app:${need.app.id}`
                    : `${need.chat.id}:${need.attention.kind}:${need.attention.since}`
                }
                need={need}
                now={now}
              />
            ))}
          </ul>
        </PageSection>
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
