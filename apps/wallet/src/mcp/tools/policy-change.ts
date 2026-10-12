import type { McpServer } from '@modelcontextprotocol/server'
import { PolicyChangeInput, TOOLS } from '@goblin/wallet/contract'
import { requestPolicyChange } from '../../services/programs/policy.ts'
import { answer, refusal } from '../results.ts'
import { standard } from '../standard.ts'
import type { Toolbox } from '../toolbox.ts'

export function registerPolicyChange(server: McpServer, box: Toolbox): void {
  server.registerTool(
    TOOLS.policyChange,
    {
      title: 'Ask the owner to change a limit',
      description:
        'Ask the owner for a policy change, such as a higher limit or a new paid service. It only records the request; the owner decides in the wallet app, and nothing changes until they do.',
      inputSchema: standard(PolicyChangeInput),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const result = await box.run(requestPolicyChange(input, box.client))
      if (!result.ok) return refusal(result.failure)
      return answer(`Recorded for the owner (${result.value.id}). Nothing changes until they decide.`, {
        request: result.value,
      })
    },
  )
}
