import {
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
  defineTool,
} from '@earendil-works/pi-durable'
import type { JsonValue } from '@goblin/contracts'
import * as Schema from 'effect/Schema'
import { describeError } from '../telemetry/attributes.ts'

type Context = Parameters<ToolRegistration['execute']>[2]

/** A JSON Schema, as a model's tool parameters and a typed caller (codemode, `/mcp`) read it. */
export type JsonSchema = { readonly [key: string]: JsonValue }

/** `node` with every `#/$defs/<name>` reference replaced by its definition: providers differ on `$ref` in tools. */
function inline(node: JsonValue, definitions: Readonly<Record<string, JsonValue>>, depth = 0): JsonValue {
  if (depth > 32) return {}
  if (Array.isArray(node)) return node.map((item) => inline(item, definitions, depth + 1))
  if (typeof node !== 'object' || node === null) return node
  const ref = node.$ref
  if (typeof ref === 'string' && ref.startsWith('#/$defs/')) {
    const target = definitions[ref.slice('#/$defs/'.length)]
    return target === undefined ? {} : inline(target, definitions, depth + 1)
  }
  return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, inline(value, definitions, depth + 1)]))
}

/** An Effect schema as one self-contained JSON Schema (draft 2020-12, no `$ref`). */
export function jsonSchemaOf(schema: Schema.Top): JsonSchema {
  const document = Schema.toJsonSchemaDocument(schema)
  // SAFETY: a JSON Schema document is JSON throughout; Effect types its nodes structurally.
  const inlined = inline(document.schema as JsonValue, document.definitions as Readonly<Record<string, JsonValue>>)
  return typeof inlined === 'object' && inlined !== null && !Array.isArray(inlined) ? inlined : {}
}

/** A typed tool as the model and other callers see it: its name, what it does, and its input and output types. */
export type ToolSignature = {
  readonly name: string
  readonly description: string
  readonly inputSchema: JsonSchema
  readonly outputSchema: JsonSchema
}

/**
 * One tool with an Effect Schema for its input and its output (ADR 0027). The model is offered the input as a JSON
 * Schema; arguments are decoded by the schema before `execute` runs, and a value that fails is the model's error to
 * fix. The output is encoded as JSON and kept as `details.structuredContent`, beside the `details` fields the web reads
 * (`kind`), the way Pi's MCP tools carry `structuredContent`; the model reads `text`, the output's JSON by default. A
 * failure `execute` throws becomes an error result with its description.
 */
export type TypedTool<I, O> = {
  readonly name: string
  readonly description: string
  readonly input: Schema.Codec<I, unknown>
  readonly output: Schema.Codec<O, unknown>
  readonly replay: 'safe' | 'unsafe'
  readonly execute: (input: I, api: ToolExecutionApi, context: Context) => Promise<O | ReadyResult>
  /** What the model reads of the output (and the input it answers); its JSON by default. */
  readonly text?: (output: O, input: I) => string
  /** Fields beside `structuredContent` in the result's details (the ones the web reads), from the output and input. */
  readonly details?: (output: O, input: I) => Readonly<Record<string, JsonValue>>
  /** End the run once this result is recorded (a question to the owner, a proposal to review). */
  readonly terminate?: (output: O) => boolean
  /** The text of a failure; {@link describeError} by default. */
  readonly failure?: (cause: unknown) => string
}

/**
 * A result a typed tool returns as it is, in place of its output: a refusal the web trusts by its details
 * (`capability-off`), or content the output does not carry (an image's bytes, which `structuredContent` would store
 * twice). It has no `structuredContent`.
 */
export class ReadyResult {
  readonly result: ToolExecutionResult
  constructor(result: ToolExecutionResult) {
    this.result = result
  }
}

/** The signatures of the typed tools defined so far, by name: what `/mcp` and codemode will list. */
const signatures = new Map<string, ToolSignature>()

/** Every typed tool's signature, by name. */
export const toolSignatures = (): readonly ToolSignature[] => [...signatures.values()]

/**
 * A tool's parameters, which providers require to be an object: Effect writes an empty struct as "anything but null",
 * offered here as an object with no fields.
 */
function parametersOf(name: string, schema: JsonSchema): JsonSchema {
  if (schema.type === 'object') return schema
  if (JSON.stringify(schema) === '{"not":{"type":"null"}}') return { type: 'object', properties: {} }
  throw new Error(`${name}'s input must be a struct`)
}

const failed = (text: string): ToolExecutionResult => ({ content: [{ type: 'text', text }], isError: true })

export function typedTool<I, O>(tool: TypedTool<I, O>): ToolRegistration {
  const inputSchema = parametersOf(tool.name, jsonSchemaOf(tool.input))
  const outputSchema = jsonSchemaOf(tool.output)
  signatures.set(tool.name, { name: tool.name, description: tool.description, inputSchema, outputSchema })
  // The model is offered the input's JSON form (an optional field may be null), so arguments decode through it.
  const decode = Schema.decodeUnknownSync(Schema.toCodecJson(tool.input))
  const encode = Schema.encodeSync(Schema.toCodecJson(tool.output))
  return defineTool({
    name: tool.name,
    description: tool.description,
    // Pi compiles plain JSON Schema with TypeBox's `Compile`; this one is self-contained (no `$ref`).
    parameters: inputSchema,
    replay: tool.replay,
    execute: async (args, api, context) => {
      let input: I
      try {
        input = decode(args)
      } catch (cause) {
        return failed(`The arguments do not match ${tool.name}'s input: ${describeError(cause)}`)
      }
      let output: O | ReadyResult
      try {
        output = await tool.execute(input, api, context)
      } catch (cause) {
        return failed(tool.failure?.(cause) ?? describeError(cause))
      }
      if (output instanceof ReadyResult) return output.result
      // SAFETY: the JSON codec's encoded side is JSON.
      const structuredContent = encode(output) as JsonValue
      return {
        content: [{ type: 'text', text: tool.text?.(output, input) ?? JSON.stringify(structuredContent) }],
        details: { ...tool.details?.(output, input), structuredContent },
        ...(tool.terminate?.(output) === true ? { control: { terminate: true } } : {}),
      }
    },
  })
}
