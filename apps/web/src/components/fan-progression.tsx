import { useCallback, useEffect } from 'react';
import type { Progression } from '@creatordrop/contracts';

import { useApi } from '../api/use-api.js';
import { useApiResource } from '../api/use-api-resource.js';
import { ErrorState, LoadingState } from './page-states.js';

export const ProgressionDisplay = ({ progression }: { readonly progression: Progression }) => {
  const percent = Number(
    (BigInt(progression.xpInLevel) * 100n) / BigInt(progression.xpForNextLevel),
  );
  return (
    <section className="progression-card" aria-label="Your progression">
      <div className="progression-heading">
        <div>
          <p className="eyebrow">Your progression</p>
          <h2>Level {progression.level}</h2>
        </div>
        <div className="universal-entry-count">
          <strong>{progression.universalEntriesAvailable}</strong>
          <span>Universal Entries available</span>
        </div>
      </div>
      <p>
        {progression.xpInLevel} of {progression.xpForNextLevel} XP toward your next level
      </p>
      <progress
        value={percent}
        max={100}
        aria-label="XP toward next level"
        aria-valuetext={`${progression.xpInLevel} of ${progression.xpForNextLevel} XP`}
      />
      <p className="muted">
        {progression.lifetimeXp} lifetime XP · Each level earns one Universal Entry.
      </p>
      <p className="muted">
        Use entries on eligible Drops across CreatorDrop. Each Drop’s opening limit still applies.
      </p>
    </section>
  );
};

export const FanProgression = () => {
  const api = useApi();
  const { state, reload } = useApiResource(
    useCallback((signal: AbortSignal) => api.getProgression(signal), [api]),
  );
  useEffect(() => {
    window.addEventListener('focus', reload);
    return () => window.removeEventListener('focus', reload);
  }, [reload]);
  if (state.status === 'loading') return <LoadingState label="Loading your progression" />;
  if (state.status === 'error') return <ErrorState error={state.error} onRetry={reload} />;
  return <ProgressionDisplay progression={state.data.progression} />;
};
