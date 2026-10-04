/**
 * `bun run agents:check`: the agent setup is consistent for every harness (docs/agents/agent-setup.md).
 *
 * - Skills: valid frontmatter, name equals folder, unique; repo-authored descriptions 20-220 characters, no TODO;
 *   manual-only in Claude Code exactly when manual-only in Codex.
 * - Vendored skills (sources.json): licences present, unchanged SKILL.md equal to upstream, skipped by oxfmt and
 *   oxlint.
 * - .claude/skills: one relative symlink per skill, none dangling.
 * - Instructions: CLAUDE.md imports AGENTS.md; every workspace and nested AGENTS.md has its CLAUDE.md shim and a link
 *   from the root; relative links resolve; .claude/rules globs match files; .cursor/rules points Cursor at AGENTS.md.
 */
import { Schema } from 'effect'
import path from 'node:path'
import { checkAll, readSourcesAt } from './agents.ts'
import { nodes } from './graph.ts'
import { repoRoot } from './run.ts'

const IgnoreConfig = Schema.Struct({
  default: Schema.Struct({ ignorePatterns: Schema.optional(Schema.Array(Schema.String)) }),
})

/** Vendored skills keep their upstream form only if both configs skip them (tools/vendored.ts feeds both). */
const checkIgnores = async (): Promise<string[]> => {
  const vendored = Object.keys(readSourcesAt(repoRoot)?.skills ?? {})
  const failures: string[] = []
  for (const config of ['oxfmt.config.ts', 'oxlint.config.ts']) {
    const module = Schema.decodeUnknownSync(IgnoreConfig)(await import(path.join(repoRoot, config)))
    const patterns = module.default.ignorePatterns ?? []
    for (const name of vendored) {
      if (!patterns.includes(`.agents/skills/${name}/**`)) {
        failures.push(
          `${config} does not ignore .agents/skills/${name}. Spread agentIgnorePatterns() into ignorePatterns.`,
        )
      }
    }
  }
  return failures
}

const failures = [
  ...checkAll(
    repoRoot,
    nodes.map((node) => node.dir),
  ),
  ...(await checkIgnores()),
]
if (failures.length > 0) {
  for (const failure of failures) console.error(failure)
  console.error(`\nagents:check: ${failures.length} problem(s).`)
  process.exitCode = 1
} else {
  console.info('agents:check passed')
}
