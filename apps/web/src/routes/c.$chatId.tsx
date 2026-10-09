import { createFileRoute, redirect } from '@tanstack/react-router'
import { OwnerGate } from '../components/owner-gate.tsx'
import { ChannelPage } from '../components/shell/channel.tsx'
import { parsePanelSearch } from '../lib/panel.ts'

/**
 * A Topic's channel (`/c/<id>`), with the thread panel its search names (`?thread=`, `?reply=`, `?stack=`); a thread's
 * or a subagent's id opens its channel with the panel showing it.
 */
export const Route = createFileRoute('/c/$chatId')({
  validateSearch: parsePanelSearch,
  beforeLoad: ({ params }) => {
    if (!/^\d{1,12}$/u.test(params.chatId)) throw redirect({ to: '/' })
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
