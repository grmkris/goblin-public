/** The board App of the notes fixture servers. */
export const BOARD = 'ui://notes/board.html'

/** The notes server's `tools/list` answer: `open` renders the board (offered to the model), `move` is the board's own. */
export const boardTools = () => ({
  tools: [
    { name: 'open', inputSchema: { type: 'object' as const, properties: {} }, _meta: { ui: { resourceUri: BOARD } } },
    {
      name: 'move',
      inputSchema: { type: 'object' as const, properties: {} },
      _meta: { ui: { resourceUri: BOARD, visibility: ['app'] } },
    },
    { name: 'delete', inputSchema: { type: 'object' as const, properties: {} } },
  ],
})
