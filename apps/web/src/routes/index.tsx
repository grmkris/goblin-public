import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Badge, Button } from '@purrable/ui'
import { Authentication } from '../components/authentication.tsx'
import { Conversation } from '../components/conversation.tsx'
import { McpWorkspace } from '../components/mcp-workspace.tsx'
import { record, request } from '../lib/boundary.ts'

export const Route = createFileRoute('/')({ component: Home })
function Home() {
  const [authenticated, setAuthenticated] = useState(false)
  const [checking, setChecking] = useState(true)
  useEffect(() => {
    const controller = new AbortController()
    void request('/api/auth/get-session', undefined, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setAuthenticated(record(record(data)?.user) !== undefined)
      })
      .catch(() => undefined)
      .finally(() => {
        if (!controller.signal.aborted) setChecking(false)
      })
    return () => controller.abort()
  }, [])
  async function signOut(): Promise<void> {
    await request('/api/auth/sign-out', {})
    setAuthenticated(false)
  }
  if (checking) return <p role="status">Opening your workspace…</p>
  if (!authenticated) return <Authentication onAuthenticated={() => setAuthenticated(true)} />
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-3">
        <Badge variant="secondary">Private owner workspace</Badge>
        <Button variant="ghost" onClick={() => void signOut()}>
          Sign out
        </Button>
      </div>
      <Conversation />
      <McpWorkspace />
    </div>
  )
}
