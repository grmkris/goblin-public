import getEffectExePath from '../node_modules/@effect/tsgo/lib/getExePath.js'
import getTypeExePath from '../node_modules/typescript/lib/getExePath.js'
import { writeFileSync } from 'node:fs'
import path from 'node:path'

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

/** The native API has no env option. Fixed wrappers scrub the inherited environment before exec. */
export function compilers(state: string): { type: string; effect: string } {
  const wrap = (name: string, binary: string): string => {
    const file = path.join(state, `${name}.sh`)
    writeFileSync(file, `#!/bin/sh\nexec /usr/bin/env -i PATH=/usr/bin:/bin ${quote(binary)} "$@"\n`, { mode: 0o700 })
    return file
  }
  return { type: wrap('typescript', getTypeExePath()), effect: wrap('effect', getEffectExePath()) }
}
