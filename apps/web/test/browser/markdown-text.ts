/** Text the Markdown fixture (`markdown.tsx`) renders and `../ui-markdown.ts` checks against. */

/** A code block's code: highlighted once Shiki loads, and what its copy button must copy. */
export const CODE =
  'export function groupBy<T>(items: readonly T[], key: (item: T) => string) {\n  return Map.groupBy(items, key)\n}'
