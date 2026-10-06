import { describe, expect, it } from 'vitest'
import { UsageError, parseArgs, windowOf } from '../src/args.ts'
import { type ToolInfo, argumentsFor, commandOf, usage } from '../src/commands.ts'

const turn: ToolInfo = {
  name: 'inspect_turn',
  description: 'One turn end to end.',
  inputSchema: {
    properties: { operationId: { type: 'string', description: "The turn's operation id." } },
    required: ['operationId'],
  },
}
const problems: ToolInfo = {
  name: 'inspect_problems',
  inputSchema: { properties: { since: { type: 'integer' }, limit: { type: 'integer' } } },
}
const operatorTurns: ToolInfo = {
  name: 'inspect_turns',
  inputSchema: { properties: { user: { type: 'string' }, limit: { type: 'integer' } }, required: ['user'] },
}
const NOW = 1_000_000_000

describe('goblin command lines (unit)', () => {
  it('splits a command line into words and flags', () => {
    expect(parseArgs(['turn', 'telegram-12', '--json', '--since=6h', '--origin', 'http://localhost:18971'])).toEqual({
      command: 'turn',
      positionals: ['telegram-12'],
      flags: new Map<string, string | true>([
        ['json', true],
        ['since', '6h'],
        ['origin', 'http://localhost:18971'],
      ]),
    })
    expect(() => parseArgs(['turn', '--origin'])).toThrow(UsageError)
  })

  it('names commands after their tools', () => {
    expect(['inspect_turn', 'inspect_problems', 'operator_reads', 'other'].map(commandOf)).toEqual([
      'turn',
      'problems',
      'reads',
      'other',
    ])
  })

  it("reads a tool's arguments against its own schema", () => {
    expect(argumentsFor(turn, parseArgs(['turn', 'telegram-12']), NOW)).toEqual({ operationId: 'telegram-12' })
    expect(argumentsFor(turn, parseArgs(['turn', '--operation-id', 'op-1', '--json']), NOW)).toEqual({
      operationId: 'op-1',
    })
    expect(argumentsFor(problems, parseArgs(['problems', '--limit', '5', '--since', '2h']), NOW)).toEqual({
      limit: 5,
      since: NOW - 2 * 3_600_000,
    })
    expect(argumentsFor(problems, parseArgs(['problems', '--since', '1700000000000']), NOW)).toEqual({
      since: 1_700_000_000_000,
    })
    expect(argumentsFor(operatorTurns, parseArgs(['turns', '--user', 'a@b.test']), NOW)).toEqual({ user: 'a@b.test' })
  })

  it('refuses what the schema does not take', () => {
    const fails = (tool: ToolInfo, argv: string[]) => () => argumentsFor(tool, parseArgs(argv), NOW)
    expect(fails(turn, ['turn'])).toThrow('turn needs --operation-id')
    expect(fails(turn, ['turn', 'a', 'b'])).toThrow('unexpected b')
    expect(fails(problems, ['problems', '--limit', 'many'])).toThrow('--limit takes a number')
    expect(fails(problems, ['problems', '--verbose', 'yes'])).toThrow('problems has no --verbose')
    expect(fails(operatorTurns, ['turns'])).toThrow('turns needs --user')
    expect(() => windowOf('soon')).toThrow(UsageError)
  })

  it('prints help from the tool itself', () => {
    expect(usage(turn)).toBe(
      "goblin turn\n\nOne turn end to end.\n\n  --operation-id (required)  The turn's operation id.",
    )
  })
})
