import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { channelOf } from '../../../lib/topics.ts'
import { useConversations, useTopics } from '../../../lib/workspace/hooks.ts'

/** A row of a rail page that opens a chat where it lives: a channel as itself, a thread or subagent in its panel. */
export function ChatRow({
  chat,
  unread = false,
  children,
}: {
  readonly chat: string
  readonly unread?: boolean
  readonly children: ReactNode
}) {
  const channel = channelOf(chat, useConversations(), useTopics())
  return (
    <Link
      to="/c/$chatId"
      params={{ chatId: channel }}
      search={channel === chat ? {} : { thread: Number(chat) }}
      className="list-row"
      data-unread={unread || undefined}
    >
      {children}
    </Link>
  )
}

/** A row of a rail page: its mark, its title with a quiet line under it, and what it is doing at its end. */
export function RowContents({
  mark,
  title,
  meta,
  end,
}: {
  readonly mark: ReactNode
  readonly title: ReactNode
  readonly meta?: ReactNode
  readonly end?: ReactNode
}) {
  return (
    <>
      <span className="list-row-mark">{mark}</span>
      <span className="list-row-main">
        <span className="list-row-title">{title}</span>
        {meta !== undefined && <span className="list-row-meta">{meta}</span>}
      </span>
      {end}
    </>
  )
}
