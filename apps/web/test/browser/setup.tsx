import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { EVERYTHING, type TopicView, type WorkspaceSnapshot } from '@goblin/contracts'
import { Button } from '@goblin/ui'
import { TopicSetupDrawer } from '../../src/components/topic-setup.tsx'
import { withQueryClient } from './with-query-client.tsx'
import '../../src/styles.css'

/** Topic 2 "Work", holding everything until the fixture's owner chooses. */
const WORK: TopicView = {
  id: 2,
  name: 'Work',
  conversation: '20',
  searchExcluded: false,
  revision: 3,
  setup: EVERYTHING,
  createdBy: 'owner',
  createdAt: 1,
}

const WORKSPACE: WorkspaceSnapshot = {
  conversations: [],
  activity: [],
  apps: [],
  topics: [WORK],
  personas: [],
  invocations: [],
  receipts: [],
}

/** The real setup drawer over a Topic, opened by a button as the Topic menu opens it. */
function Fixture() {
  const [open, setOpen] = useState(true)
  return (
    <main className="p-4">
      <Button type="button" onClick={() => setOpen(true)}>
        Open setup
      </Button>
      <TopicSetupDrawer topic={WORK} open={open} onOpenChange={setOpen} />
    </main>
  )
}

// The app's theme script is not on a fixture page: follow the colour scheme the browser asks for.
document.documentElement.classList.toggle('dark', matchMedia('(prefers-color-scheme: dark)').matches)

const root = document.getElementById('root')
if (root) createRoot(root).render(withQueryClient(<Fixture />, WORKSPACE))
