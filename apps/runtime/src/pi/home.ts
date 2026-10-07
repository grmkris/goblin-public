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

const OWNER_QUESTION = 'May I change these owner-placed Home tiles? Use the Home approval card or Edit Home.'

/** Main and ordinary threads can arrange Main's Home. Subagents and routine runs select their own extensions. */
export function homeExtension(run: RunProgram) {
  return defineExtension({
    name: 'goblin.home',
    sections: [
      section(
        'home',
        () =>
          'Main has a Home grid below the newest exchange. Read home_read for its revision and the App ids you can place. home_edit applies ordered add/move/resize/update/remove operations atomically. You may manage tiles you placed; changing owner tiles asks them instead. Placement grants no powers. For “build a reading list and put it on Home”, build an app with a view, then home_read and add its App id as a medium or large tile. A view should use useHost().surface and tileSize for a glance variant. Tile kinds are note, conversations and app. Notes use ordinary Markdown and the same chart, map and Mermaid fences as chat. A note is a snapshot: say when its figures were true. Live data belongs in an agent app with a refresh schedule and freshness/error states. MCP Apps are pinned by the owner. After building an app with a view in Main, offer to put it on Home. Use a fresh operationId for a new edit; retry a stale layout with its new revision and a new operationId.',
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
