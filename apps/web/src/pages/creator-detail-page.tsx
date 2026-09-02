import { useCallback, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import type { PublicBoxSummaryContract } from '@creatordrop/contracts';

import { useApi } from '../api/use-api.js';
import { useApiResource } from '../api/use-api-resource.js';
import { EmptyState, ErrorState, LoadingState } from '../components/page-states.js';
import { formatMinorUnits } from '../formatting/money.js';

export const CreatorDetailPage = () => {
  const customSlug = useParams<{ readonly customSlug: string }>().customSlug ?? '';
  return <CreatorCatalog key={customSlug} customSlug={customSlug} />;
};

const CreatorCatalog = ({ customSlug }: { readonly customSlug: string }) => {
  const api = useApi();
  const load = useCallback(
    async (signal: AbortSignal) => {
      const [creator, boxes] = await Promise.all([
        api.getCreator(customSlug, signal),
        api.listCreatorBoxes(customSlug, undefined, signal),
      ]);
      return { boxes, creator };
    },
    [api, customSlug],
  );
  const { reload, state } = useApiResource(load);
  const [additional, setAdditional] = useState<readonly PublicBoxSummaryContract[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);

  if (state.status === 'loading') return <LoadingState label="Loading creator catalog" />;
  if (state.status === 'error') return <ErrorState error={state.error} onRetry={reload} />;

  const boxes = [...state.data.boxes.boxes, ...additional];
  const cursor = nextCursor === undefined ? state.data.boxes.nextCursor : nextCursor;
  const creator = state.data.creator.creator;
  const loadMore = (): void => {
    if (cursor === null || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreError(null);
    void api
      .listCreatorBoxes(customSlug, cursor)
      .then((response) => {
        setAdditional((current) => [...current, ...response.boxes]);
        setNextCursor(response.nextCursor);
      })
      .catch((error: unknown) => {
        setLoadMoreError(error instanceof Error ? error.message : 'More boxes could not load.');
      })
      .finally(() => setLoadingMore(false));
  };

  return (
    <div className="page">
      <header className="creator-hero">
        <span className="creator-avatar large" aria-hidden="true">
          {creator.displayName.slice(0, 1).toUpperCase()}
        </span>
        <div>
          <p className="eyebrow">@{creator.handle}</p>
          <h1>{creator.displayName}</h1>
          <p>Current active published drops. Drafts and private workspace data are never shown.</p>
        </div>
      </header>
      {boxes.length === 0 ? (
        <EmptyState
          title="No active drops"
          description="This creator has no active published boxes right now."
        />
      ) : (
        <ul className="card-grid box-grid">
          {boxes.map((box) => (
            <li key={box.id}>
              <Link
                className="catalog-card box-card"
                to={`/creators/${creator.customSlug}/boxes/${box.id}`}
              >
                {box.imageUrl === null ? (
                  <div className="image-placeholder" aria-hidden="true" />
                ) : (
                  <img src={box.imageUrl} alt={`${box.name} box`} />
                )}
                <span className="box-card-body">
                  <span className={`status-pill ${box.availability}`}>
                    {box.availability === 'openable' ? 'Published' : 'Legacy · view only'}
                  </span>
                  <strong>{box.name}</strong>
                  <small>{formatMinorUnits(box.priceMinor, box.currency)}</small>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
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
          {loadingMore ? 'Loading…' : 'Load more boxes'}
        </button>
      )}
    </div>
  );
};
