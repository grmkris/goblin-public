import type { ErrorComponentProps } from '@tanstack/react-router'
import { reportCrash } from '../../../lib/api.ts'
import { describeError } from '../../../lib/query/app-error.ts'
import { type CrashReport, RouteError } from '../../../lib/query/route-error.tsx'

/** A crash is a failure no API answered (a defect); a typed refusal is already in the agent's logs, under its ref. */
const reportDefect = ({ routeId, error }: CrashReport) => {
  if (describeError(error).kind === 'defect') reportCrash(error, routeId)
}

/** A page whose read failed: the route error view inside the shell, with the reference to quote and a retry. */
export function PageError(props: ErrorComponentProps) {
  return <RouteError {...props} onCrash={reportDefect} />
}
