import type { PluginConfig } from 'streamdown'
import { lazyPlugin } from './lazy-plugin.ts'

/**
 * Math in a reply (KaTeX, through `@streamdown/math`), loaded with its stylesheet the first time a reply holds `$$`:
 * `$$x^2$$` inline and a `$$` block on its own lines. A single `$` stays a dollar sign, so prices read as prices.
 */
export const useMath = lazyPlugin<NonNullable<PluginConfig['math']>>(() =>
  import.meta.env.SSR
    ? undefined
    : Promise.all([import('@streamdown/math'), import('katex/dist/katex.min.css')]).then(([{ createMathPlugin }]) =>
        createMathPlugin({ singleDollarTextMath: false }),
      ),
)

/** Whether `text` may hold math: anything between `$$` marks. */
export const mayHoldMath = (text: string) => text.includes('$$')
