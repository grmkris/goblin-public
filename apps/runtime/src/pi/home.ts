import { defineExtension, section } from '@earendil-works/pi-durable'
import { HomeEdit, HomeEditResult, HomeRead } from '@goblin/contracts'
import * as Schema from 'effect/Schema'
import { readHomeLayout, editHomeLayout } from '../home/program.ts'
import { problemText } from '../agent-apps/queue.ts'
import type { RunProgram } from './resident-mcp.ts'
import { typedTool } from './typed-tool.ts'

/** An edit the agent may make: the owner's Undo (`undoOf`) is not one. */
const AgentEdit = Schema.Struct({
  operationId: HomeEdit.fields.operationId,
  expectedRevision: HomeEdit.fields.expectedRevision,
  ops: HomeEdit.fields.ops,
})

const OWNER_QUESTION =
  'May I change these owner-placed Home tiles? The dashboard UI is deferred; this edit requires the owner Home API.'

/** Main and ordinary threads can arrange Main's Home. Subagents and routine runs select their own extensions. */
export function homeExtension(run: RunProgram) {
  return defineExtension({
    name: 'goblin.home',
    sections: [
      section(
        'home',
        () =>
          'The Home dashboard UI is deferred. Saved layouts remain available through home_read and home_edit, but edits have no visible browser surface. Do not offer Home tiles or claim they appear in Main. Use these tools only when the owner explicitly asks to inspect or change the saved layout. Supply a fresh operationId and the current revision. You may manage agent-placed tiles; owner tiles require an owner API edit. Placement grants no powers.',
      ),
    ],
    tools: [
      typedTool({
        name: 'home_read',
        description:
          'Read Main’s Home layout (note, conversations and app tiles), revision, and agent Apps available to place (id, name, hasView). Notes are snapshots; scheduled agent apps hold live data. The owner pins MCP Apps.',
        input: Schema.Struct({}),
        output: HomeRead,
        replay: 'safe',
        execute: async () => run(readHomeLayout),
      }),
      typedTool({
        name: 'home_edit',
        description:
          'Arrange Main’s Home with one atomic ordered edit. Supply the revision from home_read and a stable operationId. Add note snapshots (Markdown and figure fences), recent conversations or agent apps with views. You can change your own tiles; owner tiles require their approval. Only the owner pins MCP Apps. Placement grants nothing.',
        input: AgentEdit,
        output: HomeEditResult,
        replay: 'safe',
        execute: async (edit) => run(editHomeLayout(edit, 'agent')),
        text: (result) =>
          JSON.stringify(result.kind === 'owner-required' ? { ...result, question: OWNER_QUESTION } : result),
        details: (result, edit) => {
          if (result.kind === 'owner-required')
            return { kind: 'home-owner-required', edit: JSON.parse(JSON.stringify(edit)) }
          if (result.kind === 'applied')
            return {
              kind: 'home-receipt',
              operationId: result.operationId,
              tileIds: [...result.tileIds],
              message: result.message,
            }
          return {}
        },
        terminate: (result) => result.kind === 'owner-required',
        failure: problemText,
      }),
    ],
  })
}
