// Each agent app's stylesheet, compiled in a Dynamic Worker of its own (ADR 0021): the classes its view uses, with
// goblin's theme. goblin's components and the kit bring their styles in the frame's own ui.css.
import { WorkerEntrypoint } from 'cloudflare:workers'
import { candidates, compileCss } from './css.ts'
import sheets from './sheets.js'

export class Style extends WorkerEntrypoint {
  /** The CSS for the view's source. */
  css(view: string): Promise<string> {
    return compileCss(sheets, candidates(view))
  }
}

export default {}
