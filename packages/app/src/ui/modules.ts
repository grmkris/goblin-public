// The module registry of an app's frame: what each bundle provides and what the view's code requires from it.

type Registry = Record<string, unknown>
// SAFETY: the registry is the frame's own global; the core and every bundle create or share it here.
const scope = globalThis as typeof globalThis & { __goblinModules?: Registry }

/** The frame's modules by the name a view requires them with; every bundle adds to the same registry. */
export const modules: Registry = (scope.__goblinModules ??= {})

/** Adds a bundle's modules. */
export function provide(added: Registry): void {
  Object.assign(modules, added)
}

/** A module of the frame by name; the transpiler already refused names that are not among them. */
export function frameRequire(name: string): unknown {
  if (name in modules) return modules[name]
  throw new Error(`"${name}" is not available in an app's view.`)
}
