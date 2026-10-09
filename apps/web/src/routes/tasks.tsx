import { createFileRoute } from '@tanstack/react-router'
import { OwnerGate } from '../components/owner-gate.tsx'
import { PageBar } from '../components/page-bar.tsx'
import { TasksPage } from '../components/shell/pages/tasks-page.tsx'

export const Route = createFileRoute('/tasks')({ component: TasksRoute })
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
