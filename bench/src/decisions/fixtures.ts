import { Schema } from 'effect'
import data from '../../fixtures/decisions.json'
import { Fixture } from './schema.ts'
import { questionsFor } from './questions.ts'

export const defaultFixtureFile = 'bench/fixtures/decisions.json'

/**
 * The independent author used the vocabulary below. Keep this map explicit so a
 * future fixture can use an equivalent spelling without changing the rules or
 * silently treating a label as an answer option.
 */
const LABELS: Readonly<Record<string, string>> = {
  'open-question': 'open-question',
  'show-on-return': 'show-on-return',
  'suggest-thread': 'suggest-thread',
  uncertain: 'uncertain',
  finding: 'finding',
  goal: 'goal',
  constraint: 'constraint',
  decision: 'decision',
  none: 'none',
  yes: 'yes',
  no: 'no',
  quiet: 'quiet',
  recap: 'recap',
  highlight: 'highlight',
  'continue-here': 'continue-here',
  'suggest-topic': 'suggest-topic',
}

export function normalizeLabel(label: string): string {
  if (/^reuse-existing:.+$/u.test(label)) return label
  const normalized = LABELS[label]
  if (normalized === undefined) throw new Error('Unreviewed fixture label: ' + label)
  return normalized
}

export function normalizeFixture(fixture: Fixture): Fixture {
  return {
    ...fixture,
    expected: Object.fromEntries(
      Object.entries(fixture.expected).map(([name, value]) => [name, normalizeLabel(value)]),
    ),
  }
}

/** Frozen synthetic labels stay on the coordinator; only state/questions reach providers. */
export function decodeFixtures(value: unknown): readonly Fixture[] {
  const fixtures = Schema.decodeUnknownSync(Schema.Array(Fixture))(value).map(normalizeFixture)
  if (new Set(fixtures.map((fixture) => fixture.id)).size !== fixtures.length) throw new Error('Duplicate fixture id')
  for (const fixture of fixtures) {
    const questions = questionsFor(fixture)
    if (Object.keys(questions).length !== Object.keys(fixture.expected).length)
      throw new Error('Incomplete fixture labels: ' + fixture.id)
    for (const [name, label] of Object.entries(fixture.expected))
      if (!questions[name]?.options.includes(label)) throw new Error('Label outside offered answers: ' + fixture.id)
  }
  return fixtures
}

export const decisionFixtures = decodeFixtures(data)
