import { GenerationTask, defineExtension, hook, section } from '@earendil-works/pi-durable'
import * as Schema from 'effect/Schema'
import { BuildResult } from '../agent-apps/build.ts'
import type { AgentApps } from '../agent-apps/engine.ts'
import { AppInspection, InspectPart } from '../agent-apps/inspect.ts'
import { RolledBack } from '../agent-apps/rollback.ts'
import { problemText } from '../agent-apps/queue.ts'
import { ScriptResult, runScript } from '../agent-apps/script.ts'
import { withContext } from './context-tail.ts'
import { homeExtension } from './home.ts'
import type { RunProgram } from '../runtime/bridge.ts'
import { reportAndRecover } from '../observability/report.ts'
import { Setups } from '../setup/service.ts'
import { newAppJoinsTopic } from '../topics/program.ts'
import { typedTool } from './typed-tool.ts'

const GUIDE = [
  'You can build apps for the owner: small programs with durable state on the server, whose actions and views you',
  'call with `app_call` (app, member, input). Use one when the owner wants something kept and worked on over time (a list,',
  'a tracker, a log, a calculation over their data). Read `app_docs` (topic `core`) before your first build. Build or',
  'change one with `app_build`; for small fixes send `edits`. If a build fails, read its problems and fix them. An',
  'app with a `view.tsx` (topic `ui`) shows the owner a live UI in chat and as a page. Before you write or change a',
  '`view.tsx`, read `app_docs` topic `ui` and follow its Design rules: give each section room. Use `useHost()`',
  'from `@goblin/app` for its surface and available room. The Home dashboard is deferred; do not offer tiles there. An app',
  "reaches the internet, the owner's MCP tools, a model, Telegram or other apps only with powers the owner approves",
  '(topic `powers`), and runs an action on its own with `schedules` (topic `schedules`). When a task needs a service',
  'the owner has not connected, look with `mcp_suggest` and ask them with `mcp_request_server`.',
  "`code_run` runs a one-off JavaScript snippet over the owner's files for calculations; it keeps nothing. The owner",
  'manages apps on the Apps page (allow powers, pause schedules, go back a version, delete); you cannot delete one.',
  'Your apps, their versions, members and last errors are listed under <apps> in the <goblin-context> block that ends',
  'each request.',
].join(' ')

/**
 * The apps this chat may call as they are now, for the trailing context block: they change with every build and the
 * Topic's setup (ADR 0040), the guide never does.
 */
const appsNow = (apps: AgentApps, run: RunProgram, session: string): Promise<string> =>
  run(Setups.use((setups) => setups.scope(session))).then(
    (scope) => apps.summary((name) => scope.app(name)) || '(none here)',
    // expected: the listing is optional context; run reported anything unexpected
    () => '(none here)',
  )

const AppName = Schema.String.check(Schema.isMaxLength(24))

/** `app_docs`: the SDK reference, by topic. */
const docsTool = (apps: AgentApps) =>
  typedTool({
    name: 'app_docs',
    description:
      'Read how to write an app: topic "core" (start here), "ui" (its view), "powers" (fetch, tools, model, Telegram, other apps), "schedules", "files" or "examples".',
    input: Schema.Struct({ topic: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(40))) }),
    output: Schema.Struct({ docs: Schema.String }),
    replay: 'safe',
    execute: async ({ topic }) => ({ docs: await apps.docs(topic ?? 'core') }),
    text: ({ docs }) => docs,
  })

