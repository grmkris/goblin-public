/**
 * The checks behind `bun run agents:check`: the agent instructions, skills, links and provenance stay consistent for
 * every harness (docs/agents/agent-setup.md). Each check takes the repository root, so tests run them on small fixture
 * repositories; tools/agents-check.ts runs them on this one. Node APIs only: Vitest runs the tests under Node.
 */
import { Option, Schema } from 'effect'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { Sources } from './vendored.ts'

/** Skills other tools install locally into .claude/skills (gitignored); they are not ours to check. */
const LOCAL_ONLY_SKILLS = new Set<string>()
const MAX_ROOT_AGENTS_LINES = 150
const DESCRIPTION = { min: 20, max: 220 }

const SkillFrontmatter = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  'disable-model-invocation': Schema.optional(Schema.Boolean),
})
const OpenAiYaml = Schema.Struct({
  policy: Schema.optional(Schema.Struct({ allow_implicit_invocation: Schema.optional(Schema.Boolean) })),
})
const RuleFrontmatter = Schema.Struct({ paths: Schema.Array(Schema.String) })
const CursorFrontmatter = Schema.Struct({ alwaysApply: Schema.optional(Schema.Boolean) })

const read = (root: string, file: string): string => readFileSync(path.join(root, file), 'utf8')
const exists = (root: string, file: string): boolean => existsSync(path.join(root, file))

const decodeOrUndefined = <A>(schema: Schema.Decoder<A>, value: unknown): A | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(schema)(value))

/** YAML text decoded with `schema`; undefined when it does not parse or does not match. */
const decodeYaml = <A>(schema: Schema.Decoder<A>, yaml: string): A | undefined => {
  try {
    return decodeOrUndefined(schema, parseYaml(yaml))
  } catch {
    // expected: YAML that does not parse is treated as YAML that does not match, as every caller expects
    return undefined
  }
}

/** The YAML between the leading `---` lines, decoded with `schema`; undefined when it is missing or does not match. */
const frontmatter = <A>(schema: Schema.Decoder<A>, source: string): A | undefined => {
  const yaml = /^---\r?\n(?<yaml>[\s\S]*?)\r?\n---/u.exec(source)?.groups?.['yaml']
  return yaml === undefined ? undefined : decodeYaml(schema, yaml)
}

/** Files git would commit: tracked plus untracked, minus .gitignore. */
export const listFiles = (root: string): string[] =>
  execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((file) => file !== '')

