/** Text the Markdown fixture (`markdown.tsx`) renders and `../ui-markdown.ts` checks against. */

/** A code block's code: highlighted once Shiki loads, and what its copy button must copy. */
export const CODE =
  'export function groupBy<T>(items: readonly T[], key: (item: T) => string) {\n  return Map.groupBy(items, key)\n}'

/** A reply with math beside prices: KaTeX sets the `$$` parts; a single `$` stays a dollar sign. */
export const MATH =
  'The area is $$\\pi r^2$$, and the book costs $5 or $10.\n\n$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$'
