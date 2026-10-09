// What a chat's header shows beyond its name: a mark of what it is (a thread, or a subagent's state), a subagent's
// state in words, and a subagent's own actions in the panel's menu.
import type { ConversationView } from '@goblin/contracts'
import { DropdownMenuItem } from '@goblin/ui'
import { MessagesSquareIcon, PinIcon, SquareIcon } from 'lucide-react'
import { isBusy, subagentState, workingUnder } from '../../lib/subagent-state.ts'
import { SubagentStateIcon, SubagentStateText, useSubagent } from '../parts/subagent-block.tsx'
import { useWorkspaceFeed } from '../workspace-feed.tsx'

/** What a chat is, as a small mark: a thread, or a subagent's state. */
export function KindMark({ view }: { readonly view: ConversationView }) {
  const { activity } = useWorkspaceFeed()
  if (view.kind === 'subagent') return <SubagentStateIcon state={subagentState(view, activity.get(view.id))} />
  return <MessagesSquareIcon aria-hidden />
}

/** A subagent's state in its header: its clock while it works, else where it stands. */
export function SubagentState({ view }: { readonly view: ConversationView }) {
  const { activity } = useWorkspaceFeed()
  return (
    <span className="chat-state">
      <SubagentStateText state={subagentState(view, activity.get(view.id))} />
    </span>
  )
}

/** A subagent's own actions in its menu: Stop it and all under it while anything works, and Keep open past its report. */
export function SubagentMenuItems({ view }: { readonly view: ConversationView }) {
  const subagent = useSubagent(view)
  const feed = useWorkspaceFeed()
  const closed = subagent.state.kind === 'closed'
  const below = workingUnder(view.id, feed.conversations, feed.activity)
  return (
    <>
      {!closed && isBusy(subagent.state, below) && (
        <DropdownMenuItem onClick={subagent.stop}>
          <SquareIcon aria-hidden />
          {below > 0 ? 'Stop it and all under it' : 'Stop'}
        </DropdownMenuItem>
      )}
      {!closed && !view.keepOpen && (
        <DropdownMenuItem onClick={subagent.keepOpen}>
          <PinIcon aria-hidden />
          Keep open after its report
        </DropdownMenuItem>
      )}
    </>
  )
}
