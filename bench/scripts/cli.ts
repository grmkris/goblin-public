import { plan } from '../src/plan.ts'
import { starterManifest, validateManifest } from '../src/manifest.ts'

const command = Bun.argv[2] ?? 'plan'
if (!['plan', 'validate'].includes(command)) throw new Error('usage: bun run bench:plan or bench:validate')
const result = command === 'validate' ? { errors: validateManifest(starterManifest()) } : plan()
console.log(JSON.stringify(result, null, 2))
if (result.errors.length > 0) process.exitCode = 1
