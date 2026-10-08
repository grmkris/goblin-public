import { Fragment, useEffect, useState } from 'react'
import { Schema } from 'effect'
import { ChevronsUpDownIcon } from 'lucide-react'
import { ModelChoice, type ModelOption } from '@goblin/contracts'
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
import { failureText, request } from '../lib/boundary.ts'

const decodeChoice = Schema.decodeUnknownSync(ModelChoice)

/** The user's model and what the deployment offers. A pick shows at once and is undone if the server refuses it. */
export function useModelChoice(onError: (message: string) => void) {
  const [choice, setChoice] = useState<ModelChoice>()
  useEffect(() => {
    const controller = new AbortController()
    void request('/api/agent/model', { signal: controller.signal })
      .then((data) => setChoice(decodeChoice(data)))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) onError(failureText(error))
      })
    return () => controller.abort()
  }, [onError])
  async function choose(model: string): Promise<void> {
    if (choice === undefined || model === choice.current) return
    const previous = choice
    setChoice({ ...choice, current: model })
    try {
      setChoice(decodeChoice(await request('/api/agent/model', { method: 'PUT', body: { model } })))
    } catch (error) {
      setChoice(previous)
      onError(failureText(error))
    }
  }
  return { choice, choose }
}

/** Options by route (Google, Alibaba Cloud, ...), in the order the deployment lists them. */
function byRoute(options: readonly ModelOption[]): readonly (readonly [string, readonly ModelOption[]])[] {
  const routes = new Map<string, ModelOption[]>()
  for (const option of options) routes.set(option.route, [...(routes.get(option.route) ?? []), option])
  return [...routes]
}

/**
 * Which model answers the next message: a quiet control beside Send. The menu groups models by route because quota
 * runs out per route, which is when someone switches; each row says what the model is good for.
 */
export function ModelPicker({
  choice,
  onChoose,
}: {
  readonly choice: ModelChoice | undefined
  readonly onChoose: (model: string) => void
}) {
  if (choice === undefined || choice.options.length < 2) return null
  const current = choice.options.find((option) => option.id === choice.current)
  const label = current?.label ?? choice.current
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button type="button" variant="ghost" size="model" aria-label={`Model: ${label}. Change model`} />}
      >
        <span className="truncate">{label}</span>
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
