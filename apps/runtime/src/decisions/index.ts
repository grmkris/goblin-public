// The pure decision code the benchmark shares with the runtime (`@goblin/runtime/decisions`): the cases and their
// questions, the state-only rules, and the wire bodies and strict answer decoding of every evaluated provider.
export { tasks, Answers, DecisionCase, ContextState, BriefState, AttentionState, WorkState } from './schema.ts'
export type { Task, Question, Questions, Usage } from './schema.ts'
export { attentionLevels, prompt, questionsFor, chosen } from './questions.ts'
export { rules } from './rules.ts'
export type { RuleResult } from './rules.ts'
export { packet, typedBody, openaiBody, chatBody, decodeAnswers, usageOf, chatAnswer } from './wire.ts'
export type { Packet } from './wire.ts'
