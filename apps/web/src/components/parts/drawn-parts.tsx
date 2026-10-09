// The parts of entries the app writes into a chat itself (lib/parts.ts): a Thread's head, the owner's message to
// Personas, a Persona's answer, a Topic's brief and a Delegate's result. Each is attributed: who wrote it shows first.
import { use } from 'react'
import { CornerDownRightIcon, MessagesSquareIcon, SparklesIcon } from 'lucide-react'
import type { Part } from '../../lib/parts.ts'
import { PersonaAvatar } from '../persona-avatar.tsx'
import { MessageFiles } from '../attachments.tsx'
import { Cause, MessageText, OpenThread } from './text-part.tsx'

type Of<K extends Part['kind']> = Extract<Part, { readonly kind: K }>

/** A link to a thread where the transcript can open one, else its name alone. */
function ThreadLink({ thread, label }: { readonly thread: string; readonly label: string }) {
  const open = use(OpenThread)
  if (open === undefined) return <span>{label}</span>
  return (
    <button type="button" className="cause-link" onClick={() => open(thread)}>
      {label}
    </button>
  )
}

/** The head of a Thread that started here: the message, and the way into the Thread its reply went to. */
export function ThreadHeadPart({ part }: { readonly part: Of<'thread-head'> }) {
  return (
    <>
      {part.author !== undefined && <p className="message-author">{part.author}</p>}
      <article className="bubble bubble-user">
        <p className="message-text">{part.text}</p>
      </article>
      <p className="cause-line thread-head-line">
        <MessagesSquareIcon aria-hidden />
        <span>
          {part.moved ? 'Moved to a thread' : 'Started a thread'} ·{' '}
          <ThreadLink thread={part.thread} label="Open the thread" />
        </span>
      </p>
    </>
  )
}

/** The owner's message to Personas: their words, and whom they asked, together or one after another. */
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

/** A Persona's answer, under its mark and name. */
export function PersonaAnswerPart({ part }: { readonly part: Of<'persona-answer'> }) {
  return (
    <article className="bubble bubble-assistant">
      <p className="persona-byline">
        <PersonaAvatar avatar={part.avatar} size="sm" />
        <b>{part.name}</b>
      </p>
      <MessageText text={part.text} />
    </article>
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

const ENDED = { done: 'finished', failed: 'failed', stopped: 'was stopped' } as const

/** A Delegate's result posted back here: who did the work, how it ended, its report, and the way into its task. */
export function DelegateResultPart({ part }: { readonly part: Of<'delegate-result'> }) {
  return (
    <Cause
      icon={<CornerDownRightIcon aria-hidden />}
      line={
        <>
          <ThreadLink thread={part.delegate} label={part.name} /> {ENDED[part.status]}
        </>
      }
      text={part.text}
    />
  )
}
