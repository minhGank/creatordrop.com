import { useCallback, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import type { PublicCreatorBoxResponse } from '@creatordrop/contracts';

import type { CreatorDropApiClient } from '../api/client.js';
import { useApi } from '../api/use-api.js';
import { useApiResource } from '../api/use-api-resource.js';
import type { SessionState } from '../auth/session-context-value.js';
import { useSession } from '../auth/use-session.js';
import { isOpeningV2Catalog } from '../components/opening-catalog.js';
import { OpeningExperience } from '../components/opening-experience.js';
import { ErrorState, LoadingState } from '../components/page-states.js';
import { formatProbability } from '../formatting/probability.js';
import { FanEntryMethods } from '../entries/fan-entry-methods.js';

export const BoxDetailPage = () => {
  const parameters = useParams<{ readonly boxId: string; readonly customSlug: string }>();
  const boxId = parameters.boxId ?? '';
  const customSlug = parameters.customSlug ?? '';
  const api = useApi();
  const session = useSession();
  const load = useCallback(
    (signal: AbortSignal) => api.getCreatorBox(customSlug, boxId, signal),
    [api, boxId, customSlug],
  );
  const { reload, state } = useApiResource(load);

  if (state.status === 'loading') return <LoadingState label="Loading published box" />;
  if (state.status === 'error') return <ErrorState error={state.error} onRetry={reload} />;

  return (
    <BoxDetailContent
      api={api}
      initial={state.data}
      key={`${state.data.creator.customSlug}:${state.data.box.version.id}`}
      session={session.state}
    />
  );
};

const BoxDetailContent = ({
  api,
  initial,
  session,
}: {
  readonly api: CreatorDropApiClient;
  readonly initial: PublicCreatorBoxResponse;
  readonly session: SessionState;
}) => {
  const [box, setBox] = useState(initial.box);
  const [entryRevision, setEntryRevision] = useState(0);
  const onApproved = useCallback(() => setEntryRevision((v) => v + 1), []);
  const creator = initial.creator;
  const openingV2 = isOpeningV2Catalog(box);
  return (
    <article className="page box-detail">
      <Link className="back-link" to={`/creators/${creator.customSlug}`}>
        ← Back to {creator.displayName}
      </Link>
      <header className="box-detail-hero">
        <div>
          <p className="eyebrow">{openingV2 ? 'Creator Drop' : 'Historical Drop'}</p>
          <h1>{box.version.name}</h1>
          <p className="box-description">{box.version.description}</p>
          <span className={`status-pill ${openingV2 ? 'openable' : 'legacy'}`}>
            {openingV2 ? 'Available by earned entry' : 'Legacy version · view only'}
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
            <p className="eyebrow">Possible rewards</p>
            <h2 id="rewards-heading">Rewards and odds</h2>
          </div>
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
                  <h3>
                    {entry.rewardVersion.xpReward === undefined
                      ? entry.rewardVersion.name
                      : `+${entry.rewardVersion.xpReward.amount} XP`}
                  </h3>
                  {!openingV2 && entry.isBaseReward ? (
                    <span className="base-label">Base reward</span>
                  ) : null}
                  <span className={`rarity-label rarity-${entry.rarity ?? 'unspecified'}`}>
                    {entry.rarity === null
                      ? 'Unspecified'
                      : `${entry.rarity[0]?.toUpperCase() ?? ''}${entry.rarity.slice(1)}`}
                  </span>
                </div>
                <p>{entry.rewardVersion.description}</p>
              </div>
              <div
                className="odds"
                aria-label={`${formatProbability(entry.weight, box.manifest.totalWeight)} chance`}
              >
                <strong>{formatProbability(entry.weight, box.manifest.totalWeight)}</strong>
                {openingV2 ? null : (
                  <small>
                    {entry.weight} / {box.manifest.totalWeight}
                  </small>
                )}
              </div>
            </li>
          ))}
        </ol>
      </section>

      {openingV2 ? (
        <FanEntryMethods
          key={session.status === 'authenticated' ? session.user.id : 'anonymous'}
          boxId={box.manifest.boxId}
          authenticated={session.status === 'authenticated'}
          onApproved={onApproved}
        />
      ) : null}

      {openingV2 ? (
        <OpeningExperience
          key={`opening:${session.status === 'authenticated' ? session.user.id : session.status}`}
          api={api}
          box={box}
          customSlug={creator.customSlug}
          onCatalogChange={setBox}
          session={session}
          entryRevision={entryRevision}
        />
      ) : (
        <section className="opening-callout">
          <p>This historical paid-opening version is preserved for past records and proofs.</p>
        </section>
      )}

      {openingV2 ? (
        <details className="fairness-card">
          <summary>Provably Fair</summary>
          <p>You can verify the recorded result after opening a Drop.</p>
        </details>
      ) : (
        <section className="fairness-card" aria-labelledby="fairness-heading">
          <p className="eyebrow">Historical fairness snapshot</p>
          <h2 id="fairness-heading">Verification data</h2>
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
        </section>
      )}
    </article>
  );
};
