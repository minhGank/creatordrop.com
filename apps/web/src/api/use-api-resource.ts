import { useCallback, useEffect, useMemo, useState } from 'react';

export type ResourceState<T> =
  | { readonly status: 'loading' }
  | { readonly error: Error; readonly status: 'error' }
  | { readonly data: T; readonly status: 'success' };

export const useApiResource = <T>(
  loader: (signal: AbortSignal) => Promise<T>,
): { readonly reload: () => void; readonly state: ResourceState<T> } => {
  const [reloadRevision, setReloadRevision] = useState(0);
  const requestKey = useMemo(() => ({ loader, reloadRevision }), [loader, reloadRevision]);
  const [result, setResult] = useState<{
    readonly key: typeof requestKey;
    readonly state: ResourceState<T>;
  }>(() => ({ key: requestKey, state: { status: 'loading' } }));

  useEffect(() => {
    const controller = new AbortController();
    void loader(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) {
          setResult({ key: requestKey, state: { data, status: 'success' } });
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setResult({
          key: requestKey,
          state: {
            error: error instanceof Error ? error : new Error('The request failed.'),
            status: 'error',
          },
        });
      });
    return () => controller.abort();
  }, [loader, requestKey]);

  const reload = useCallback(() => setReloadRevision((current) => current + 1), []);
  return { reload, state: result.key === requestKey ? result.state : { status: 'loading' } };
};