const skillDirs = (root: string): string[] =>
  exists(root, '.agents/skills')
    ? readdirSync(path.join(root, '.agents/skills'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .toSorted()
    : []

export const readSourcesAt = (root: string): typeof Sources.Type | undefined =>
  exists(root, '.agents/skills/sources.json')
    ? decodeOrUndefined(Sources, JSON.parse(read(root, '.agents/skills/sources.json')))
    : undefined

// ---------------------------------------------------------------------------------------------------------------------
// skills

type SkillMatter = typeof SkillFrontmatter.Type
type SkillSourceEntry = NonNullable<ReturnType<typeof readSourcesAt>>['skills'][string]

/** Manual-only in Claude Code (`disable-model-invocation`) exactly when manual-only in Codex (agents/openai.yaml). */
const checkManualAgreement = (root: string, dir: string, matter: SkillMatter): string[] => {
  const yamlFile = `.agents/skills/${dir}/agents/openai.yaml`
  const openai = exists(root, yamlFile) ? decodeYaml(OpenAiYaml, read(root, yamlFile)) : undefined
  const manual = matter['disable-model-invocation'] === true
  if (manual === (openai?.policy?.allow_implicit_invocation === false)) return []
  return [
    manual
      ? `.agents/skills/${dir}/SKILL.md is manual-only (disable-model-invocation: true), but Codex may invoke it. Add agents/openai.yaml with \`policy: { allow_implicit_invocation: false }\`.`
      : `${yamlFile} disables implicit invocation, but SKILL.md does not set \`disable-model-invocation: true\`. Make them agree.`,
  ]
}

/** A skill written here: a description that says when to use it, and no unfinished parts. */
const checkRepoAuthored = (file: string, source: string, matter: SkillMatter): string[] => {
  const failures: string[] = []
  const length = matter.description.length
  if (length < DESCRIPTION.min || length > DESCRIPTION.max) {
    failures.push(
      `${file}: the description has ${length} characters; write ${DESCRIPTION.min}-${DESCRIPTION.max} that say when to use the skill.`,
    )
  }
  if (source.includes('TODO')) failures.push(`${file}: finish or remove the TODO.`)
  return failures
}

/** A vendored skill: its licences are present, and an unchanged SKILL.md still equals upstream. */
const checkVendored = (root: string, dir: string, entry: SkillSourceEntry): string[] => {
  const file = `.agents/skills/${dir}/SKILL.md`
  const failures = entry.licenses
    .filter((license) => !exists(root, `.agents/skills/${dir}/${license}`))
    .map((license) => `.agents/skills/${dir}/${license} is missing. Copy the upstream licence (sources.json names it).`)
  const hash = createHash('sha256')
    .update(readFileSync(path.join(root, file)))
    .digest('hex')
  if (entry.unchanged && hash !== entry.sourceSha256) {
    failures.push(
      `${file} differs from upstream (${entry.repository}@${entry.commit ?? 'local'}), but sources.json says it is unchanged. Restore the upstream file, or record the adaptation and set \`unchanged: false\`.`,
    )
  }
  for (const [relative, expected] of Object.entries(entry.copiedFileHashes ?? {})) {
    const copied = path.join(root, '.agents/skills', dir, relative)
    if (!existsSync(copied)) failures.push(`${copied} is missing from the recorded skill copy.`)
    else if (createHash('sha256').update(readFileSync(copied)).digest('hex') !== expected)
      failures.push(`${copied} differs from its recorded copy hash.`)
  }
  return failures
}

/** One skill folder; `names` collects the names seen so far, to catch duplicates. */
const checkSkill = (root: string, dir: string, entry: SkillSourceEntry | undefined, names: Set<string>): string[] => {
  const file = `.agents/skills/${dir}/SKILL.md`
  if (!exists(root, file)) return [`.agents/skills/${dir} has no SKILL.md. Add one, or remove the folder.`]
  const source = read(root, file)
  const matter = frontmatter(SkillFrontmatter, source)
  if (matter === undefined) return [`${file}: the frontmatter must be YAML with \`name\` and \`description\` strings.`]
  const failures: string[] = []
  if (matter.name !== dir) failures.push(`${file}: \`name: ${matter.name}\` must equal the folder name \`${dir}\`.`)
  if (names.has(matter.name)) failures.push(`${file}: the skill name \`${matter.name}\` is used twice.`)
  names.add(matter.name)
  failures.push(...checkManualAgreement(root, dir, matter))
  failures.push(...(entry === undefined ? checkRepoAuthored(file, source, matter) : checkVendored(root, dir, entry)))
  return failures
}

export const checkSkills = (root: string): string[] => {
  const sources = readSourcesAt(root)
  const failures =
    exists(root, '.agents/skills/sources.json') && sources === undefined
      ? ['.agents/skills/sources.json does not match its schema (tools/vendored.ts). Fix the entry the decoder names.']
      : []
  const vendored = sources?.skills ?? {}
  const names = new Set<string>()
  for (const dir of skillDirs(root)) failures.push(...checkSkill(root, dir, vendored[dir], names))
  for (const name of Object.keys(vendored).filter((candidate) => !names.has(candidate))) {
    failures.push(
      `sources.json lists \`${name}\`, but .agents/skills/${name}/SKILL.md does not exist. Remove the entry.`,
    )
  }
  return failures
}

const linkFix = (name: string): string => `Run: ln -sfn ../../.agents/skills/${name} .claude/skills/${name}`

/** Every skill is linked from .claude/skills by a relative per-skill symlink (docs/agents/agent-setup.md). */
export const checkSkillLinks = (root: string): string[] => {
  const failures: string[] = []
  const skills = new Set(skillDirs(root).filter((dir) => exists(root, `.agents/skills/${dir}/SKILL.md`)))
  const linkDir = path.join(root, '.claude/skills')
  const entries = existsSync(linkDir) ? readdirSync(linkDir) : []
  if (existsSync(linkDir) && !lstatSync(linkDir).isDirectory()) {
    return ['.claude/skills must be a directory of per-skill symlinks, not a link to .agents/skills.']
  }
  for (const name of entries) {
    if (LOCAL_ONLY_SKILLS.has(name)) continue
    const entry = path.join(linkDir, name)
    if (!lstatSync(entry).isSymbolicLink()) {
      failures.push(
        `.claude/skills/${name} must be a symlink into .agents/skills. Move the skill there. ${linkFix(name)}`,
      )
      continue
    }
    const target = readlinkSync(entry)
    if (target !== `../../.agents/skills/${name}`) {
      failures.push(`.claude/skills/${name} points at ${target}. ${linkFix(name)}`)
    } else if (!skills.has(name)) {
      failures.push(
        `.claude/skills/${name} is dangling: .agents/skills/${name}/SKILL.md does not exist. Remove the link.`,
      )
    }
  }
  for (const name of skills) {
    if (!entries.includes(name)) failures.push(`Claude Code cannot see the skill \`${name}\`. ${linkFix(name)}`)
  }
  return failures
}

// ---------------------------------------------------------------------------------------------------------------------
// instruction files

/** The root files: AGENTS.md stays short, and CLAUDE.md imports it. */
const checkRootInstructions = (root: string, rootAgents: string): string[] => {
  const failures: string[] = []
  const lines = rootAgents.split('\n').length - 1
  if (lines > MAX_ROOT_AGENTS_LINES) {
    failures.push(
      `AGENTS.md has ${lines} lines; keep it at ${MAX_ROOT_AGENTS_LINES} or fewer and move detail into docs/agents/.`,
    )
  }
  if (!exists(root, 'CLAUDE.md') || read(root, 'CLAUDE.md').split('\n')[0] !== '@AGENTS.md') {
    failures.push(
      'CLAUDE.md must start with the line `@AGENTS.md`: Claude Code reads AGENTS.md only through that import.',
    )
  }
  return failures
}

/** A nested AGENTS.md has its CLAUDE.md shim and a link from the root. */
const checkNestedAgents = (root: string, file: string, rootLinks: ReadonlySet<string>): string[] => {
  const failures: string[] = []
  const dir = path.posix.dirname(file)
  if (!exists(root, `${dir}/CLAUDE.md`) || read(root, `${dir}/CLAUDE.md`) !== '@AGENTS.md\n') {
    failures.push(`${dir}/CLAUDE.md must contain exactly \`@AGENTS.md\` so Claude Code loads ${file}.`)
  }
  if (!rootLinks.has(file)) {
    failures.push(
      `AGENTS.md does not link ${file}. Add it to the workspace list: Codex does not load nested files below its working directory.`,
    )
  }
  return failures
}

export const checkInstructions = (
  root: string,
  workspaceDirs: readonly string[],
  files: readonly string[],
): string[] => {
  if (!exists(root, 'AGENTS.md')) return ['AGENTS.md is missing at the repository root.']
  const rootAgents = read(root, 'AGENTS.md')
  const rootLinks = new Set(markdownLinks(rootAgents).map((link) => path.posix.normalize(link)))
  return [
    ...checkRootInstructions(root, rootAgents),
    ...files.filter((file) => file.endsWith('/AGENTS.md')).flatMap((file) => checkNestedAgents(root, file, rootLinks)),
    ...files
      .filter((file) => file.endsWith('/CLAUDE.md') && !exists(root, `${path.posix.dirname(file)}/AGENTS.md`))
      .map(
        (file) =>
          `${file} has no AGENTS.md next to it. Write the instructions in AGENTS.md; CLAUDE.md only imports it.`,
      ),
    ...workspaceDirs
      .filter((dir) => !exists(root, `${dir}/AGENTS.md`))
      .map((dir) => `${dir} has no AGENTS.md. Add one (role, checks, test floor, landmines) and a CLAUDE.md shim.`),
  ]
}

/** Relative link targets in Markdown, outside code blocks and code spans, without their #anchor. */
export const markdownLinks = (source: string): string[] => {
  const prose = source.replace(/```[\s\S]*?```/gu, '').replace(/`[^`\n]*`/gu, '')
  return [...prose.matchAll(/\]\((?<target>[^)\s]+)\)/gu)]
    .map((match) => match.groups?.['target'] ?? '')
    .filter((target) => target !== '' && !/^[a-z][a-z0-9+.-]*:/iu.test(target) && !target.startsWith('#'))
    .map((target) => decodeURI(target.split('#')[0] ?? ''))
}

/** Every relative link in the agent-facing Markdown resolves. Vendored skills are upstream text and are skipped. */
export const checkLinks = (root: string, files: readonly string[]): string[] => {
  const vendored = Object.keys(readSourcesAt(root)?.skills ?? {})
  const isVendored = (file: string): boolean => vendored.some((name) => file.startsWith(`.agents/skills/${name}/`))
  const checked = files.filter(
    (file) =>
      !isVendored(file) &&
      (file === 'AGENTS.md' ||
        file === 'CLAUDE.md' ||
        file === 'GLOSSARY.md' ||
        file.endsWith('/AGENTS.md') ||
        /^(?:docs\/agents|docs\/adr|\.agents\/skills|\.claude\/rules|\.cursor\/rules)\/.*\.mdc?$/u.test(file)),
  )
  const failures: string[] = []
  for (const file of checked) {
    for (const link of markdownLinks(read(root, file))) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), link))
      if (!exists(root, target)) failures.push(`${file} links ${link}, which does not exist (${target}).`)
    }
  }
  return failures
}

export const checkRules = (root: string, files: readonly string[]): string[] => {
  const failures: string[] = []
  for (const file of files.filter((candidate) => /^\.claude\/rules\/[^/]+\.md$/u.test(candidate))) {
    const matter = frontmatter(RuleFrontmatter, read(root, file))
    if (matter === undefined) {
      failures.push(`${file}: the frontmatter needs \`paths:\`, a list of globs; without it the rule always loads.`)
      continue
    }
    for (const pattern of matter.paths) {
      if (!files.some((candidate) => path.posix.matchesGlob(candidate, pattern))) {
        failures.push(`${file}: \`${pattern}\` matches no file. Fix the glob or remove it.`)
      }
    }
  }
  const cursor = files.filter((file) => /^\.cursor\/rules\/[^/]+\.mdc$/u.test(file))
  if (cursor.length === 0) {
    failures.push('.cursor/rules/ has no .mdc file pointing Cursor at AGENTS.md.')
  }
  for (const file of cursor) {
    if (frontmatter(CursorFrontmatter, read(root, file))?.alwaysApply !== true) {
      failures.push(`${file}: set \`alwaysApply: true\` so Cursor loads the pointer to AGENTS.md in every session.`)
    }
  }
  return failures
}

export const checkAll = (root: string, workspaceDirs: readonly string[]): string[] => {
  const files = listFiles(root)
  return [
    ...checkSkills(root),
    ...checkSkillLinks(root),
    ...checkInstructions(root, workspaceDirs, files),
    ...checkLinks(root, files),
    ...checkRules(root, files),
  ]
}
