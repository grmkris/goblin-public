import { type Args, UsageError } from './args.ts'
import { logLine, operationsOf, searchLogs } from './logs.ts'

/**
 * `goblin lookup <ref|request|operation>`: what a failure's reference (a cf-ray), a browser request id or an
 * operation id points at. First the stage Worker's log lines that mention it, then the details of the operation those
 * lines name, or of the id itself when no line names one (`details` reads them from `inspect_details`).
 */
export async function lookup(
  args: Args,
  origin: string,
  now: number,
  details: (operation: string) => Promise<string>,
): Promise<string> {
  const id = args.positionals[0]
  if (id === undefined) throw new UsageError('goblin lookup <reference, request or operation id> [--since 6h]')
  const { worker, events } = await searchLogs(args, origin, now, id, 'lookup')
  const operation = operationsOf(events)[0] ?? id
  return [
    ...(events.length === 0 ? [`No ${worker} log lines mention ${id}.`] : events.map(logLine)),
    '',
    `Details of ${operation}:`,
    await details(operation),
  ].join('\n')
}
