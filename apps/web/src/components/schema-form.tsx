// An event routine's filters as a form from the event's input schema (ADR 0041), or as JSON when the schema is more
// than a flat form holds or the owner would rather write it. The schema and its words are the server's, shown as text.
import { useState } from 'react'
import { Option, Schema } from 'effect'
import {
  Button,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  NativeSelect,
  NativeSelectOption,
  Textarea,
} from '@goblin/ui'
import {
  type FormField,
  type FormInputs,
  type FormResult,
  formFields,
  formInputs,
  formValue,
} from '../lib/schema-form.ts'

type Json = typeof Schema.Json.Type
type Filters = Readonly<Record<string, Json>>

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)))

/** What the JSON says, or what to fix: an object, or nothing for every event. */
function jsonResult(text: string): FormResult {
  const typed = text.trim()
  if (typed === '') return { value: {} }
  return Option.match(decodeJson(typed), {
    onNone: () => ({ problem: 'Write the filters as a JSON object, or leave them empty.' }),
    onSome: (value) => ({ value }),
  })
}

/** One field: free text, a number, one of a list (or any), yes or no (or any), or texts separated by commas. */
function FormFieldInput({
  id,
  field,
  value,
  onInput,
}: {
  readonly id: string
  readonly field: FormField
  readonly value: string
  readonly onInput: (value: string) => void
}) {
  const control = `${id}-${field.name}`
  const choices =
    field.kind === 'choice'
      ? field.options.map((option) => ({ value: option, label: option }))
      : field.kind === 'boolean'
        ? [
            { value: 'true', label: 'Yes' },
            { value: 'false', label: 'No' },
          ]
        : undefined
  return (
    <Field>
      <FieldLabel htmlFor={control}>
        {field.title}
        {!field.required && <span className="field-optional"> (optional)</span>}
      </FieldLabel>
      {choices === undefined ? (
        <Input
          id={control}
          value={value}
          onChange={(event) => onInput(event.target.value)}
          required={field.required}
          {...(field.kind === 'number' && { type: 'number', inputMode: field.integer ? 'numeric' : 'decimal' })}
        />
      ) : (
        <NativeSelect
          id={control}
          value={value}
          onChange={(event) => onInput(event.target.value)}
          required={field.required}
        >
          <NativeSelectOption value="">{field.required ? 'Choose one' : 'Any'}</NativeSelectOption>
          {choices.map((choice) => (
            <NativeSelectOption key={choice.value} value={choice.value}>
              {choice.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      )}
      {(field.description !== undefined || field.kind === 'list') && (
        <FieldDescription>
          {field.description}
          {field.kind === 'list' && ' Separate several with commas.'}
        </FieldDescription>
      )}
    </Field>
  )
}

/** What the filters' form keeps: the fields, what was typed in them or as JSON, which one shows, and what to fix. */
function useSchemaForm(schema: unknown, initial: Filters, onChange: (result: FormResult) => void) {
  const fields = formFields(schema)
  const fitted = fields === undefined ? undefined : formInputs(fields, initial)
  const [inputs, setInputs] = useState<FormInputs>(fitted ?? {})
  const [json, setJson] = useState(Object.keys(initial).length === 0 ? '' : JSON.stringify(initial, null, 2))
  const [asJson, setAsJson] = useState(fitted === undefined)
  const [problem, setProblem] = useState('')
  const report = (result: FormResult) => {
    setProblem('problem' in result ? result.problem : '')
    onChange(result)
  }
  const input = (name: string, value: string) => {
    const next = { ...inputs, [name]: value }
    setInputs(next)
    if (fields !== undefined) report(formValue(fields, next))
  }
  const write = (text: string) => {
    setJson(text)
    report(jsonResult(text))
  }
  const toJson = () => {
    const result = fields === undefined ? { value: initial } : formValue(fields, inputs)
    if ('value' in result) setJson(Object.keys(result.value).length === 0 ? '' : JSON.stringify(result.value, null, 2))
    setAsJson(true)
  }
  const toForm = () => {
    const result = jsonResult(json)
    const back = fields === undefined || 'problem' in result ? undefined : formInputs(fields, result.value)
    if (back === undefined) {
      setProblem('These filters do not fit the form: keep them as JSON.')
      return
    }
    setInputs(back)
    setAsJson(false)
    setProblem('')
  }
  return { fields, inputs, json, asJson, problem, input, write, switchTo: asJson ? toForm : toJson }
}

/**
 * An event routine's filters, from the event's input schema: a field for each flat property (required ones first), or
 * JSON when the schema has more than a form holds, the filters do not fit it, or the owner switches. Reports the
 * filters, or what to fix, on every change; left empty, a field matches anything.
 */
export function SchemaForm({
  id,
  schema,
  initial,
  onChange,
}: {
  readonly id: string
  readonly schema: unknown
  readonly initial: Filters
  readonly onChange: (result: FormResult) => void
}) {
  const { fields, inputs, json, asJson, problem, input, write, switchTo } = useSchemaForm(schema, initial, onChange)
  return (
    <div className="schema-form">
      {asJson ? (
        <Field>
          <FieldLabel htmlFor={`${id}-json`}>Only events matching (optional)</FieldLabel>
          <Textarea
            id={`${id}-json`}
            value={json}
            placeholder="{}"
            maxLength={16_384}
            onChange={(event) => write(event.target.value)}
          />
          <FieldDescription>Exact values as JSON, which the server checks for you.</FieldDescription>
        </Field>
      ) : (
        fields?.map((field) => (
          <FormFieldInput
            key={field.name}
            id={id}
            field={field}
            value={inputs[field.name] ?? ''}
            onInput={(value) => input(field.name, value)}
          />
        ))
      )}
      {fields?.length === 0 && !asJson && (
        <p className="server-note">This event takes no filters: every one matches.</p>
      )}
      {problem !== '' && (
        <p className="server-note" role="alert">
          {problem}
        </p>
      )}
      {fields !== undefined && fields.length > 0 && (
        <Button type="button" size="xs" variant="ghost" onClick={switchTo}>
          {asJson ? 'Use the form' : 'Edit as JSON'}
        </Button>
      )}
    </div>
  )
}
