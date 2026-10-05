import { useCallback, useEffect, useState } from 'react'
import { Schema } from 'effect'
import { MemberPolicy, MembersState, ServerView } from '@purrable/contracts'
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  FieldLabel,
  Input,
} from '@purrable/ui'
import { failureText, request } from '../lib/boundary.ts'
import { useAccountWorkspaces } from '../lib/account-workspaces.tsx'
import { useBilling } from '../lib/billing.tsx'
import { MemberAccessRequest } from './member-access-request.tsx'

const decode = Schema.decodeUnknownSync(MembersState)
const write = (path: string, body: unknown, method: 'POST' | 'DELETE' | 'PATCH' = 'POST') =>
  request(path, { method, body, headers: { 'x-purrable-csrf': '1' } })
const Grants = Schema.Array(Schema.Struct({ serverId: Schema.String, capability: Schema.String, name: Schema.String }))

export function AccountWorkspaceCard() {
  const { state, error, select } = useAccountWorkspaces()
  const [failure, setFailure] = useState('')
  const [pending, setPending] = useState(false)
  async function switchTo(id: string) {
    setPending(true)
    try {
      await select(id)
    } catch (cause) {
      setFailure(failureText(cause))
      setPending(false)
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Workspace</CardTitle>
        <CardDescription>Select your own agent or a workspace you joined.</CardDescription>
      </CardHeader>
      <CardContent>
        {(error || failure) && <p role="alert">{error || failure}</p>}
        {state === undefined ? (
          <p>Loading…</p>
        ) : (
          <div className="flex flex-col gap-3">
            {state.workspaces.map((workspace) => (
              <div className="flex items-center justify-between gap-3" key={workspace.id}>
                <div>
                  <p>
                    {workspace.name} <Badge variant="secondary">{workspace.role}</Badge>
                  </p>
                  <p className="text-sm text-muted-foreground">Owned by {workspace.ownerName}</p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending || workspace.id === state.active?.id}
                  onClick={() => void switchTo(workspace.id)}
                >
                  {workspace.id === state.active?.id ? 'Selected' : 'Select'}
                </Button>
              </div>
            ))}
            {state.workspaces.length === 0 && <p>No workspace yet. Open your invitation link to join.</p>}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function InviteForm({ onSent, onError }: { readonly onSent: () => void; readonly onError: (error: string) => void }) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'member' | 'viewer'>('member')
  const { servers, grants } = useInvitePermissions(onError)
  const [selectedServers, setSelectedServers] = useState<readonly string[]>([])
  const [selectedSkills, setSelectedSkills] = useState<readonly string[]>([])
  const [pending, setPending] = useState(false)
  const [operationId, setOperationId] = useState(() => crypto.randomUUID())
  async function send() {
    const policy = invitationPolicy(servers, grants, selectedServers, selectedSkills)
    setPending(true)
    try {
      await write('/api/invitations', { email, role, policy, operationId })
      setEmail('')
      setSelectedServers([])
      setSelectedSkills([])
      setOperationId(crypto.randomUUID())
      onSent()
    } catch (cause) {
      onError(failureText(cause))
    } finally {
      setPending(false)
    }
  }
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        void send()
      }}
    >
      <Field>
        <FieldLabel htmlFor="member-email">Email</FieldLabel>
        <Input
          id="member-email"
          type="email"
          required
          value={email}
          onChange={(event) => {
            setEmail(event.target.value)
            setOperationId(crypto.randomUUID())
          }}
        />
      </Field>
      <InviteRole
        role={role}
        onChange={(value) => {
          setRole(value)
          setSelectedServers([])
          setSelectedSkills([])
          setOperationId(crypto.randomUUID())
        }}
      />
      <InvitePermissions
        servers={servers}
        role={role}
        pending={pending}
        selectedServers={selectedServers}
        selectedSkills={selectedSkills}
        onServers={(ids) => {
          setSelectedServers(ids)
          setOperationId(crypto.randomUUID())
        }}
        onSkills={(ids) => {
          setSelectedSkills(ids)
          setOperationId(crypto.randomUUID())
        }}
      />
      <Button type="submit" disabled={pending}>
        {pending ? 'Sending…' : 'Send invitation'}
      </Button>
    </form>
  )
}

export function MembersCard() {
  const workspaces = useAccountWorkspaces()
  const billing = useBilling()
  const active = workspaces.state?.active
  const [state, setState] = useState<MembersState>()
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const load = useCallback(() => {
    void request('/api/members')
      .then((data) => setState(decode(data)))
      .catch((cause: unknown) => setError(failureText(cause)))
  }, [])
  useEffect(() => {
    setState(undefined)
    if (active !== null && active !== undefined && billing.state?.active) load()
  }, [active?.id, billing.state?.active, load])
  async function mutate(path: string, version: number, method: 'POST' | 'DELETE' = 'POST') {
    setPending(true)
    try {
      await write(path, { version, operationId: crypto.randomUUID() }, method)
      load()
      await workspaces.refresh()
    } catch (cause) {
      setError(failureText(cause))
    } finally {
      setPending(false)
    }
  }
  if (active === null || active === undefined) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle>Members</CardTitle>
        <CardDescription>
          Each person needs their own Pro plan and allowance. The owner can read every workspace conversation.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-5">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {active.role === 'owner' && !billing.state?.active ? (
            <p>Subscribe to Pro to join or manage members.</p>
          ) : active.role === 'owner' ? (
            <>
              <InviteForm onSent={load} onError={setError} />
              <OwnerRoster state={state} pending={pending} mutate={mutate} />
            </>
          ) : (
            <>
              <p>
                Your role is {active.role}.{' '}
                {active.role === 'viewer'
                  ? 'You can read permitted conversations.'
                  : 'You can instruct the agent within your permissions.'}{' '}
                The owner can read your conversations.
              </p>
              {active.role === 'viewer' && active.agentReady && <MemberAccessRequest />}
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => void mutate('/api/members/me/leave', active.memberVersion)}
              >
                Leave workspace
              </Button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function useInvitePermissions(onError: (error: string) => void) {
  const [servers, setServers] = useState<readonly ServerView[]>([])
  const [grants, setGrants] = useState<typeof Grants.Type>([])
  useEffect(() => {
    const controller = new AbortController()
    void Promise.all([
      request('/api/mcp/servers', { signal: controller.signal }),
      request('/api/mcp/grants', { signal: controller.signal }),
    ])
      .then(([available, allowed]) => {
        if (!controller.signal.aborted) {
          setServers(Schema.decodeUnknownSync(Schema.Array(ServerView))(available))
          setGrants(Schema.decodeUnknownSync(Grants)(allowed))
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) onError(failureText(cause))
      })
    return () => controller.abort()
  }, [onError])
  return { servers, grants }
}

