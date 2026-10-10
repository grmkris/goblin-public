import { Fragment, useEffect } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { ChevronsUpDownIcon, CpuIcon } from 'lucide-react'
import type { ModelOption } from '@goblin/contracts'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@goblin/ui'
import { chooseModelMutation, modelQuery } from '../agent/queries.ts'
import { messageOf } from '../lib/query/app-error.ts'

/** Options by route (Google, Alibaba Cloud, ...), in the order the deployment lists them. */
function byRoute(options: readonly ModelOption[]): readonly (readonly [string, readonly ModelOption[]])[] {
  const routes = new Map<string, ModelOption[]>()
  for (const option of options) routes.set(option.route, [...(routes.get(option.route) ?? []), option])
  return [...routes]
}

/**
 * Which model answers the next message: a quiet control beside Send. The menu groups models by route because quota
 * runs out per route, which is when someone switches; each row says what the model is good for. A pick shows at once
 * and is undone if the server refuses it; `onError` hears why a read or a pick failed.
 */
export function ModelPicker({ onError }: { readonly onError: (message: string) => void }) {
  const read = useQuery(modelQuery)
  const pick = useMutation(chooseModelMutation)
  useEffect(() => {
    if (read.error !== null) onError(messageOf(read.error, 'load the models'))
  }, [read.error, onError])
  const choice = read.data
  if (choice === undefined || choice.options.length < 2) return null
  const onChoose = (model: string) => {
    if (model !== choice.current)
      pick.mutate(model, { onError: (error) => onError(messageOf(error, 'change the model')) })
  }
  const current = choice.options.find((option) => option.id === choice.current)
  const label = current?.label ?? choice.current
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button type="button" variant="ghost" size="model" aria-label={`Model: ${label}. Change model`} />}
      >
        <CpuIcon className="model-icon" aria-hidden />
        <span className="model-name truncate">{label}</span>
        <ChevronsUpDownIcon data-icon="inline-end" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-auto min-w-64">
        <DropdownMenuRadioGroup value={choice.current} onValueChange={(value: string) => onChoose(value)}>
          {byRoute(choice.options).map(([route, options], index) => (
            <Fragment key={route}>
              {index > 0 && <DropdownMenuSeparator />}
              <DropdownMenuGroup>
                <DropdownMenuLabel>{route}</DropdownMenuLabel>
                {options.map((option) => (
                  // Radio items keep a menu open by default; one pick is the whole task here.
                  <DropdownMenuRadioItem key={option.id} value={option.id} closeOnClick>
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{option.label}</span>
                      {option.note && <span className="text-xs text-muted-foreground">{option.note}</span>}
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuGroup>
            </Fragment>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
