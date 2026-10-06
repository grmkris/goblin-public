// Tailwind's compiler with goblin's theme, for a set of words that could be classes (ADR 0021). The style isolate
// compiles each app's view with it; the toolchain build compiles goblin's own components into the frame's ui.css.
import { compile } from 'tailwindcss'

/** goblin's theme and what it imports, by the id it imports each with. */
export type Sheets = { readonly theme: string; readonly imports: Readonly<Record<string, string>> }

/** At most this long is a word a class could be. */
const LONGEST = 120

/** Every word of `source` that could name a class; Tailwind ignores those that do not. */
export function candidates(source: string): string[] {
  return source.split(/[\s"'`{}();,<>=]+/u).filter((word) => word !== '' && word.length <= LONGEST)
}

/** The stylesheet for exactly the classes among `words`, with the theme's variables and base styles. */
export async function compileCss(sheets: Sheets, words: Iterable<string>): Promise<string> {
  const compiler = await compile(sheets.theme, {
    base: '/',
    loadStylesheet: async (id: string) => ({ base: '/', path: id, content: sheets.imports[id] ?? '' }),
  })
  return compiler.build([...new Set(words)])
}