function invitationPolicy(
  servers: readonly ServerView[],
  grants: typeof Grants.Type,
  selectedServers: readonly string[],
  selectedSkills: readonly string[],
): MemberPolicy {
  return {
    mainHistory: 'own',
    servers: servers
      .filter((server) => selectedServers.includes(server.serverId))
      .map((server) => ({
        serverId: server.serverId,
        endpoint: server.endpoint,
        tools: grants
          .filter((grant) => grant.serverId === server.serverId && grant.capability === 'tool')
          .map((grant) => grant.name),
      })),
    skills: servers
      .filter((server) => selectedSkills.includes(server.serverId))
      .map((server) => ({ serverId: server.serverId, endpoint: server.endpoint })),
  }
}

const toggle = (ids: readonly string[], id: string, checked: boolean) =>
  checked ? [...ids, id] : ids.filter((item) => item !== id)
function InvitePermissions({
  servers,
  role,
  pending,
  selectedServers,
  selectedSkills,
  onServers,
  onSkills,
}: {
  readonly servers: readonly ServerView[]
  readonly role: 'member' | 'viewer'
  readonly pending: boolean
  readonly selectedServers: readonly string[]
  readonly selectedSkills: readonly string[]
  readonly onServers: (ids: readonly string[]) => void
  readonly onSkills: (ids: readonly string[]) => void
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-sm font-medium">Servers and skills</legend>
      <p className="text-sm text-muted-foreground">
        Choose each permission. New owner grants do not widen this invitation. Viewers cannot run tools.
      </p>
      {servers.map((server) => (
        <div className="flex flex-wrap gap-4" key={server.serverId}>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={selectedServers.includes(server.serverId)}
              disabled={role === 'viewer' || pending}
              onChange={(event) => {
                onServers(toggle(selectedServers, server.serverId, event.target.checked))
              }}
            />
            {server.title ?? server.serverName ?? server.serverId} tools
          </label>
          {server.skillsEnabled && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={selectedSkills.includes(server.serverId)}
                disabled={role === 'viewer' || pending}
                onChange={(event) => {
                  onSkills(toggle(selectedSkills, server.serverId, event.target.checked))
                }}
              />
              Skills library
            </label>
          )}
        </div>
      ))}
      {servers.length === 0 && <p className="text-sm text-muted-foreground">No connected permissions to share.</p>}
    </fieldset>
  )
}

function OwnerRoster({
  state,
  pending,
  mutate,
}: {
  readonly state: MembersState | undefined
  readonly pending: boolean
  readonly mutate: (path: string, version: number, method?: 'POST' | 'DELETE') => Promise<void>
}) {
  return (
    <>
      {state?.members.map((member) => (
        <div className="flex items-center justify-between gap-3" key={member.id}>
          <p>
            {member.name} · {member.email} <Badge variant="secondary">{member.role}</Badge>
          </p>
          {member.role !== 'owner' && (
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => void mutate(`/api/members/${member.id}`, member.version, 'DELETE')}
            >
              Remove
            </Button>
          )}
        </div>
      ))}
      {state?.invitations
        .filter((invitation) => invitation.state === 'pending')
        .map((invitation) => (
          <div className="flex flex-wrap items-center gap-3" key={invitation.id}>
            <p className="mr-auto">
              {invitation.email} · {invitation.role} ·{' '}
              {invitation.sendState === 'failed' ? 'Email failed — resend' : 'Invited'}
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => void mutate(`/api/invitations/${invitation.id}/resend`, invitation.version)}
            >
              Resend
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => void mutate(`/api/invitations/${invitation.id}/revoke`, invitation.version)}
            >
              Revoke
            </Button>
          </div>
        ))}
    </>
  )
}

function InviteRole({
  role,
  onChange,
}: {
  readonly role: 'member' | 'viewer'
  readonly onChange: (role: 'member' | 'viewer') => void
}) {
  return (
    <Field>
      <FieldLabel htmlFor="member-role">Role</FieldLabel>
      <select
        id="member-role"
        className="h-9 rounded-md border bg-background px-3"
        value={role}
        onChange={(event) => {
          onChange(event.target.value === 'viewer' ? 'viewer' : 'member')
        }}
      >
        <option value="member">Member</option>
        <option value="viewer">Viewer</option>
      </select>
    </Field>
  )
}
