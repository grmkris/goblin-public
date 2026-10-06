import { defineExtension, defineTool, section } from '@earendil-works/pi-durable'
import { Type } from '@earendil-works/pi-ai'
import * as Schema from 'effect/Schema'
import { RoutineDefinition } from '@goblin/contracts'
import { changeRoutine, proposeRoutine, routinesList } from '../routines/program.ts'
import type { RunProgram } from './resident-mcp.ts'

/** The model proposes a draft; only the authenticated owner's review may confirm it. */
export function routinesExtension(run: RunProgram) {
  return defineExtension({
    name: 'goblin.routines',
    sections: [
      section(
        'routines',
        () =>
          'Use routine to propose a scheduled reminder or event-driven task. The owner reviews and confirms the exact definition in Settings → Routines before it can run. You may list or pause routines; you cannot activate them.',
      ),
    ],
    tools: [
      defineTool({
        name: 'routine',
        description:
          'Propose a routine definition as JSON, list routines, or pause one by id and revision. Proposal does not activate it. Only the owner confirms it in Settings.',
        parameters: Type.Object({
          action: Type.Union([Type.Literal('propose'), Type.Literal('list'), Type.Literal('pause')]),
          definition: Type.Optional(Type.String({ maxLength: 24_000 })),
          id: Type.Optional(Type.String({ maxLength: 100 })),
          revision: Type.Optional(Type.Integer({ minimum: 1 })),
        }),
        replay: 'safe',
        execute: async ({ action, definition, id, revision }, api) => {
          const operationId = `routine:${api.conversationId}:${api.callId}`
          if (action === 'list') return { content: [{ type: 'text', text: JSON.stringify(await run(routinesList)) }] }
          if (action === 'pause' && id !== undefined && revision !== undefined) {
            const paused = await run(changeRoutine(id, { revision, operationId }, 'pause'))
            return { content: [{ type: 'text', text: JSON.stringify(paused) }] }
          }
          if (action !== 'propose' || definition === undefined)
            return {
              content: [{ type: 'text', text: 'propose needs a definition; pause needs id and revision.' }],
              isError: true,
            }
          const draft = await run(
            proposeRoutine(Schema.decodeUnknownSync(RoutineDefinition)(JSON.parse(definition)), operationId),
          )
          return {
            content: [
              {
                type: 'text',
                text: `Proposed routine "${draft.definition.title}", revision ${draft.revision}. The owner must review and confirm it in Settings → Routines.`,
              },
            ],
            details: { kind: 'routine-proposal', routineId: draft.id, revision: draft.revision },
            control: { terminate: true },
          }
        },
      }),
    ],
  })
}
