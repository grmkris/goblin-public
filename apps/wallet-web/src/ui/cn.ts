/** Joins class names, skipping falsy parts. Conflicting utilities are not merged, so callers avoid passing them. */
export const cn = (...parts: readonly (string | false | null | undefined)[]): string =>
  parts.filter((part): part is string => typeof part === 'string' && part !== '').join(' ')
