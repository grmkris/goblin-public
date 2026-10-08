/** Keep an unchanged failed draft on the same operation; success or changed content starts a new submission. */
export class SubmissionRetry {
  #pending: { signature: string; id: string } | undefined
  constructor(readonly freshId: () => string) {}
  operation(contents: unknown): string {
    const signature = JSON.stringify(contents)
    if (this.#pending?.signature !== signature) this.#pending = { signature, id: this.freshId() }
    return this.#pending.id
  }
  accepted(id: string): void {
    if (this.#pending?.id === id) this.#pending = undefined
  }
}
