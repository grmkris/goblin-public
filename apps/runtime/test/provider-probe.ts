import { Type } from '@earendil-works/pi-ai'
import { Config, Console, Effect } from 'effect'
import { makePiModels } from '../src/pi/model.ts'

/** Manually invoked, bounded real provider acceptance. No tool implementation is supplied or executed. */
async function providerProbe(): Promise<void> {
  const { MODEL_BASE_URL, MODEL_ID, MODEL_KEY } = await Effect.runPromise(
    Config.all({
      MODEL_BASE_URL: Config.String('GOBLIN_MODEL_BASE_URL'),
      MODEL_ID: Config.String('GOBLIN_MODEL_ID'),
      MODEL_KEY: Config.String('GOBLIN_MODEL_KEY'),
    }),
  )
  if (!MODEL_BASE_URL || !MODEL_ID || !MODEL_KEY) throw new Error('dedicated_model_configuration_required')
  const { models, model } = makePiModels({ MODEL_BASE_URL, MODEL_ID, MODEL_KEY })
  const options = { maxTokens: 150, maxRetries: 0, timeoutMs: 30_000 }
  const chat = models.streamSimple(
    model,
    {
      messages: [{ role: 'user', content: 'Reply with exactly GOBLIN_OK', timestamp: 0 }],
    },
    options,
  )
  let textDeltas = 0
  for await (const event of chat) if (event.type === 'text_delta') textDeltas++
  const chatResult = await chat.result()
  const tools = [
    {
      name: 'goblin_probe',
      description: 'Harmless compatibility probe; reports a number.',
      parameters: Type.Object({ value: Type.Number() }),
    },
  ]
  const tool = models.streamSimple(
    model,
    {
      messages: [
        {
          role: 'user',
          content: 'Call goblin_probe exactly once with JSON argument {"value":7}. Do not answer in text.',
          timestamp: 0,
        },
      ],
      tools,
    },
    { ...options, toolChoice: 'auto' },
  )
  let toolDeltas = 0
  for await (const event of tool) if (event.type === 'toolcall_delta') toolDeltas++
  const toolResult = await tool.result()
  const evidence = {
    environment: 'host-to-configured-provider',
    model: MODEL_ID,
    streamingStop: chatResult.stopReason,
    streamingMatched: chatResult.content.some((block) => block.type === 'text' && block.text.includes('GOBLIN_OK')),
    textDeltas,
    toolStop: toolResult.stopReason,
    toolDeltas,
    toolCallMatched: toolResult.content.some(
      (block) => block.type === 'toolCall' && block.name === 'goblin_probe' && block.arguments['value'] === 7,
    ),
    toolExecuted: false,
    errors: [chatResult.errorMessage, toolResult.errorMessage]
      .filter((value): value is string => value !== undefined)
      .map((value) => value.replaceAll(MODEL_KEY, '[REDACTED]').slice(0, 1200)),
  }
  await Effect.runPromise(Console.log(JSON.stringify(evidence)))
  if (!evidence.streamingMatched || !evidence.toolCallMatched) process.exitCode = 1
}

await providerProbe()
