import { describeError } from './query/app-error.ts'

/**
 * The page's own words for a failure it expects (a name in use, a move under way), ending with the reference to quote
 * when the failure has one, as messageOf's copy does ("… · ref 7f3a9c12").
 */
export function withRef(text: string, failure: unknown): string {
  const ref = describeError(failure).ref
  return ref === undefined ? text : `${text} · ref ${ref.slice(0, 8)}`
}
