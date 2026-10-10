import { createFileRoute } from '@tanstack/react-router'
import { OwnerGate } from '../components/owner-gate.tsx'
import { PageBar } from '../components/page-bar.tsx'
import { TasksPage } from '../components/shell/pages/tasks-page.tsx'
import { primeOwnerRead } from '../lib/prime.ts'
import { routinesQuery } from '../routines/queries.ts'

/** Delegated work: the Delegates and Persona answers come from the workspace feed; the loader primes the routines. */
export const Route = createFileRoute('/tasks')({
  loader: ({ context }) => primeOwnerRead(context.queryClient, routinesQuery),
  component: TasksRoute,
})
function TasksRoute() {
  return (
    <OwnerGate>
      <PageBar title="Tasks" />
      <div className="shell">
        <TasksPage />
      </div>
    </OwnerGate>
  )
}
