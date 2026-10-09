import { createFileRoute, redirect } from '@tanstack/react-router'
import { OwnerGate } from '../components/owner-gate.tsx'
import { ChannelPage } from '../components/shell/channel.tsx'
import { sourcesQuery } from '../conversations/queries.ts'
import { parsePanelSearch } from '../lib/panel.ts'
import { primeOwnerRead } from '../lib/prime.ts'
import { reportUnexpected } from '../lib/unexpected.ts'

/**
 * A Topic's channel (`/c/<id>`), with the thread panel its search names (`?thread=`, `?reply=`, `?stack=`); a thread's
 * or a subagent's id opens its channel with the panel showing it. Its transcript is the chat's live stream; the loader
 * primes, without waiting for them, the sources noted under the answers of the channel and of its open thread.
 */
export const Route = createFileRoute('/c/$chatId')({
  validateSearch: parsePanelSearch,
  loaderDeps: ({ search }) => ({ thread: search.thread }),
  beforeLoad: ({ params }) => {
    if (!/^\d{1,12}$/u.test(params.chatId)) throw redirect({ to: '/' })
  },
  loader: ({ context, params, deps }) => {
    const chats = deps.thread === undefined ? [params.chatId] : [params.chatId, String(deps.thread)]
    for (const chat of chats) primeOwnerRead(context.queryClient, sourcesQuery(chat)).catch(reportUnexpected)
  },
  component: ChannelRoute,
})

function ChannelRoute() {
  const { chatId } = Route.useParams()
  const search = Route.useSearch()
  return (
    <OwnerGate>
      <ChannelPage chat={chatId} search={search} />
    </OwnerGate>
  )
}
