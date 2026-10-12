import { registerAppTool } from '@modelcontextprotocol/ext-apps/server'
import type { McpServer } from '@modelcontextprotocol/server'
import { TOOLS } from '@goblin/wallet/contract'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { failure } from '../../services/errors.ts'
import { Ledger } from '../../services/ledger.ts'
import { answer, refusal } from '../results.ts'
import { standard } from '../standard.ts'
import type { Toolbox } from '../toolbox.ts'

const Input = Schema.Struct({ state: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)) })
const decodeState = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))

/** Reads the app's saved view state, or replaces it when given one. It is a convenience of the view, never authority. */
const viewState = (next: Record<string, unknown> | undefined) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    if (next !== undefined) {
      const saved = yield* ledger.use((api) => api.putViewState(JSON.stringify(next)))
      if (!saved) return yield* failure('view_state_too_large', 'The view state is too large to keep.', 413)
    }
    const raw = yield* ledger.use((api) => api.viewState())
    return Option.getOrElse(decodeState(raw), (): Record<string, unknown> => ({}))
  })

export function registerViewState(server: McpServer, box: Toolbox): void {
  registerAppTool(
    server,
    TOOLS.viewState,
    {
      title: 'Wallet view state',
      description:
        "The wallet app's own saved view state (selected tab, filters). Bounded JSON; it never grants anything.",
      inputSchema: standard(Input),
      _meta: { ui: { visibility: ['app'] } },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const result = await box.run(viewState(input.state))
      return result.ok ? answer('View state.', { state: result.value }) : refusal(result.failure)
    },
  )
}
