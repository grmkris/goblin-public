import { Type } from '@earendil-works/pi-ai'
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable'
import type { AgentApps } from '../agent-apps/engine.ts'
import { problemText } from '../agent-apps/queue.ts'
import { runScript } from '../agent-apps/script.ts'

const GUIDE = [
  'You can build apps for the owner: small programs with durable state on the server, whose actions and views become',
  'your tools (`app_<name>__<action>`). Use one when the owner wants something kept and worked on over time (a list,',
  'a tracker, a log, a calculation over their data). Read `app_docs` (topic `core`) before your first build. Build or',
  'change one with `app_build`; for small fixes send `edits`. If a build fails, read its problems and fix them. An',
  'app with a `view.tsx` (topic `ui`) shows the owner a live UI, under your build in the chat and as a page. An app',
  "reaches the internet, the owner's MCP tools, a model, Telegram or other apps only with powers the owner approves",
  '(topic `powers`), and runs an action on its own with `schedules` (topic `schedules`). When a task needs a service',
  'the owner has not connected, look with `mcp_suggest` and ask them with `mcp_request_server`.',
  "`code_run` runs a one-off JavaScript snippet over the owner's files for calculations; it keeps nothing.",
].join(' ')

const text = (value: unknown) => ({
  content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }],
})
const failure = (cause: unknown) => ({ content: [{ type: 'text' as const, text: problemText(cause) }], isError: true })

/** The section listing the apps, under the guide. */
function appsSection(apps: AgentApps): string {
  const list = apps.summary()
  return `${GUIDE}\n\nYour apps:\n${list === '' ? '(none yet)' : list}`
}

/** `app_docs`: the SDK reference, by topic. */
const docsTool = (apps: AgentApps) =>
  defineTool({
    name: 'app_docs',
    description:
      'Read how to write an app: topic "core" (start here), "ui" (its view), "powers" (fetch, tools, model, Telegram, other apps), "schedules", "files" or "examples".',
    parameters: Type.Object({ topic: Type.Optional(Type.String({ maxLength: 40 })) }),
    replay: 'safe',
    execute: async ({ topic }) => text(await apps.docs(topic ?? 'core')),
  })

/** `app_build`: create or change an app. */
const buildTool = (apps: AgentApps) =>
  defineTool({
    name: 'app_build',
    description:
      'Create an app, or change one by name. A new app sends `files` ({"app.ts": "...", "view.tsx": "..."} — the view is optional); a change sends the files it replaces or `edits` (find must occur exactly once). Returns the new version and its tools, or the problems to fix.',
    parameters: Type.Object({
      name: Type.String({ maxLength: 24, description: 'kebab-case, like reading-list' }),
      files: Type.Optional(Type.Record(Type.String({ maxLength: 40 }), Type.String({ maxLength: 131_072 }))),
      edits: Type.Optional(
        Type.Array(
          Type.Object({
            file: Type.String({ maxLength: 40 }),
            find: Type.String({ maxLength: 20_000 }),
            replace: Type.String({ maxLength: 20_000 }),
          }),
          { maxItems: 20 },
        ),
      ),
      note: Type.Optional(Type.String({ maxLength: 300, description: 'what this version changes' })),
    }),
    replay: 'safe',
    execute: async ({ name, files, edits, note }, api) => {
      try {
        return text(
          await apps.build({ name, files, edits, note }, { session: String(api.conversationId), callId: api.callId }),
        )
      } catch (cause) {
        return failure(cause)
      }
    },
  })

/** `app_inspect`: an app's version, members and, on request, its source, state, events and releases. */
const inspectTool = (apps: AgentApps) =>
  defineTool({
    name: 'app_inspect',
    description:
      'Look at an app: its version and members, and optionally its source, state, recent events and releases.',
    parameters: Type.Object({
      app: Type.String({ maxLength: 24 }),
      include: Type.Optional(
        Type.Array(
          Type.Union([Type.Literal('source'), Type.Literal('state'), Type.Literal('events'), Type.Literal('releases')]),
        ),
      ),
    }),
    replay: 'safe',
    execute: async ({ app, include }) => {
      try {
        return text(apps.inspect(app, include ?? []))
      } catch (cause) {
        return failure(cause)
      }
    },
  })

/** `app_rollback`: an earlier release active again. */
const rollbackTool = (apps: AgentApps) =>
  defineTool({
    name: 'app_rollback',
    description: 'Make an earlier release of an app active again (app_inspect with "releases" lists them).',
    parameters: Type.Object({ app: Type.String({ maxLength: 24 }), release: Type.String({ maxLength: 40 }) }),
    replay: 'safe',
    execute: async ({ app, release }) => {
      try {
        return text(await apps.rollback(app, release))
      } catch (cause) {
        return failure(cause)
      }
    },
  })

/** `code_run`: one-off JavaScript over the owner's files. */
const codeTool = (apps: AgentApps) =>
  defineTool({
    name: 'code_run',
    description:
      "Run JavaScript once (the body of an async function; `return` a JSON value). `files.read(path)`, `files.list(dir)` and `files.write(path, text)` (under /agent) reach the owner's files; `log(...)` notes. No network; 30 s.",
    parameters: Type.Object({ code: Type.String({ maxLength: 100_000 }) }),
    replay: 'safe',
    execute: async ({ code }) => text(await runScript(apps.isolates, apps.ownerFiles, code)),
  })

/** `app_docs`, `app_build`, `app_inspect`, `app_rollback` and `code_run`, on main and threads (ADR 0021). */
export function appsExtension(apps: AgentApps) {
  return defineExtension({
    name: 'goblin.apps',
    sections: [section('apps', () => appsSection(apps))],
    tools: [docsTool(apps), buildTool(apps), inspectTool(apps), rollbackTool(apps), codeTool(apps)],
  })
}
