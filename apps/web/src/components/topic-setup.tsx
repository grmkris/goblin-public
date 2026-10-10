import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { RoutineOutsideSetup, TopicSetup, TopicView } from '@goblin/contracts'
import {
  Button,
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerSide,
  DrawerTitle,
  Spinner,
  useIsMobile,
} from '@goblin/ui'
import { Settings2Icon } from 'lucide-react'
import { itemLabel } from '@goblin/contracts'
import { setupCatalogQuery } from '../setup/queries.ts'
import { messageOf } from '../lib/query/app-error.ts'
import { setWorkspaceTopicSetupMutation } from '../lib/workspace/mutations.ts'
import { useConversation, useTopics } from '../lib/workspace/hooks.ts'
import { setupSummary } from '../lib/setup.ts'
import { SetupPicker } from './setup-picker.tsx'

const same = (one: TopicSetup, other: TopicSetup) => JSON.stringify(one) === JSON.stringify(other)

/** The routines a saved setup leaves without some of their tools: each with those tools, until the owner is done. */
function RoutinesLeftShort({
  routines,
  onDone,
}: {
  readonly routines: readonly RoutineOutsideSetup[]
  readonly onDone: () => void
}) {
  return (
    <div className="setup-saved" role="status">
      <p className="font-medium">Saved. These routines can no longer use some of their tools:</p>
      <ul>
        {routines.map(({ id, title, outside }) => (
          <li key={id}>
            <span className="font-medium">{title}</span>:{' '}
            {outside.map((tool) => itemLabel({ kind: 'tool', ...tool })).join(', ')}
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground">
        A run that calls one is refused. Add them back here, or change the routine.
      </p>
      <Button type="button" onClick={onDone}>
        Done
      </Button>
    </div>
  )
}

/**
 * A Topic's setup in an editor (ADR 0040): the picker over a draft, then Save, compare-and-set on the Topic's revision so
 * an edit made meanwhile (by Goblin, in another tab) is never silently overwritten. The catalog is read again each time
 * it opens. A save that leaves routines short says which before it closes.
 */
function TopicSetupEditor({ topic, onClose }: { readonly topic: TopicView; readonly onClose: () => void }) {
  const catalog = useQuery(setupCatalogQuery)
  const [draft, setDraft] = useState<TopicSetup>(topic.setup)
  const [short, setShort] = useState<readonly RoutineOutsideSetup[]>()
  const save = useMutation(setWorkspaceTopicSetupMutation)
  if (short !== undefined) return <RoutinesLeftShort routines={short} onDone={onClose} />
  const failure =
    (save.error !== null && messageOf(save.error, 'save the setup')) ||
    (catalog.error !== null && messageOf(catalog.error, 'read what can be chosen')) ||
    ''
  return (
    <>
      <div className="setup-body">
        {catalog.data === undefined ? (
          catalog.error === null && <Spinner className="m-4" />
        ) : (
          <SetupPicker setup={draft} catalog={catalog.data} onChange={setDraft} />
        )}
      </div>
      <div className="setup-footer">
        {failure !== '' && <p className="setup-error">{failure}</p>}
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="button"
          disabled={save.isPending || same(draft, topic.setup)}
          onClick={() =>
            save.mutate(
              { id: topic.id, edit: { set: draft, expectedRevision: topic.revision } },
              { onSuccess: (saved) => (saved.routines.length === 0 ? onClose() : setShort(saved.routines)) },
            )
          }
        >
          Save
        </Button>
      </div>
    </>
  )
}

/**
 * Where a Topic's setup is edited: a panel from the right on a wide screen, a sheet from the bottom on a phone. It says
 * whose setup it is and that it applies to every chat of the Topic, Telegram and connected clients too for Personal.
 */
export function TopicSetupDrawer({
  topic,
  open,
  onOpenChange,
}: {
  readonly topic: TopicView
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}) {
  const narrow = useIsMobile()
  const description =
    topic.personal === true
      ? 'What every chat of Personal works with, Telegram and connected clients included.'
      : `What every chat of #${topic.name} works with.`
  const contents = (
    <>
      <DrawerHeader>
        <DrawerTitle>MCP servers & skills</DrawerTitle>
        <DrawerDescription>{description}</DrawerDescription>
      </DrawerHeader>
      {open && <TopicSetupEditor key={topic.revision} topic={topic} onClose={() => onOpenChange(false)} />}
    </>
  )
  return narrow ? (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>{contents}</DrawerContent>
    </Drawer>
  ) : (
    <Drawer open={open} onOpenChange={onOpenChange} swipeDirection="right">
      <DrawerSide side="right" className="w-[min(28rem,100vw)]">
        {contents}
      </DrawerSide>
    </Drawer>
  )
}

/**
 * Beside the composer: what the chat's Topic works with, in a line once it is narrowed ("2 MCP servers · 4 skills"), and
 * the way to change it. A subagent follows the chat that started it, so it has none.
 */
export function SetupButton({ chat }: { readonly chat: string }) {
  const view = useConversation(chat)
  const topic = useTopics().find((each) => each.id === (view?.topic ?? 1))
  const narrowed =
    topic !== undefined &&
    !(topic.setup.mcpServers === 'all' && topic.setup.skills === 'all' && topic.setup.apps === 'all')
  const catalog = useQuery({ ...setupCatalogQuery, enabled: narrowed })
  const [open, setOpen] = useState(false)
  if (topic === undefined || view?.kind === 'subagent') return null
  const summary = narrowed && catalog.data !== undefined ? setupSummary(topic.setup, catalog.data) : undefined
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        aria-label={`MCP servers & skills of ${topic.personal === true ? 'Personal' : `#${topic.name}`}: ${summary ?? (narrowed ? 'a chosen list' : 'everything')}`}
        onClick={() => setOpen(true)}
      >
        <Settings2Icon />
        {summary !== undefined && <span className="setup-summary">{summary}</span>}
      </Button>
      <TopicSetupDrawer topic={topic} open={open} onOpenChange={setOpen} />
    </>
  )
}
