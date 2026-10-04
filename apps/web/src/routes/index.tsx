import { createFileRoute } from '@tanstack/react-router'
import { MAIN_THREAD } from '@purrable/contracts'
import { Chat } from '../components/chat.tsx'
import { OwnerGate } from '../components/owner-gate.tsx'

export const Route = createFileRoute('/')({ component: Home })
function Home() {
  return (
    <OwnerGate>
      <Chat thread={MAIN_THREAD} />
    </OwnerGate>
  )
}
