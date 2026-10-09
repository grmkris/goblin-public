import { SubmissionRetry } from './submission-retry.ts'

/**
 * A draft thread (Reply on a message, "+" in a channel) on its way to existing (ADR 0034): it is made with its first
 * message on the first send, under the draft's one `operationId` (the runtime gives that message its own operation from
 * it), and every send meanwhile waits for that same make; a make that failed is asked for again, under the same
 * operation, by the next send. A later message keeps its own operation while it is retried unchanged.
 */
export class DraftThread {
  #thread: Promise<string | undefined> | undefined
  readonly #messages: SubmissionRetry
  constructor(
    readonly operationId: string,
    freshId: () => string,
  ) {
    this.#messages = new SubmissionRetry(freshId)
  }

  /** The thread's id: `make` runs once for the draft (with its operation id); undefined when it could not be made. */
  async thread(make: (operationId: string) => Promise<string | undefined>): Promise<string | undefined> {
    const making = (this.#thread ??= make(this.operationId))
    try {
      const thread = await making
      if (thread === undefined && this.#thread === making) this.#thread = undefined
      return thread
    } catch (failure) {
      if (this.#thread === making) this.#thread = undefined
      throw failure
    }
  }

  /** The operation of the message `contents`: the same while it is retried unchanged. */
  message(contents: unknown): string {
    return this.#messages.operation(contents)
  }

  /** The message `operation` was accepted: the next message is a new one. */
  sent(operation: string): void {
    this.#messages.accepted(operation)
  }
}
