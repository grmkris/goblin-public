/** A command line split into its command, positional words and `--flags`. */
export type Args = {
  readonly command: string | undefined
  readonly positionals: readonly string[]
  readonly flags: ReadonlyMap<string, string | true>
}

/** Flags that never take a value. */
const SWITCHES = new Set(['json', 'help', 'open', 'all'])

export class UsageError extends Error {
  override readonly name = 'UsageError'
}

/** `goblin turn telegram-12 --json --since=1h`: `--name value`, `--name=value` and the switches above. */
export function parseArgs(argv: readonly string[]): Args {
  const words: string[] = []
  const flags = new Map<string, string | true>()
  for (let index = 0; index < argv.length; index++) {
    const word = argv[index] ?? ''
    if (!word.startsWith('--') || word === '--') {
      words.push(word)
      continue
    }
    const [name = '', inline] = word.slice(2).split(/=(.*)/su)
    if (inline !== undefined) flags.set(name, inline)
    else if (SWITCHES.has(name)) flags.set(name, true)
    else {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new UsageError(`--${name} needs a value`)
      flags.set(name, value)
      index++
    }
  }
  const [command, ...positionals] = words
  return { command, positionals, flags }
}

/** A flag's text value, if it was given one. */
export const flagText = (args: Args, name: string): string | undefined => {
  const value = args.flags.get(name)
  return typeof value === 'string' ? value : undefined
}

const UNITS: Readonly<Record<string, number>> = { m: 60_000, h: 3_600_000, d: 86_400_000 }

/** `30m`, `6h`, `2d` as milliseconds. */
export function windowOf(text: string): number {
  const match = /^(\d{1,4})([mhd])$/u.exec(text)
  const unit = UNITS[match?.[2] ?? '']
  if (match === null || unit === undefined) throw new UsageError(`--since takes 30m, 6h or 2d, not ${text}`)
  return Number(match[1]) * unit
}
