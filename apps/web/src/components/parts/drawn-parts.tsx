// The parts of entries the app writes into a chat itself (lib/parts.ts): a Thread's head, the owner's message to
// Personas, a Persona's answer, a Topic's brief and a Delegate's result. Who wrote each shows first, as Slack shows a
// bot's name on its message; Goblin's own answers carry no name, because Goblin answers unless someone else was asked.
import { type ReactNode, use } from 'react'
import { BellIcon, BotIcon, ExternalLinkIcon, PlugIcon, SparklesIcon } from 'lucide-react'
import type { Part } from '../../lib/parts.ts'
import { MessageFiles } from '../attachments.tsx'
import { PersonaAvatar } from '../persona-avatar.tsx'
import { usePanel } from '../shell/panel.tsx'
import { ThreadSummary } from '../shell/thread-summary.tsx'
import { useConversation } from '../../lib/workspace/hooks.ts'
import { LinkConfirm } from './link-confirm.tsx'
import { PersonaHoldCard } from './persona-hold.tsx'
import { Cause, MessageText, OpenThread } from './text-part.tsx'

type Of<K extends Part['kind']> = Extract<Part, { readonly kind: K }>

/**
 * The head of a Thread that started here: the owner's message, and under it the thread's summary, which opens it. A
 * turn moved out of this chat leaves only this head (the chat hides the turn's entries): its summary says so, and opens
 * the thread even before the feed lists it.
 */
export function ThreadHeadPart({ part }: { readonly part: Of<'thread-head'> }) {
  const panel = usePanel()
  const view = useConversation(part.thread)
  return (
    <>
      {part.author !== undefined && <p className="message-author">{part.author}</p>}
      <article className="bubble bubble-user">
        <p className="message-text">{part.text}</p>
      </article>
      <div className="thread-summaries" data-side="end">
        {view === undefined ? (
          <button type="button" className="thread-summary" onClick={() => panel.open(part.thread)}>
            <span className="thread-summary-lead">{part.moved ? 'Moved to a thread' : 'Started a thread'}</span>
          </button>
        ) : (
          <ThreadSummary view={view} {...(part.moved && { lead: 'Moved to a thread' })} />
        )}
      </div>
    </>
  )
}

/** The owner's message to Personas: whom they asked (together, or in turn), then their words. */
export function PersonaAskPart({ part }: { readonly part: Of<'persona-ask'> }) {
  const names = part.personas.map(({ name }) => `@${name}`)
  return (
    <>
      <p className="message-author">To {part.order === 'sequence' ? names.join(', then ') : names.join(', ')}</p>
      <article className="bubble bubble-user">
        <p className="message-text">{part.text}</p>
      </article>
      <MessageFiles files={part.attachments ?? []} />
    </>
  )
}

/** A message from someone other than Goblin: their mark, their name and what they are, then their words. */
function Attributed({
  mark,
  name,
  tag,
  status,
  children,
}: {
  readonly mark: ReactNode
  readonly name: string
  readonly tag: string
  readonly status?: ReactNode
  readonly children: ReactNode
}) {
  return (
    <article className="attributed">
      <span className="attributed-mark">{mark}</span>
      <p className="attributed-byline">
        <b>{name}</b>
        <span className="attributed-tag">{tag}</span>
        {status}
      </p>
      <div className="attributed-body">{children}</div>
    </article>
  )
}

/** A Persona's answer: its mark, its name, its words, and what it waits on the owner for (ADR 0041). */
export function PersonaAnswerPart({ part }: { readonly part: Of<'persona-answer'> }) {
  return (
    <Attributed mark={<PersonaAvatar avatar={part.avatar} />} name={part.name} tag="Persona">
      <MessageText text={part.text} />
      {part.hold !== undefined && <PersonaHoldCard hold={part.hold} answer={part.id} name={part.name} />}
    </Attributed>
  )
}

/** The brief a Topic made from a discussion starts with, and how many frozen excerpts came with it. */
export function TopicSeedPart({ part }: { readonly part: Of<'topic-seed'> }) {
  const sources = part.sources.length
  return (
    <Cause
      icon={<SparklesIcon aria-hidden />}
      line={
        <>Topic brief{sources > 0 && ` · ${sources} ${sources === 1 ? 'source' : 'sources'} from the discussion`}</>
      }
      text={part.brief}
    />
  )
}

const ENDED = { done: 'Done', failed: 'Failed', stopped: 'Stopped' } as const

/** A Delegate's result posted back here, as a bot's message: who did the work, how it ended, its report, its task. */
export function DelegateResultPart({ part }: { readonly part: Of<'delegate-result'> }) {
  const open = use(OpenThread)
  return (
    <Attributed
      mark={
        <span className="delegate-mark">
          <BotIcon aria-hidden />
        </span>
      }
      name={part.name}
      tag="Delegate"
      status={
        <span className="attributed-status" data-status={part.status}>
          {ENDED[part.status]}
        </span>
      }
    >
      <MessageText text={part.text} />
      {open !== undefined && (
        <button type="button" className="cause-link attributed-open" onClick={() => open(part.delegate)}>
          Open the task
        </button>
      )}
    </Attributed>
  )
}

const NOTICE_TAG = { event: 'Notice', reminder: 'Reminder', digest: 'Notice' } as const

/**
 * A notice's one link: its host, opened through the link dialog every untrusted link asks through (the producer chose
 * it), and as a plain link outside the shell.
 */
function NoticeLink({ url }: { readonly url: string }) {
  const confirm = use(LinkConfirm)
  return (
    <a
      className="cause-link attributed-open"
      href={url}
      target="_blank"
      rel="noopener noreferrer nofollow"
      onClick={(event) => {
        if (confirm === undefined) return
        event.preventDefault()
        confirm(url)
      }}
    >
      <ExternalLinkIcon aria-hidden />
      {new URL(url).host}
    </a>
  )
}

/**
 * A routine's notice (ADR 0041), as a bot's message: from the connection it came from (or the routine, for a
 * reminder), the producer's title and words as plain text, and its one link, opened outside the app.
 */
export function NoticePart({ part }: { readonly part: Of<'notice'> }) {
  return (
    <Attributed
      mark={
        <span className="delegate-mark">
          {part.source === 'reminder' ? <BellIcon aria-hidden /> : <PlugIcon aria-hidden />}
        </span>
      }
      name={part.from.label}
      tag={NOTICE_TAG[part.source]}
    >
      <p className="message-text font-medium">{part.title}</p>
      {part.body !== undefined && <p className="message-text">{part.body}</p>}
      {part.url !== undefined && <NoticeLink url={part.url} />}
    </Attributed>
  )
}
