/** The scope that lets a client read the owner's conversations and runs (ADR 0024). */
export const INSPECT_SCOPE = 'goblin:inspect'

/** The scopes a client asked for, from the consent page's `scope` parameter. */
export const requestedScopes = (scope: string | null): readonly string[] =>
  (scope ?? '').split(' ').filter((name) => name !== '')

/**
 * What the consent page posts. Inspection is opt-in: unless the owner turned it on, Allow grants what was asked for
 * without `goblin:inspect`. A request without inspection, or a denial, posts no scope and grants what was asked.
 */
export function consentBody(
  requested: readonly string[],
  accept: boolean,
  inspect: boolean,
): { readonly accept: boolean; readonly scope?: string } {
  if (!accept || inspect || !requested.includes(INSPECT_SCOPE)) return { accept }
  return { accept, scope: requested.filter((name) => name !== INSPECT_SCOPE).join(' ') }
}
