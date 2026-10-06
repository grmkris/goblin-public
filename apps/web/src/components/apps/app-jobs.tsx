import type { AgentAppJob } from '@goblin/contracts'
import { CalendarClockIcon } from 'lucide-react'
import { jobLine, jobTrouble } from '../../lib/app-jobs.ts'

/**
 * An agent app's schedules in its bar (ADR 0021): the one that needs the owner's eye first, otherwise the first, and
 * every schedule in its title.
 */
export function AppJobs({ jobs }: { readonly jobs: readonly AgentAppJob[] }) {
  const shown = jobs.find(jobTrouble) ?? jobs[0]
  if (shown === undefined) return null
  const now = Date.now()
  const more = jobs.length > 1 ? ` +${String(jobs.length - 1)}` : ''
  return (
    <span
      className="app-chrome-jobs"
      data-trouble={jobTrouble(shown)}
      title={jobs.map((job) => jobLine(job, now)).join('\n')}
    >
      <CalendarClockIcon aria-hidden />
      <span className="truncate">
        {jobLine(shown, now)}
        {more}
      </span>
    </span>
  )
}
