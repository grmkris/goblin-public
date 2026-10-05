export function resolveStage(name: string) {
  if (name !== 'local' && name !== 'dev' && name !== 'prod' && !/^test_[a-z0-9_-]+$/u.test(name))
    throw new Error('unsupported_stage')
  return {
    name,
    workerName: `purrable-${name.replaceAll('_', '-')}`,
    resourceName: (role: string) => `purrable-${name.replaceAll('_', '-')}-${role}`,
    local: name === 'local',
  }
}