/** `app_build`: create or change an app. */
const buildTool = (apps: AgentApps, run: RunProgram) =>
  typedTool({
    name: 'app_build',
    description:
      'Create an app, or change one by name. A new app sends `files` ({"app.ts": "...", "view.tsx": "..."} — the view is optional); a change sends the files it replaces or `edits` (find must occur exactly once). Returns the new version and its members (call them with app_call), or the problems to fix.',
    input: Schema.Struct({
      name: AppName.annotate({ description: 'kebab-case, like reading-list' }),
      // A plain key keeps the value type in the JSON Schema; the builder checks each file name.
      files: Schema.optionalKey(Schema.Record(Schema.String, Schema.String.check(Schema.isMaxLength(131_072)))),
      edits: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            file: Schema.String.check(Schema.isMaxLength(40)),
            find: Schema.String.check(Schema.isMaxLength(20_000)),
            replace: Schema.String.check(Schema.isMaxLength(20_000)),
          }),
        ).check(Schema.isMaxLength(20)),
      ),
      note: Schema.optionalKey(
        Schema.String.check(Schema.isMaxLength(300)).annotate({ description: 'what this version changes' }),
      ),
    }),
    output: BuildResult,
    replay: 'safe',
    execute: async (request, api) => {
      const session = String(api.conversationId)
      const built = await apps.build(request, { session, callId: api.callId })
      // A new app joins a Topic that lists its apps; failing that leaves the build as it is, and the owner can add it.
      if (built.status === 'active' && built.version === 1)
        await run(
          newAppJoinsTopic(session, built.app, `app:${session}:${api.callId}`).pipe(
            reportAndRecover('apps.join-topic', undefined),
          ),
        )
      return built
    },
    failure: problemText,
  })

/** `app_inspect`: an app's version, members and, on request, its source, state, events and releases. */
const inspectTool = (apps: AgentApps) =>
  typedTool({
    name: 'app_inspect',
    description:
      'Look at an app: its version and members, and optionally its source, state, recent events and releases.',
    input: Schema.Struct({ app: AppName, include: Schema.optionalKey(Schema.Array(InspectPart)) }),
    output: AppInspection,
    replay: 'safe',
    execute: async ({ app, include }) => apps.inspect(app, include ?? []),
    failure: problemText,
  })

/** `app_rollback`: an earlier release active again. */
const rollbackTool = (apps: AgentApps) =>
  typedTool({
    name: 'app_rollback',
    description: 'Make an earlier release of an app active again (app_inspect with "releases" lists them).',
    input: Schema.Struct({ app: AppName, release: Schema.String.check(Schema.isMaxLength(40)) }),
    output: RolledBack,
    replay: 'safe',
    execute: async ({ app, release }) => apps.rollback(app, release),
    failure: problemText,
  })

/** `code_run`: one-off JavaScript over the owner's files. */
const codeTool = (apps: AgentApps) =>
  typedTool({
    name: 'code_run',
    description:
      "Run JavaScript once (the body of an async function; `return` a JSON value). `files.read(path)`, `files.list(dir)` and `files.write(path, text)` (under /agent) reach the owner's files; `log(...)` notes. No network; 30 s.",
    input: Schema.Struct({ code: Schema.String.check(Schema.isMaxLength(100_000)) }),
    output: ScriptResult,
    // Scripts may write files before eviction interrupts the tool. Pi must surface that interruption,
    // rather than automatically executing the script and its writes again.
    replay: 'unsafe',
    execute: async ({ code }) => runScript(apps.isolates, apps.ownerFiles, code),
  })

/** Owner app and Home management, on main and threads (ADR 0021). */
export function appsExtension(apps: AgentApps, run: RunProgram) {
  const extension = defineExtension({
    name: 'goblin.apps',
    sections: [section('apps', () => GUIDE)],
    tools: [docsTool(apps), buildTool(apps, run), inspectTool(apps), rollbackTool(apps)],
  })
  return [extension, homeExtension(run)]
}

/** Execution shared with helpers, without app or Home management. */
export function appExecutionExtension(apps: AgentApps, run: RunProgram) {
  return defineExtension({
    name: 'goblin.app-execution',
    sections: [
      section(
        'code',
        () =>
          '`code_run` runs JavaScript over owner files. `app_call` executes approved app actions and views listed under <apps>; app powers still require owner approval.',
      ),
    ],
    tools: [codeTool(apps)],
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async ({ messages }, api) => ({
          messages: withContext(messages, 'apps', await appsNow(apps, run, String(api.conversationId))),
        }),
      }),
    ],
  })
}
