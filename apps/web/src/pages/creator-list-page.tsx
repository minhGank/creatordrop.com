import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';

import type { PublicCreatorSummaryContract } from '@creatordrop/contracts';

import { useApi } from '../api/use-api.js';
import { useApiResource } from '../api/use-api-resource.js';
import { EmptyState, ErrorState, LoadingState } from '../components/page-states.js';

export const CreatorListPage = () => {
  const api = useApi();
  const load = useCallback((signal: AbortSignal) => api.listCreators(undefined, signal), [api]);
  const { reload, state } = useApiResource(load);
  const [additional, setAdditional] = useState<readonly PublicCreatorSummaryContract[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);

  if (state.status === 'loading') return <LoadingState label="Loading creators" />;
  if (state.status === 'error') return <ErrorState error={state.error} onRetry={reload} />;

  const creators = [...state.data.creators, ...additional];
  const cursor = nextCursor === undefined ? state.data.nextCursor : nextCursor;
  if (creators.length === 0) {
    return (
      <div className="page">
        <PageHeading />
        <EmptyState
          title="No public creators yet"
          description="Active creator profiles will appear here as the catalog grows."
        />
      </div>
    );
  }

  const loadMore = (): void => {
    if (cursor === null || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreError(null);
    void api
      .listCreators(cursor)
      .then((response) => {
        setAdditional((current) => [...current, ...response.creators]);
        setNextCursor(response.nextCursor);
      })
      .catch((error: unknown) => {
        setLoadMoreError(error instanceof Error ? error.message : 'More creators could not load.');
      })
      .finally(() => setLoadingMore(false));
  };

  return (
    <div className="page">
      <PageHeading />
      <ul className="card-grid creator-grid">
        {creators.map((creator) => (
          <li key={creator.customSlug}>
            <Link className="catalog-card creator-card" to={`/creators/${creator.customSlug}`}>
              <span className="creator-avatar" aria-hidden="true">
                {creator.displayName.slice(0, 1).toUpperCase()}
              </span>
              <span>
                <strong>{creator.displayName}</strong>
                <small>@{creator.handle}</small>
              </span>
              <span className="card-arrow" aria-hidden="true">
                →
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {loadMoreError === null ? null : (
        <p className="inline-error" role="alert">
          {loadMoreError}
        </p>
      )}
      {cursor === null ? null : (
        <button
          className="button secondary load-more"
          type="button"
          onClick={loadMore}
          disabled={loadingMore}
        >
          {loadingMore ? 'Loading…' : 'Load more creators'}
        </button>
      )}
    </div>
  );
};

const PageHeading = () => (
  <header className="page-heading">
    <p className="eyebrow">Public catalog</p>
    <h1>Creators</h1>
    <p>Explore active creator profiles and their current published drops.</p>
  </header>
);
