/** A skills library's `tools/list` answer: its draft tools, a new draft and a draft's review status. */
export const draftTools = () => ({
  tools: [
    { name: 'skill_draft', inputSchema: { type: 'object' as const, properties: {} } },
    { name: 'skill_draft_status', inputSchema: { type: 'object' as const, properties: {} } },
  ],
})
