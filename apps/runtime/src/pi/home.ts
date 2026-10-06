import { Type } from '@earendil-works/pi-ai'
import { defineExtension, defineTool, section, type ToolExecutionResult } from '@earendil-works/pi-durable'
import { HomeEdit } from '@goblin/contracts'
import * as Schema from 'effect/Schema'
import { readHomeLayout, editHomeLayout } from '../home/program.ts'
import { problemText } from '../agent-apps/queue.ts'
import type { RunProgram } from './resident-mcp.ts'

const size = Type.Union([Type.Literal('small'), Type.Literal('medium'), Type.Literal('large'), Type.Literal('wide')])
const id = Type.String({ minLength: 1, maxLength: 100 })
const base = { id, size }
const note = { title: Type.String({ maxLength: 60 }), markdown: Type.String({ maxLength: 4096 }) }
const tile = Type.Union([
  Type.Object({ ...base, kind: Type.Literal('app'), appId: Type.String({ pattern: '^\\d{1,12}$' }) }),
  Type.Object({ ...base, kind: Type.Literal('conversations') }),
  Type.Object({ ...base, kind: Type.Literal('note'), ...note }),
])
const index = Type.Integer({ minimum: 0, maximum: 24 })
const parameters = Type.Object({
  operationId: Type.String({ minLength: 1, maxLength: 200 }),
  expectedRevision: Type.Integer({ minimum: 0 }),
  ops: Type.Array(
    Type.Union([
      Type.Object({ kind: Type.Literal('add'), tile, index: Type.Optional(index) }),
      Type.Object({ kind: Type.Literal('move'), id, index }),
      Type.Object({ kind: Type.Literal('resize'), id, size }),
      Type.Object({ kind: Type.Literal('update'), id, ...note }),
      Type.Object({ kind: Type.Literal('remove'), id }),
    ]),
    { minItems: 0, maxItems: 72 },
  ),
})
const text = (value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }]
/** Main and ordinary threads can arrange Main's Home. Subagents and routine runs select their own extensions. */
export function homeExtension(run: RunProgram) {
  return defineExtension({
    name: 'goblin.home',
    sections: [
      section(
        'home',
        () =>
          'Main has a Home grid below the newest exchange. Read home_read for its revision and the App ids you can place. home_edit applies ordered add/move/resize/update/remove operations atomically. You may manage tiles you placed; changing owner tiles asks them instead. Placement grants no powers. For “build a reading list and put it on Home”, build an app with a view, then home_read and add its App id as a medium or large tile. A view should use useHost().surface and tileSize for a glance variant. Notes and recent conversations need no app. Use a fresh operationId for a new edit; retry a stale layout with its new revision and a new operationId.',
      ),
    ],
    tools: [
      defineTool({
        name: 'home_read',
        description: 'Read Main’s Home layout, revision, and agent Apps available to place (id, name, hasView).',
        parameters: Type.Object({}),
        replay: 'safe',
        execute: async () => ({ content: text(await run(readHomeLayout)) }),
      }),
      defineTool({
        name: 'home_edit',
        description:
          'Arrange Main’s Home with one atomic ordered edit. Supply the revision from home_read and a stable operationId. You can change your own tiles; owner tiles require their approval.',
        parameters,
        replay: 'safe',
        execute: async (input): Promise<ToolExecutionResult> => {
          try {
            const edit = Schema.decodeUnknownSync(HomeEdit)(input)
            const result = await run(editHomeLayout(edit, 'agent'))
            if (result.kind === 'owner-required')
              return {
                content: text({
                  ...result,
                  question: 'May I change these owner-placed Home tiles? Use the Home approval card or Edit Home.',
                }),
                details: { kind: 'home-owner-required', edit: JSON.parse(JSON.stringify(edit)) },
                control: { terminate: true },
              }
            return {
              content: text(result),
              ...(result.kind === 'applied' && {
                details: {
                  kind: 'home-receipt',
                  operationId: result.operationId,
                  tileIds: [...result.tileIds],
                  message: result.message,
                },
              }),
            }
          } catch (cause) {
            return { content: [{ type: 'text', text: problemText(cause) }], isError: true }
          }
        },
      }),
    ],
  })
}
