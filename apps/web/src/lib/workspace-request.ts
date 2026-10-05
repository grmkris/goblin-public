let context: string | null = null
export const setWorkspaceContext = (value: string | null): void => {
  context = value
}
export const workspaceHeaders = (): Record<string, string> =>
  context === null ? {} : { 'x-purrable-workspace': context }
