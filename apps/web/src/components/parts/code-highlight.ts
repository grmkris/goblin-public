import type { PluginConfig } from 'streamdown'
import { lazyPlugin } from './lazy-plugin.ts'

/**
 * Syntax highlighting for code blocks (Shiki, through `@streamdown/code`), loaded the first time a reply shows one:
 * until then code shows plain, and neither the chat route's first load nor the Worker carries it.
 */
export const useCodeHighlighter = lazyPlugin<NonNullable<PluginConfig['code']>>(() =>
  import.meta.env.SSR
    ? undefined
    : import('@streamdown/code').then(({ createCodePlugin }) =>
        createCodePlugin({ themes: ['github-light', 'github-dark'] }),
      ),
)
