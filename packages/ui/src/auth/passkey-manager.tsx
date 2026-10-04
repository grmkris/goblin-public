// Adapted from grmkris/myapps packages/ui/src/auth (9616f76): the sign-in look Kristjan uses across his apps.
/**
 * The authenticated passkey enrolment surface: list, add (named) and remove (confirmed) passkeys. Changing passkeys
 * needs a fresh session (Better Auth's rule): without one the manager asks the person to sign in again and offers no
 * change. The app passes its auth client's list/add/delete calls.
 */
import { KeyRoundIcon, LogInIcon, PlusIcon, ShieldAlertIcon, Trash2Icon, TriangleAlertIcon } from 'lucide-react'
import { useId, useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '../components/alert.tsx'
import { Badge } from '../components/badge.tsx'
import { Button } from '../components/button.tsx'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../components/empty.tsx'
import { Field, FieldError, FieldGroup, FieldLabel } from '../components/field.tsx'
import { Input } from '../components/input.tsx'
import { ActionIcon } from './action-icon.tsx'
import { type AuthActionResult, labelsWith, type PasskeySummary, type SignInLabels } from './contract.ts'
import { usePasskeySupport } from './sign-in.tsx'
import { useAction } from './use-action.ts'

export interface PasskeyManagerProps {
  readonly passkeys: readonly PasskeySummary[]
  /** The session is recent enough to change passkeys; otherwise the manager only lists them. */
  readonly freshSession: boolean
  /** Registers a passkey under `name` (the WebAuthn ceremony runs in the app's auth client). */
  readonly onAdd: (name: string) => Promise<AuthActionResult>
  readonly onRemove: (id: string) => Promise<AuthActionResult>
  /** Starts a new sign-in, for a fresh session. */
  readonly onReauthenticate?: (() => void) | undefined
  /** Prefilled name for a new passkey (the device or browser). */
  readonly suggestedName?: string | undefined
  readonly supported?: boolean | undefined
  readonly formatDate?: ((date: Date) => string) | undefined
  readonly labels?: Partial<SignInLabels> | undefined
}

const asDate = (value: string | Date) => (value instanceof Date ? value : new Date(value))

interface RowProps {
  readonly passkey: PasskeySummary
  readonly canChange: boolean
  readonly onRemove: (id: string) => Promise<AuthActionResult>
  readonly formatDate: (date: Date) => string
  readonly labels: SignInLabels
}

/** One passkey: its name, when it was added, whether it syncs; Remove asks once more on the row itself. */
function PasskeyRow(props: RowProps) {
  const [confirming, setConfirming] = useState(false)
  const action = useAction(props.labels.failed)
  const { passkey, labels } = props
  const name = passkey.name ?? passkey.id
  return (
    <li data-passkey={passkey.id} className="flex flex-wrap items-center gap-x-3 gap-y-3 p-3">
      <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
        <KeyRoundIcon className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="truncate text-sm font-medium">{name}</p>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>
            {labels.passkeyAdded} {props.formatDate(asDate(passkey.createdAt))}
          </span>
          {passkey.backedUp === true ? <Badge variant="secondary">{labels.passkeySynced}</Badge> : null}
        </p>
      </div>
      {props.canChange && !confirming ? (
        <Button
          type="button"
          variant="ghost"
          size="lg"
          aria-label={`${labels.removePasskey} ${name}`}
          onClick={() => setConfirming(true)}
        >
          <Trash2Icon data-icon="inline-start" />
          {labels.removePasskey}
        </Button>
      ) : null}
      {props.canChange && confirming ? (
        <div role="group" className="flex basis-full flex-wrap items-center justify-end gap-2">
          <p className="mr-auto text-sm text-pretty">{labels.confirmRemovePasskey}</p>
          <Button type="button" variant="ghost" size="lg" disabled={action.busy} onClick={() => setConfirming(false)}>
            {labels.cancel}
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="lg"
            disabled={action.busy}
            aria-busy={action.busy}
            onClick={() => void action.run(() => props.onRemove(passkey.id))}
          >
            <ActionIcon icon={Trash2Icon} busy={action.busy} />
            {labels.removePasskey}
          </Button>
        </div>
      ) : null}
      {action.error === null ? null : <FieldError className="basis-full">{action.error}</FieldError>}
    </li>
  )
}

interface AddFormProps {
  readonly suggestedName: string
  readonly onAdd: (name: string) => Promise<AuthActionResult>
  readonly labels: SignInLabels
}

/** Name the new passkey, then run the device's ceremony. */
function AddPasskeyForm(props: AddFormProps) {
  const id = useId()
  const [name, setName] = useState(props.suggestedName)
  const action = useAction(props.labels.failed)
  return (
    <form
      data-slot="add-passkey"
      onSubmit={(event) => {
        event.preventDefault()
        void action.run(() => props.onAdd(name.trim()))
      }}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={`${id}-name`}>{props.labels.passkeyName}</FieldLabel>
          <Input
            id={`${id}-name`}
            name="passkey_name"
            maxLength={64}
            value={name}
            disabled={action.busy}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        {action.error === null ? null : <FieldError>{action.error}</FieldError>}
        <Button
          type="submit"
          size="lg"
          className="w-full sm:w-auto sm:self-start"
          disabled={action.busy}
          aria-busy={action.busy}
        >
          <ActionIcon icon={PlusIcon} busy={action.busy} />
          {props.labels.addPasskey}
        </Button>
      </FieldGroup>
    </form>
  )
}

function NoPasskeys({ labels }: { readonly labels: SignInLabels }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <KeyRoundIcon />
        </EmptyMedia>
        <EmptyTitle>{labels.noPasskeys}</EmptyTitle>
        <EmptyDescription>{labels.noPasskeysHint}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

/** Why the passkeys cannot change now: no browser support, or a session too old to change them. */
function CannotChange(props: {
  readonly supported: boolean
  readonly labels: SignInLabels
  readonly onReauthenticate: (() => void) | undefined
}) {
  const { labels } = props
  if (!props.supported)
    return (
      <Alert>
        <TriangleAlertIcon />
        <AlertDescription>{labels.passkeyUnsupported}</AlertDescription>
      </Alert>
    )
  return (
    <Alert>
      <ShieldAlertIcon />
      <AlertTitle>{labels.freshSessionRequired}</AlertTitle>
      {props.onReauthenticate === undefined ? null : (
        <AlertDescription>
          <Button type="button" variant="outline" size="lg" className="mt-2" onClick={props.onReauthenticate}>
            <LogInIcon data-icon="inline-start" />
            {labels.reauthenticate}
          </Button>
        </AlertDescription>
      )}
    </Alert>
  )
}

/** The person's passkeys, with add and remove when the session is fresh and the browser supports WebAuthn. */
export function PasskeyManager(props: PasskeyManagerProps) {
  const labels = labelsWith(props.labels)
  const supported = usePasskeySupport(props.supported)
  const formatDate = props.formatDate ?? ((date: Date) => date.toLocaleDateString())
  const canChange = props.freshSession && supported
  return (
    <section aria-label={labels.passkeys} data-slot="passkey-manager" className="flex flex-col gap-6">
      {props.passkeys.length === 0 ? (
        <NoPasskeys labels={labels} />
      ) : (
        <ul className="flex flex-col divide-y rounded-xl border bg-card text-card-foreground">
          {props.passkeys.map((passkey) => (
            <PasskeyRow
              key={passkey.id}
              passkey={passkey}
              canChange={canChange}
              onRemove={props.onRemove}
              formatDate={formatDate}
              labels={labels}
            />
          ))}
        </ul>
      )}
      {canChange ? (
        <AddPasskeyForm suggestedName={props.suggestedName ?? ''} onAdd={props.onAdd} labels={labels} />
      ) : (
        <CannotChange supported={supported} labels={labels} onReauthenticate={props.onReauthenticate} />
      )}
    </section>
  )
}
