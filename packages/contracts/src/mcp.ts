import * as Schema from 'effect/Schema'

/** A bounded, non-empty string. */
const Bounded = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max))
/** A server id as the owner's requests name it: configured ids and the ones added servers get. */
const ServerIdField = Bounded(64)

/** What a grant covers on a server: a tool, a resource (an App's `ui://` bundle) or a prompt. */
export const GrantCapability = Schema.Literals(['tool', 'resource', 'prompt'])
export type GrantCapability = typeof GrantCapability.Type

/**
 * One exact grant the owner gave: a tool, resource or prompt on one server, by name. Absence is denial; there are no
 * wildcards. `askFirst`: each call of the tool waits for the owner's decision (ADR 0028).
 */
export const Grant = Schema.Struct({
  serverId: Schema.String,
  capability: GrantCapability,
  name: Schema.String,
  askFirst: Schema.optionalKey(Schema.Boolean),
})
export type Grant = typeof Grant.Type

/** Where an added server was found: a registry entry (name and version), or nothing for a pasted URL. */
export const ServerSource = Schema.Struct({
  registry: Bounded(2048),
  name: Bounded(256),
  version: Schema.optional(Bounded(64)),
})
export type ServerSource = typeof ServerSource.Type

/** `POST /api/mcp/servers`: add a server by its https endpoint, from a registry entry or pasted. */
export const AddServer = Schema.Struct({ endpoint: Bounded(2048), source: Schema.optional(ServerSource) })
export type AddServer = typeof AddServer.Type

/** `POST /api/mcp/registries` and `…/registries/remove`: a registry by its URL. */
export const RegistryChange = Schema.Struct({ url: Bounded(2048) })
export type RegistryChange = typeof RegistryChange.Type

/** `PUT /api/mcp/grants`: grant or revoke one discovered tool. */
export const GrantChange = Schema.Struct({ serverId: ServerIdField, name: Bounded(256), allowed: Schema.Boolean })
export type GrantChange = typeof GrantChange.Type

/** `PUT /api/mcp/ask-first`: a granted tool's calls wait for the owner's decision, or no longer do. */
export const AskFirstChange = Schema.Struct({ serverId: ServerIdField, name: Bounded(256), enabled: Schema.Boolean })
export type AskFirstChange = typeof AskFirstChange.Type

/** `PUT /api/mcp/skills`: the agent uses a server's skills, or stops. */
export const SkillsChange = Schema.Struct({ serverId: ServerIdField, enabled: Schema.Boolean })
export type SkillsChange = typeof SkillsChange.Type

/** What `PUT /api/mcp/skills` answers: the server and its switch as it is now. */
export const SkillsSetting = Schema.Struct({ serverId: Schema.String, enabled: Schema.Boolean })
export type SkillsSetting = typeof SkillsSetting.Type

/** `PUT /api/mcp/app-grants`: grant or revoke an MCP App as a whole, by its `ui://` resource. */
export const AppGrantChange = Schema.Struct({
  serverId: ServerIdField,
  uri: Bounded(2048).check(Schema.isPattern(/^ui:\/\//u)),
  allowed: Schema.Boolean,
})
export type AppGrantChange = typeof AppGrantChange.Type

/** `POST /api/mcp/approvals/:id`: the owner's decision on a held call. */
export const ApprovalDecision = Schema.Struct({ allowed: Schema.Boolean })
export type ApprovalDecision = typeof ApprovalDecision.Type

/** What `POST /api/mcp/:id/connect` answers: where to send the owner's browser, when sign-in is needed. */
export const ConnectStart = Schema.Struct({ authorizationUrl: Schema.optional(Schema.String) })
export type ConnectStart = typeof ConnectStart.Type

/** `POST /api/mcp/:id/tools/call`: the owner (or an App they opened) calls one granted tool. */
export const ToolCall = Schema.Struct({
  name: Bounded(256),
  arguments: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})
export type ToolCall = typeof ToolCall.Type

/** `POST /api/mcp/:id/resources/read`: one granted resource by its URI. */
export const ResourceRead = Schema.Struct({ uri: Bounded(2048) })
export type ResourceRead = typeof ResourceRead.Type

/** `POST /api/mcp/:id/prompts/get`: one granted prompt with its arguments. */
export const PromptGet = Schema.Struct({
  name: Bounded(256),
  arguments: Schema.optional(Schema.Record(Schema.String, Schema.String.check(Schema.isMaxLength(16_384)))),
})
export type PromptGet = typeof PromptGet.Type

/** `POST /api/agent/resident`: revoke resident authority, or enable it again. */
export const ResidentChange = Schema.Struct({ enabled: Schema.Boolean })
export type ResidentChange = typeof ResidentChange.Type

/**
 * Remote data inside an MCP result: the server's own, untrusted. Only its shape as a JSON object is checked here; the
 * official SDK validated the result when it arrived.
 */
const RemoteObject = Schema.Record(Schema.String, Schema.Unknown)

/**
 * A remote MCP result is answered whole, as the SDK validated it, so the schemas below are typed passthroughs: they
 * name the fields owners and Apps read and keep every other field the server sent (`StructWithRest`). Stricter schemas
 * would drop or refuse the fields of MCP revisions this contract does not know yet.
 */
const passthrough = <Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.StructWithRest(Schema.Struct(fields), [RemoteObject])

/** A `tools/call` result: content blocks, structured content and whether the tool reports an error. */
export const McpToolResult = passthrough({
  content: Schema.optional(Schema.Array(RemoteObject)),
  structuredContent: Schema.optional(RemoteObject),
  isError: Schema.optional(Schema.Boolean),
})
export type McpToolResult = typeof McpToolResult.Type

/** A `resources/read` result: the resource's contents (an App's HTML bundle among them). */
export const McpResourceResult = passthrough({ contents: Schema.Array(RemoteObject) })
export type McpResourceResult = typeof McpResourceResult.Type

/** A `prompts/get` result: its messages and description. */
export const McpPromptResult = passthrough({
  description: Schema.optional(Schema.String),
  messages: Schema.Array(RemoteObject),
})
export type McpPromptResult = typeof McpPromptResult.Type
