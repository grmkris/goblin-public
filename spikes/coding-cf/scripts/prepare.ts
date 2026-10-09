import { cp, mkdir, chmod } from 'node:fs/promises'
import path from 'node:path'

const spike = path.resolve(import.meta.dirname, '..')
const root = path.resolve(spike, '../..')
const state = path.join(root, '.local/coding-cf-spike')
const sourceState = path.resolve(root, Bun.argv[2] ?? '.local/coding-spike')
const previous: { base: string } = await Bun.file(path.join(sourceState, 'config.json')).json()
const destination = path.join(state, `image-${previous.base.slice(0, 12)}`)
const frozen = Bun.file(path.join(destination, 'fixture/base'))
if ((await frozen.exists()) && (await frozen.text()) !== previous.base) throw new Error('image_base_mismatch')
await mkdir(path.join(destination, 'repo'), { recursive: true, mode: 0o700 })
await chmod(state, 0o700)
const tar = path.join(state, 'repo.tar')
if (Bun.spawnSync(['git', 'archive', previous.base, '-o', tar], { cwd: root }).exitCode !== 0)
  throw new Error('archive_failed')
if (Bun.spawnSync(['tar', '-xf', tar, '-C', path.join(destination, 'repo')]).exitCode !== 0)
  throw new Error('extract_failed')
await mkdir(path.join(destination, 'fixture'), { recursive: true })
await Bun.write(path.join(destination, 'fixture/base'), previous.base)
await cp(path.join(sourceState, 'files.json'), path.join(destination, 'fixture/files.json'))
await cp(path.join(spike, '../coding'), path.join(destination, 'coding'), {
  recursive: true,
  filter: (file) => !file.includes('/node_modules') && !file.includes('/.local'),
})
await cp(path.join(spike, 'runner'), path.join(destination, 'runner'), { recursive: true })
await cp(path.join(spike, 'Dockerfile'), path.join(destination, 'Dockerfile'))
console.log(JSON.stringify({ prepared: true, base: previous.base, image: destination }))
