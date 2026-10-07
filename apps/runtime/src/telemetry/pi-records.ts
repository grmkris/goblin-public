import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

/** The bounded scalar fields the recorder reads from Pi publications; message content never leaves this seam. */
const Id = Schema.Union([Schema.Number, Schema.String])
const Usage = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
  reasoning: Schema.optional(Schema.Number),
})
const Block = Schema.Struct({
  type: Schema.String,
  text: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  arguments: Schema.optional(Schema.Unknown),
})
const Assistant = Schema.Struct({
  role: Schema.Literal('assistant'),
  provider: Schema.String,
  model: Schema.String,
  responseModel: Schema.optional(Schema.String),
  responseId: Schema.optional(Schema.String),
  usage: Usage,
  stopReason: Schema.String,
  errorMessage: Schema.optional(Schema.String),
  timestamp: Schema.Number,
  content: Schema.Array(Block),
})
const ToolResult = Schema.Struct({
  role: Schema.Literal('toolResult'),
  toolCallId: Schema.String,
  toolName: Schema.String,
  isError: Schema.optional(Schema.Boolean),
  content: Schema.Unknown,
  timestamp: Schema.optional(Schema.Number),
})
const Diagnostics = Schema.Struct({
  diagnostics: Schema.optional(
    Schema.Array(Schema.Struct({ code: Schema.String, message: Schema.optional(Schema.String) })),
  ),
})
const Entry = Schema.Struct({
  id: Id,
  conversationId: Id,
  kind: Schema.String,
  model: Schema.optional(Schema.Array(Schema.Unknown)),
  data: Schema.optional(Schema.Unknown),
  byTaskId: Schema.optional(Id),
})
const Outcome = Schema.Struct({
  status: Schema.String,
  error: Schema.optional(Schema.Struct({ message: Schema.String })),
  reason: Schema.optional(Schema.String),
})
const Task = Schema.Struct({
  id: Id,
  conversationId: Id,
  kind: Schema.String,
  input: Schema.optional(Schema.Unknown),
  state: Schema.Struct({
    status: Schema.String,
    checkpoint: Schema.optional(
      Schema.Struct({
        phase: Schema.optional(Schema.String),
        attempt: Schema.optional(Schema.Number),
        model: Schema.optional(Schema.Struct({ provider: Schema.String, modelId: Schema.String })),
      }),
    ),
    outcome: Schema.optional(Outcome),
  }),
})
const ToolInput = Schema.Struct({ assistant: Id, callId: Schema.String })
const CompactionInput = Schema.Struct({ reason: Schema.String })
const Submission = Schema.Struct({
  id: Id,
  conversationId: Id,
  type: Schema.String,
  status: Schema.String,
  requestId: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.Unknown),
  answer: Schema.optional(Id),
})
const Live = Schema.Struct({
  run: Schema.optional(Schema.Struct({ taskId: Id, inputs: Schema.Array(Id) })),
  generation: Schema.optional(Schema.Struct({ attempt: Schema.Number, message: Schema.optional(Schema.Unknown) })),
})
const McpCall = Schema.Struct({ serverId: Schema.String, name: Schema.String })

const decode =
  <S extends Schema.Top & Schema.ConstraintDecoder<unknown>>(schema: S) =>
  (value: unknown): S['Type'] | undefined =>
    Option.getOrUndefined(Schema.decodeUnknownOption(schema)(value))
export const decodeEntry = decode(Entry)
export const decodeAssistant = decode(Assistant)
export const decodeToolResult = decode(ToolResult)
export const decodeDiagnostics = decode(Diagnostics)
export const decodeTask = decode(Task)
export const decodeToolInput = decode(ToolInput)
export const decodeCompactionInput = decode(CompactionInput)
export const decodeSubmission = decode(Submission)
export const decodeLive = decode(Live)
export const decodeMcpCall = decode(McpCall)
