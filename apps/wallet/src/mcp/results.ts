import type { WalletFailure } from '../services/errors.ts'

/** A tool result with a text fallback and the structured content goblin and the App read. */
export const answer = (text: string, structuredContent: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text }],
  structuredContent,
})

/** A refusal as the tool's error result: what happened and what to do, never a stack. */
export const refusal = (failure: WalletFailure) => ({
  isError: true,
  content: [
    {
      type: 'text' as const,
      text: failure.recovery === undefined ? failure.message : `${failure.message} ${failure.recovery}`,
    },
  ],
  structuredContent: {
    error: {
      code: failure.code,
      message: failure.message,
      ...(failure.recovery === undefined ? {} : { recovery: failure.recovery }),
    },
  },
})
