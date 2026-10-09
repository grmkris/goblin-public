import * as Schema from 'effect/Schema'

/**
 * One queue per app: its state changes (actions, activations, rollbacks) run one at a time in arrival order, so each
 * reads the revision the previous one wrote. Reads and `prepare` effects do not wait in it.
 */
export class AppQueues {
  readonly #tails = new Map<string, Promise<unknown>>()

  run<T>(app: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(app) ?? Promise.resolve()
    const next = previous.then(work, work)
    const tail = next.catch(() => undefined)
    this.#tails.set(app, tail)
    void tail.then(() => {
      if (this.#tails.get(app) === tail) this.#tails.delete(app)
    })
    return next
  }
}

/** An app's own code failed or broke a rule: the message is for the agent, with the app's stack when it has one. */
export class AppCodeError extends Error {
  override readonly name = 'AppCodeError'
}

/** A failure as one line for the agent: an app error's text, or a tagged goblin error with its fields. */
export function problemText(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null && '_tag' in cause) {
    const fields = Object.entries(cause)
      .filter(([key]) => key !== '_tag' && key !== 'stack' && key !== 'message')
      .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    return [String(cause._tag), ...fields].join(' — ')
  }
  return cause instanceof Error && cause.message !== '' ? cause.message : 'The call failed.'
}

/**
 * A goblin failure handed to code in an isolate: an app's power or a script's file call refused. Workers RPC carries
 * only an error's message across, so the message is the failure as one readable line; the failure stays its cause.
 */
export class IsolateRefusal extends Schema.TaggedError<IsolateRefusal>()('IsolateRefusal', {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

/** `cause` as the refusal the isolate's code reads. */
export const refusalOf = (cause: unknown): IsolateRefusal => new IsolateRefusal({ message: problemText(cause), cause })
