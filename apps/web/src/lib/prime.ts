import type { QueryClient, QueryExecuteOptions, QueryKey } from '@tanstack/react-query'

/**
 * A route loader's priming of an owner read, so the page finds its data in the cache. It runs ahead of the page's own
 * gate, which decides in place whether the visitor signs in first (OwnerGate), so it decides nothing: a refusal neither
 * sends anyone to sign in (`auth: 'optional'`) nor stays in the cache for the gated page to throw, which reads again
 * once it may. The server renders no owner data and has no owner session to send, so it primes nothing.
 */
export async function primeOwnerRead<TQueryFnData, TError, TData, TQueryKey extends QueryKey>(
  queryClient: QueryClient,
  options: QueryExecuteOptions<TQueryFnData, TError, TData, TQueryFnData, TQueryKey>,
): Promise<void> {
  if (typeof window === 'undefined') return
  try {
    await queryClient.query({ ...options, meta: { ...options.meta, auth: 'optional' } })
  } catch {
    // expected: the gated page reads again and shows what it finds; only a read nobody watches yet is dropped
    const query = queryClient.getQueryCache().find({ queryKey: options.queryKey, exact: true })
    if (query?.state.status === 'error' && query.getObserversCount() === 0)
      queryClient.removeQueries({ queryKey: options.queryKey, exact: true })
  }
}
