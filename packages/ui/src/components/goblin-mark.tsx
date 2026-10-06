import type { ComponentProps } from 'react'
import { GOBLIN_PATHS } from '../brand.ts'

export function GoblinMark(props: ComponentProps<'svg'>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      {GOBLIN_PATHS.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}
