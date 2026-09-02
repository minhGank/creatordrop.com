import { useCallback } from 'react';
import { Link, useParams } from 'react-router-dom';

import { useApi } from '../api/use-api.js';
import { useApiResource } from '../api/use-api-resource.js';
import { ErrorState, LoadingState } from '../components/page-states.js';
import { formatMinorUnits } from '../formatting/money.js';
import { formatProbability } from '../formatting/probability.js';

export const BoxDetailPage = () => {
  const parameters = useParams<{ readonly boxId: string; readonly customSlug: string }>();
  const boxId = parameters.boxId ?? '';
  const customSlug = parameters.customSlug ?? '';
  const api = useApi();
  const load = useCallback(
    (signal: AbortSignal) => api.getCreatorBox(customSlug, boxId, signal),
    [api, boxId, customSlug],
  );
  const { reload, state } = useApiResource(load);

  if (state.status === 'loading') return <LoadingState label="Loading published box" />;
  if (state.status === 'error') return <ErrorState error={state.error} onRetry={reload} />;

  const { box, creator } = state.data;
  const openable = box.version.openingCompatibilityVersion === 'opening-v1';
  return (
    <article className="page box-detail">
      <Link className="back-link" to={`/creators/${creator.customSlug}`}>
        ← Back to {creator.displayName}
      </Link>
      <header className="box-detail-hero">
        <div>
          <p className="eyebrow">Published version {box.version.versionNumber.toString()}</p>
          <h1>{box.version.name}</h1>
          <p className="box-description">{box.version.description}</p>
          <p className="price">{formatMinorUnits(box.version.priceMinor, box.version.currency)}</p>
          <span className={`status-pill ${openable ? 'openable' : 'legacy'}`}>
            {openable ? 'Opening-compatible' : 'Legacy version · cannot be opened'}
          </span>
        </div>
        {box.version.imageUrl === null ? (
          <div className="detail-image image-placeholder" aria-hidden="true" />
        ) : (
          <img
            className="detail-image"
            src={box.version.imageUrl}
            alt={`${box.version.name} box`}
          />
        )}
      </header>

      <section aria-labelledby="rewards-heading" className="rewards-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Immutable configuration</p>
            <h2 id="rewards-heading">Rewards and exact odds</h2>
          </div>
          <p>{box.manifest.totalWeight} total weight</p>
        </div>
        <ol className="reward-list">
          {box.entries.map((entry) => (
            <li key={entry.id}>
              {entry.rewardVersion.imageUrl === null ? (
                <div className="reward-image image-placeholder" aria-hidden="true" />
              ) : (
                <img
                  className="reward-image"
                  src={entry.rewardVersion.imageUrl}
                  alt={`${entry.rewardVersion.name} reward`}
                />
              )}
              <div className="reward-copy">
                <div>
                  <h3>{entry.rewardVersion.name}</h3>
                  {entry.isBaseReward ? <span className="base-label">Base reward</span> : null}
                </div>
                <p>{entry.rewardVersion.description}</p>
              </div>
              <div className="odds" aria-label={`${entry.weight} of ${box.manifest.totalWeight}`}>
                <strong>{formatProbability(entry.weight, box.manifest.totalWeight)}</strong>
                <small>
                  {entry.weight} / {box.manifest.totalWeight}
                </small>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="fairness-card" aria-labelledby="fairness-heading">
        <p className="eyebrow">Fairness snapshot</p>
        <h2 id="fairness-heading">Verifiable published inputs</h2>
        <dl>
          <div>
            <dt>Algorithm</dt>
            <dd>{box.manifest.algorithmVersion}</dd>
          </div>
          <div>
            <dt>Configuration hash</dt>
            <dd className="hash-value">{box.configurationHash}</dd>
          </div>
        </dl>
        <p>
          The catalog shows published inputs only. Server seeds and encryption material are never
          public catalog fields.
        </p>
      </section>
    </article>
  );
};
