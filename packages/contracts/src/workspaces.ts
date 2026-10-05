import * as Schema from 'effect/Schema'

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))
export const WorkspaceRole = Schema.Literals(['owner', 'member', 'viewer'])
export type WorkspaceRole = typeof WorkspaceRole.Type
/** Frozen endpoint-bound ceilings; a later owner grant never widens the invited member. */
export const MemberPolicy = Schema.Struct({
  servers: Schema.Array(
    Schema.Struct({
      serverId: Id,
      endpoint: Schema.String,
      tools: Schema.Array(Schema.String.check(Schema.isMaxLength(256))).check(Schema.isMaxLength(256)),
    }),
  ).check(Schema.isMaxLength(32)),
  skills: Schema.Array(Schema.Struct({ serverId: Id, endpoint: Schema.String })).check(Schema.isMaxLength(32)),
  mainHistory: Schema.Literals(['own', 'all']),
})
export type MemberPolicy = typeof MemberPolicy.Type
export const WorkspaceView = Schema.Struct({
  id: Id,
  name: Schema.String,
  ownerName: Schema.String,
  role: WorkspaceRole,
  memberId: Id,
  memberVersion: Schema.Int,
  accessVersion: Schema.Int,
  agentReady: Schema.Boolean,
})
export type WorkspaceView = typeof WorkspaceView.Type
export const WorkspaceState = Schema.Struct({
  active: Schema.NullOr(WorkspaceView),
  context: Schema.NullOr(Schema.String),
  workspaces: Schema.Array(WorkspaceView),
})
export type WorkspaceState = typeof WorkspaceState.Type
export const MemberView = Schema.Struct({
  id: Id,
  userId: Id,
  name: Schema.String,
  email: Schema.String,
  role: WorkspaceRole,
  version: Schema.Int,
  policy: MemberPolicy,
})
export type MemberView = typeof MemberView.Type
export const InvitationView = Schema.Struct({
  id: Id,
  email: Schema.String,
  role: Schema.Literals(['member', 'viewer']),
  version: Schema.Int,
  expiresAt: Schema.Number,
  state: Schema.Literals(['pending', 'accepted', 'revoked', 'expired']),
  sendState: Schema.Literals(['pending', 'sent', 'failed']),
  policy: MemberPolicy,
})
export type InvitationView = typeof InvitationView.Type
export const MembersState = Schema.Struct({
  workspace: WorkspaceView,
  members: Schema.Array(MemberView),
  invitations: Schema.Array(InvitationView),
})
export type MembersState = typeof MembersState.Type
export const InvitationPreview = Schema.Struct({
  id: Id,
  workspaceName: Schema.String,
  ownerName: Schema.String,
  role: Schema.Literals(['member', 'viewer']),
  email: Schema.String,
  expiresAt: Schema.Number,
})
export type InvitationPreview = typeof InvitationPreview.Type
