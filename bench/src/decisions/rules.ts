import type { Answers, Fixture, Questions } from './schema.ts'
import { questionsFor } from './questions.ts'

export interface RuleResult {
  readonly answers: Answers
  readonly decided: boolean
}
const tokens = (text: string): Set<string> =>
  new Set(
    text
      .toLowerCase()
      .match(/[a-z0-9]+/gu)
      ?.filter(
        (word) =>
          word.length > 3 &&
          !['what', 'with', 'that', 'this', 'have', 'about', 'current', 'plan', 'owner'].includes(word),
      ) ?? [],
  )
const norm = (text: string): string =>
  text
    .toLowerCase()
    .replaceAll(/[^a-z0-9 ]/gu, '')
    .trim()
const certain = (questions: Questions, values: Readonly<Record<string, string>>): Answers =>
  Object.fromEntries(
    Object.entries(questions).map(([name, question]) => [
      name,
      Object.fromEntries(question.options.map((option) => [option, values[name] === option ? 1 : 0])),
    ]),
  )

function context(state: Extract<Fixture, { task: 'context-relevance' }>['state']) {
  const request = tokens(state.request)
  let decided = true
  const values: Record<string, string> = {}
  for (const candidate of state.candidates) {
    const explicit =
      state.explicitReferences.includes(candidate.id) || state.explicitReferences.includes(candidate.topic)
    const excluded = !candidate.autoEnabled || candidate.archived || candidate.supersededBy !== null
    const overlap = [...tokens(candidate.excerpt)].filter((word) => request.has(word)).length
    values[candidate.id] = explicit || (!excluded && overlap >= 2) ? 'yes' : 'no'
    if (!explicit && !excluded && overlap > 0) decided = false
  }
  values['none-relevant'] = Object.values(values).includes('yes') ? 'no' : 'yes'
  return { values, decided }
}

function brief(state: Extract<Fixture, { task: 'brief-update' }>['state']) {
  const last = state.exchange.at(-1)
  const text = last?.text ?? ''
  const tentative =
    /promising|maybe|perhaps|no decision|have not chosen|could|unverified|cannot verify|last week|last year/iu.test(
      text,
    )
  const quoted = /pat wrote|someone told|someone else|colleague/iu.test(text)
  let entry = 'none'
  if (!tentative && !quoted) {
    if (last?.role === 'report' && /measured|confirmed|observed/iu.test(text)) entry = 'finding'
    else if (last?.role === 'owner') entry = ownerEntry(text)
  }
  const duplicate = entry !== 'none' && state.brief.some((item) => norm(item) === norm(text))
  const conflict =
    entry !== 'none' &&
    !duplicate &&
    state.brief.length > 0 &&
    /correction|instead|replacing|not the|not .* in our brief/iu.test(text)
  const decided = entry === 'none' || (state.brief.length === 0 && entry === 'decision') || duplicate
  return { values: { entry, duplicate: duplicate ? 'yes' : 'no', conflict: conflict ? 'yes' : 'no' }, decided }
}
function ownerEntry(text: string): string {
  if (/\?/u.test(text)) return 'open-question'
  if (/\bnever\b|do not|keep .* private|only synthetic|must/iu.test(text)) return 'constraint'
  if (/our goal|our target|aim to/iu.test(text)) return 'goal'
  if (/we are going with|^use |^correction:|^approved|changed my mind/iu.test(text)) return 'decision'
  return 'none'
}

function attention(state: Extract<Fixture, { task: 'attention-triage' }>['state']) {
  const text = state.result
  const quiet =
    /already|superseded|old date|old-date|no .* details|no .* data|no measurements|speculat|guesses|might|may be|routine|whitespace|typo|rename|spellcheck|cache cleanup|same ordinary status/iu.test(
      text,
    )
  const urgent =
    /unavailable|sold out|cancelled|withdrawn|is gone|full|moved.*departure/iu.test(text) &&
    /tomorrow|tonight|today|imminent|handover/iu.test(text)
  const value = quiet
    ? 'quiet'
    : urgent
      ? 'highlight'
      : /compared|comparison|tradeoffs|table|both source|both amounts|synthesi/iu.test(text)
        ? 'recap'
        : 'show-on-return'
  return { values: { attention: value }, decided: quiet || urgent }
}

function work(state: Extract<Fixture, { task: 'separate-work' }>['state']) {
  const text = state.exchange.map((item) => item.text).join(' ')
  const passing = /one quick|quick aside|one-off|thanks|clarify the current|no longer active|continue this trip/iu.test(
    text,
  )
  const existing = [...state.topics, ...state.threads].find((item) =>
    text.toLowerCase().includes(item.name.toLowerCase()),
  )
  const reuse = existing !== undefined && /continue|resume/iu.test(text)
  let value = 'continue-here'
  if (reuse) value = 'reuse-existing:' + existing.id
  else if (/perhaps|maybe|cannot say|no .* plan|that thing|different project/iu.test(text)) value = 'uncertain'
  else if (/separate angle|distinct angle/iu.test(text)) value = 'suggest-thread'
  else if (/next month|next year|several weeks|ongoing|progress tracking/iu.test(text)) value = 'suggest-topic'
  return { values: { organization: value }, decided: passing || reuse }
}

/** Takes the same public evidence as models; metadata and expected labels are never read. */
export function rules(fixture: Fixture): RuleResult {
  switch (fixture.task) {
    case 'context-relevance': {
      const result = context(fixture.state)
      return { answers: certain(questionsFor(fixture), result.values), decided: result.decided }
    }
    case 'brief-update': {
      const result = brief(fixture.state)
      return { answers: certain(questionsFor(fixture), result.values), decided: result.decided }
    }
    case 'attention-triage': {
      const result = attention(fixture.state)
      return { answers: certain(questionsFor(fixture), result.values), decided: result.decided }
    }
    case 'separate-work': {
      const result = work(fixture.state)
      return { answers: certain(questionsFor(fixture), result.values), decided: result.decided }
    }
  }
}
