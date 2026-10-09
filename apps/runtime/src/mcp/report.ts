import { writeLine } from '../observability/logger.ts'
import { framesOf, safeErrorType } from '../observability/report.ts'

/**
 * Reports a failure caught in the MCP area's plain-async code (no fiber to report through): one `failure` line with
 * where it happened, the failure's type and its stack locations, never its message (ADR 0024). The same line the
 * runtime's failure reporter writes for a program.
 */
export function reportCaught(where: string, error: unknown): void {
  writeLine('error', {
    event: 'failure',
    where,
    'error.type': safeErrorType(error),
    frames: error instanceof Error ? framesOf(error) : [],
    severity: 'Error',
  })
}
