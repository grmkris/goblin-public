/** Shared local Alchemy state survives CI checkout cleanup, including partial failed deployments. */
import { existsSync, lstatSync, mkdirSync, readlinkSync, renameSync, symlinkSync } from 'node:fs'
import { resolve } from 'node:path'

export const DEFAULT_RELEASE_ROOT = '/var/lib/goblin-release'

export function attachStageState(root: string, stage: string, releaseRoot: string): void {
  const target = resolve(releaseRoot, 'alchemy/state/goblin', stage)
  if (!existsSync(target)) throw new Error(`release_state_not_seeded: ${stage}`)
  const link = resolve(root, 'apps/web/.alchemy/state/goblin', stage)
  mkdirSync(resolve(link, '..'), { recursive: true })
  if (existsSync(link)) {
    if (lstatSync(link).isSymbolicLink()) {
      if (resolve(link, '..', readlinkSync(link)) !== target) throw new Error('unexpected_stage_state_link')
      return
    }
    // Preserve the original operator state after the deliberate one-time seed.
    const backup = `${link}.before-shared-state`
    if (existsSync(backup)) throw new Error('stage_state_backup_already_exists')
    renameSync(link, backup)
  }
  symlinkSync(target, link, 'dir')
}
