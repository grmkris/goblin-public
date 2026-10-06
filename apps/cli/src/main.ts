#!/usr/bin/env bun
import type { Client } from '@modelcontextprotocol/client'
import { type Args, UsageError, parseArgs } from './args.ts'
import { type ToolInfo, argumentsFor, commandOf, usage } from './commands.ts'
import { type Settings, settingsOf } from './config.ts'
import { connect, logout } from './connect.ts'
import { logs } from './logs.ts'
import { failureText, render } from './render.ts'

const HELP = `goblin: your goblin agent from the terminal, as an MCP client of /mcp (ADR 0024)

  goblin login                 sign in and approve (once per machine and origin)
  goblin tools                 the commands this server offers
  goblin problems [--since …]  what failed, was blocked or cut short
  goblin turns                 recent turns, one line each
  goblin turn <operation id>   one turn end to end
  goblin conversation <id>     a conversation's entries, in full
  goblin logs <id> [--since 6h]  Workers Logs lines that mention an id
  goblin ask_agent <message>   ask your agent in its main conversation (needs a plan)
  goblin logout

  --origin URL   default https://dev.goblin.surf (or GOBLIN_ORIGIN)
  --json         print the tool's structured result
  --open         open the sign-in page in a browser
  --port N       the sign-in callback's loopback port (default 18979)`

type CallResult = { readonly isError?: unknown; readonly structuredContent?: unknown; readonly content?: unknown }

const errorText = (result: CallResult): string =>
  Array.isArray(result.content)
    ? result.content
        .map((block: unknown) =>
          typeof block === 'object' && block !== null && 'text' in block ? String(block.text) : '',
        )
        .join('\n')
    : 'the tool failed'

async function listTools(client: Client): Promise<readonly ToolInfo[]> {
  return (await client.listTools()).tools
}

/** One tool, as its command: arguments from its own schema, a rendered result, exit 1 on a tool error. */
async function runTool(client: Client, args: Args, settings: Settings): Promise<number> {
  const tools = await listTools(client)
  const tool = tools.find((candidate) => commandOf(candidate.name) === args.command)
  if (tool === undefined)
    throw new UsageError(
      `No command ${args.command}. Commands: ${tools.map((each) => commandOf(each.name)).join(', ')}`,
    )
  if (args.flags.get('help') === true) {
    console.log(usage(tool))
    return 0
  }
  const result: CallResult = await client.callTool({ name: tool.name, arguments: argumentsFor(tool, args, Date.now()) })
  if (result.isError === true) {
    console.error(failureText(errorText(result)))
    return 1
  }
  console.log(
    settings.json
      ? JSON.stringify(result.structuredContent ?? null, null, 2)
      : render(args.command ?? '', result.structuredContent),
  )
  return 0
}

async function withClient(settings: Settings, args: Args, work: (client: Client) => Promise<number>): Promise<number> {
  const client = await connect(settings, args.flags.get('open') === true)
  try {
    return await work(client)
  } finally {
    await client.close()
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv)
  if (args.command === undefined || args.command === 'help') {
    console.log(HELP)
    return 0
  }
  const settings = await settingsOf(args)
  switch (args.command) {
    case 'login':
      return withClient(settings, args, async () => {
        console.error(`Signed in to ${settings.endpoint.href}.`)
        return 0
      })
    case 'logout':
      await logout(settings)
      console.error(`Signed out of ${settings.endpoint.href} on this machine. Revoke the client in Settings to end it.`)
      return 0
    case 'tools':
      return withClient(settings, args, async (client) => {
        for (const tool of await listTools(client))
          console.log(`${commandOf(tool.name).padEnd(14)} ${tool.description ?? ''}`)
        return 0
      })
    case 'logs':
      console.log(await logs(args, settings.origin, Date.now()))
      return 0
    default:
      return withClient(settings, args, (client) => runTool(client, args, settings))
  }
}

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = error instanceof UsageError ? 2 : 1
}
