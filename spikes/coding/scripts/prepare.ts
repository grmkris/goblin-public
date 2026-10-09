import { mkdir, chmod } from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { SpikeError } from './overlay.ts'

const root = path.resolve(import.meta.dirname, '../../..')
const destination = path.join(root, '.local/coding-spike')
await mkdir(destination, { recursive: true, mode: 0o700 })
const snapshot = path.join(destination, 'repo')
if (await Bun.file(path.join(destination, 'config.json')).exists()) throw new SpikeError('already_prepared')
const sha = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: root }).stdout.toString().trim()
if (!/^[a-f0-9]{40}$/u.test(sha)) throw new SpikeError('invalid_base')
const archive = Bun.spawn(['git', 'archive', sha], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
await Bun.write(path.join(destination, 'repo.tar'), archive.stdout)
if ((await archive.exited) !== 0) throw new SpikeError('archive_failed')
await mkdir(snapshot, { mode: 0o700 })
if (Bun.spawnSync(['tar', '-xf', path.join(destination, 'repo.tar'), '-C', snapshot]).exitCode !== 0)
  throw new SpikeError('extract_failed')
const install = Bun.spawn(['bun', 'install', '--frozen-lockfile'], {
  cwd: snapshot,
  stdout: 'inherit',
  stderr: 'inherit',
})
if ((await install.exited) !== 0) throw new SpikeError('dependency_install_failed')
const names = Bun.spawnSync(['git', 'ls-tree', '-r', '--name-only', sha], { cwd: root })
  .stdout.toString()
  .trim()
  .split('\n')
await Bun.write(path.join(destination, 'files.json'), JSON.stringify(names))
const config = {
  repo: 'grmkris/goblin',
  base: sha,
  root: snapshot,
  state: destination,
  gh: '/usr/bin/gh',
  port: 18983,
  origin: 'http://127.0.0.1:18983',
  ownerOrigin: 'https://dev.goblin.surf',
  runner: { kind: 'native' },
  adminKey: randomBytes(32).toString('hex'),
}
const file = path.join(destination, 'config.json')
await Bun.write(file, JSON.stringify(config))
await chmod(file, 0o600)
console.log(JSON.stringify({ prepared: true, base: sha, files: names.length, root: snapshot }))
