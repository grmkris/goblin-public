import { type Args, UsageError, flagText, windowOf } from './args.ts'

/** What `tools/list` says about a tool: its name, description and JSON Schema input. */
export type ToolInfo = {
  readonly name: string
  readonly description?: string | undefined
  readonly inputSchema: {
    readonly properties?: Readonly<Record<string, unknown>> | undefined
    readonly required?: readonly string[] | undefined
  }
}

type Property = { readonly type?: unknown; readonly description?: unknown }

const propertyOf = (value: unknown): Property => (typeof value === 'object' && value !== null ? value : {})
/** `operationId` as a flag: `operation-id`. */
const flagOf = (property: string) => property.replaceAll(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)
/** Flags the CLI itself reads; never a tool's argument. */
const GLOBAL = new Set(['origin', 'json', 'help', 'port', 'open'])

/** A tool's command: `inspect_turn` is `goblin turn`; other tools keep their names. */
export const commandOf = (tool: string): string => tool.replace(/^inspect_/u, '')

function coerce(text: string, property: Property, name: string, now: number): unknown {
  // A time is given the way people say it: `--since 6h` is six hours ago.
  if (name === 'since' && /^\d+[mhd]$/u.test(text)) return now - windowOf(text)
  if (property.type === 'integer' || property.type === 'number') {
    const number = Number(text)
    if (text.trim() === '' || !Number.isFinite(number)) throw new UsageError(`--${flagOf(name)} takes a number`)
    return number
  }
  if (property.type === 'boolean') {
    if (text !== 'true' && text !== 'false') throw new UsageError(`--${flagOf(name)} takes true or false`)
    return text === 'true'
  }
  return text
}

const valueForFlag = (args: Args, name: string, schema: unknown, now: number): unknown => {
  const property = propertyOf(schema)
  if (property.type === 'boolean' && args.flags.get(flagOf(name)) === true) return true
  const text = flagText(args, flagOf(name))
  return text === undefined ? undefined : coerce(text, property, name, now)
}

/**
 * The tool's arguments from the command line, read against its own input schema: required properties in order take
 * the positional words (`goblin turn telegram-12`) and every property takes its flag (`--operation-id`, `--since 6h`).
 * Unknown flags and missing required values are usage errors.
 */
export function argumentsFor(tool: ToolInfo, args: Args, now: number): Record<string, unknown> {
  const properties = tool.inputSchema.properties ?? {}
  const required = tool.inputSchema.required ?? []
  const known = new Set(Object.keys(properties).map(flagOf))
  for (const flag of args.flags.keys())
    if (!GLOBAL.has(flag) && !known.has(flag)) throw new UsageError(`${commandOf(tool.name)} has no --${flag}`)
  const result: Record<string, unknown> = {}
  const positionals = [...args.positionals]
  for (const name of required) {
    const word = positionals.shift()
    if (word !== undefined) result[name] = coerce(word, propertyOf(properties[name]), name, now)
  }
  if (positionals.length > 0) throw new UsageError(`unexpected ${positionals.join(' ')}`)
  for (const [name, schema] of Object.entries(properties)) {
    const value = valueForFlag(args, name, schema, now)
    if (value !== undefined) result[name] = value
  }
  for (const name of required)
    if (!(name in result)) throw new UsageError(`${commandOf(tool.name)} needs --${flagOf(name)}`)
  return result
}

/** A tool's help: its command, arguments with their descriptions, and what it does. */
export function usage(tool: ToolInfo): string {
  const properties = tool.inputSchema.properties ?? {}
  const required = new Set(tool.inputSchema.required ?? [])
  const lines = Object.entries(properties).map(([name, schema]) => {
    const description = propertyOf(schema).description
    const note = typeof description === 'string' ? `  ${description}` : ''
    return `  --${flagOf(name)}${required.has(name) ? ' (required)' : ''}${note}`
  })
  return [`goblin ${commandOf(tool.name)}`, '', tool.description ?? '', '', ...lines].join('\n')
}
