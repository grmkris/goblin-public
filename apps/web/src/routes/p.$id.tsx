import { createFileRoute, redirect } from '@tanstack/react-router'
import { OwnerGate } from '../components/owner-gate.tsx'
import { PageBar } from '../components/page-bar.tsx'
import { PersonaPage } from '../components/shell/pages/persona-page.tsx'

/** A Persona's profile (`/p/<id>`), or a new Persona (`/p/new`). */
export const Route = createFileRoute('/p/$id')({
  beforeLoad: ({ params }) => {
    if (params.id !== 'new' && !/^\d{1,9}$/u.test(params.id)) throw redirect({ to: '/' })
  },
  component: PersonaRoute,
})
function PersonaRoute() {
  const { id } = Route.useParams()
  return (
    <OwnerGate>
      <PageBar title={id === 'new' ? 'New persona' : 'Persona'} />
      <div className="shell">
        <PersonaPage id={id === 'new' ? 'new' : Number(id)} />
      </div>
    </OwnerGate>
  )
}
