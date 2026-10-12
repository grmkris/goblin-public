import type { McpServer } from '@modelcontextprotocol/server'
import { TOOLS } from '@goblin/wallet/contract'
import { listServices } from '../../services/programs/services-list.ts'
import { answer, refusal } from '../results.ts'
import type { Toolbox } from '../toolbox.ts'

export function registerServices(server: McpServer, box: Toolbox): void {
  server.registerTool(
    TOOLS.services,
    {
      title: 'Paid services',
      description:
        'The paid services paid_fetch may call: id, exact URL, rails, chains, per-call cap and what each returns. Only the owner adds services.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const result = await box.run(listServices)
      if (!result.ok) return refusal(result.failure)
      const lines = result.value.map(
        (s) =>
          `${s.id}: ${s.method} ${s.url} via ${s.rails.join('/')} on ${s.chains.join('/')}, up to $${s.maxPerCall}. ${s.description}`,
      )
      return answer(lines.join('\n'), { services: result.value })
    },
  )
}
