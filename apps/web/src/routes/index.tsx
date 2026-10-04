import { createFileRoute } from '@tanstack/react-router'
import { Chat } from '../components/chat.tsx'
import { OwnerGate } from '../components/owner-gate.tsx'

export const Route = createFileRoute('/')({ component: Home })
function Home() {
  return (
    <OwnerGate>
      <Chat />
    </OwnerGate>
  )
}
