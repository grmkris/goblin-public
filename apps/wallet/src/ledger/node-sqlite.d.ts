/** The slice of Node's `node:sqlite` the ledger tests use, so the Worker's types stay free of Node's globals. */
declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(path: string)
    prepare(query: string): {
      all(...params: unknown[]): unknown[]
      run(...params: unknown[]): unknown
    }
  }
}
