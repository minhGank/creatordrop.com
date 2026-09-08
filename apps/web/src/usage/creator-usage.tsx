import { useCallback, useEffect, useState, type SubmitEvent } from 'react';
import type { CreatorUsageQuery, UsagePeriod } from '@creatordrop/contracts';
import { useApi } from '../api/use-api.js';
import { useApiResource } from '../api/use-api-resource.js';
import { LoadingState } from '../components/page-states.js';
import { entryError } from '../entries/presentation.js';

const periodLabels: Record<UsagePeriod, string> = {
  lifetime: 'All time',
  current_month: 'This month',
  previous_month: 'Previous month',
  last_30_days: 'Last 30 days',
  custom: 'Custom dates',
};
const count = (value: string): string => new Intl.NumberFormat().format(BigInt(value));
const utcDate = (value: string): string =>
  new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(value));

export const CreatorUsage = ({
  creatorId,
  role,
}: {
  readonly creatorId: string;
  readonly role: 'owner' | 'manager' | 'editor' | 'viewer';
}) =>
  role === 'owner' || role === 'manager' ? (
    <UsageContent key={creatorId} creatorId={creatorId} />
  ) : (
    <section className="entry-panel">
      <h1>Usage access required</h1>
      <p>Only this creator’s owners and managers can view hosted usage.</p>
    </section>
  );

const UsageContent = ({ creatorId }: { readonly creatorId: string }) => {
  const api = useApi();
  const [query, setQuery] = useState<CreatorUsageQuery>({ period: 'current_month', limit: '25' });
  const [period, setPeriod] = useState<UsagePeriod>('current_month');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(
    (signal: AbortSignal) => api.getCreatorUsage(creatorId, query, signal),
    [api, creatorId, query],
  );
  const { state, reload } = useApiResource(load);
  useEffect(() => {
    window.addEventListener('focus', reload);
    return () => window.removeEventListener('focus', reload);
  }, [reload]);
  const apply = (event: SubmitEvent): void => {
    event.preventDefault();
    if (period !== 'custom') {
      setQuery({ period, limit: '25' });
      setError('');
      return;
    }
    const first = new Date(`${start}T00:00:00.000Z`);
    const last = new Date(`${end}T00:00:00.000Z`);
    if (!Number.isFinite(first.getTime()) || !Number.isFinite(last.getTime()) || first > last) {
      setError('Choose a start date on or before the end date.');
      return;
    }
    last.setUTCDate(last.getUTCDate() + 1);
    setQuery({ period, limit: '25', start: first.toISOString(), end: last.toISOString() });
    setError('');
  };
  return (
    <section className="creator-usage" aria-labelledby="usage-title">
      <header className="usage-header">
        <div>
          <p className="eyebrow">Usage</p>
          <h1 id="usage-title">Hosted Openings</h1>
          <p>Every completed fan opening across your Drops.</p>
        </div>
        <button className="button secondary" type="button" onClick={reload}>
          Refresh usage
        </button>
      </header>
      <form className="entry-panel usage-filters" onSubmit={apply}>
        <label>
          Period
          <select
            value={period}
            onChange={(event) => {
              setPeriod(event.target.value as UsagePeriod);
              setError('');
            }}
          >
            {Object.entries(periodLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {period === 'custom' ? (
          <>
            <label>
              From (UTC)
              <input
                type="date"
                required
                value={start}
                onChange={(event) => setStart(event.target.value)}
              />
            </label>
            <label>
              Through (UTC)
              <input
                type="date"
                required
                value={end}
                min={start}
                onChange={(event) => setEnd(event.target.value)}
              />
            </label>
          </>
        ) : null}
        <button className="button secondary" type="submit">
          Apply range
        </button>
        {error ? <p role="alert">{error}</p> : null}
      </form>
      {state.status === 'loading' ? (
        <LoadingState label="Loading hosted usage" />
      ) : state.status === 'error' ? (
        <div className="entry-panel" role="alert">
          <p>{entryError(state.error)}</p>
          <button className="button secondary" onClick={reload}>
            Try again
          </button>
        </div>
      ) : (
        <>
          <dl className="usage-metrics">
            {(
              [
                ['Lifetime openings', state.data.usage.totals.lifetime],
                ['This month', state.data.usage.totals.currentMonth],
                ['Previous month', state.data.usage.totals.previousMonth],
                ['Last 30 days', state.data.usage.totals.last30Days],
              ] as const
            ).map(([label, counts]) => (
              <div className="entry-panel" key={label}>
                <dt>{label}</dt>
                <dd>{count(counts.hostedOpenings)}</dd>
              </div>
            ))}
          </dl>
          <section className="entry-panel usage-breakdown" aria-labelledby="usage-range-title">
            <h2 id="usage-range-title">
              {periodLabels[state.data.usage.range.period]} · Hosted Openings
            </h2>
            <p className="usage-range">
              {state.data.usage.range.start === null
                ? 'Beginning of history'
                : utcDate(state.data.usage.range.start)}{' '}
              → {utcDate(state.data.usage.range.end)} UTC (end exclusive)
            </p>
            <dl className="usage-sources">
              <div>
                <dt>Total in range</dt>
                <dd>{count(state.data.usage.totals.selected.hostedOpenings)}</dd>
              </div>
              <div>
                <dt>Creator requirements</dt>
                <dd>{count(state.data.usage.totals.selected.creatorEntitlementOpenings)}</dd>
              </div>
              <div>
                <dt>Universal Entries</dt>
                <dd>{count(state.data.usage.totals.selected.universalEntryOpenings)}</dd>
              </div>
            </dl>
          </section>
          <section className="entry-panel" aria-labelledby="usage-drops-title">
            <h2 id="usage-drops-title">By Drop</h2>
            {state.data.usage.drops.length === 0 ? (
              <p>No hosted openings in this range.</p>
            ) : (
              <div
                className="usage-table-scroll"
                role="region"
                aria-label="Hosted openings by Drop"
                tabIndex={0}
              >
                <table className="usage-table">
                  <thead>
                    <tr>
                      <th scope="col">Drop</th>
                      <th scope="col">Hosted openings</th>
                      <th scope="col">Creator requirements</th>
                      <th scope="col">Universal Entries</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.data.usage.drops.map((drop) => (
                      <tr key={drop.boxId}>
                        <th scope="row">{drop.name}</th>
                        <td>{count(drop.hostedOpenings)}</td>
                        <td>{count(drop.creatorEntitlementOpenings)}</td>
                        <td>{count(drop.universalEntryOpenings)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="entry-actions usage-pagination">
              {query.after ? (
                <button
                  className="button secondary"
                  onClick={() => {
                    setQuery({ ...query, after: undefined });
                  }}
                >
                  First page
                </button>
              ) : null}
              {state.data.usage.nextCursor ? (
                <button
                  className="button secondary"
                  onClick={() =>
                    setQuery({ ...query, after: state.data.usage.nextCursor ?? undefined })
                  }
                >
                  Next Drops
                </button>
              ) : null}
            </div>
          </section>
          <p className="usage-updated">
            Updated {utcDate(state.data.usage.asOf)} UTC. Refresh to include new openings. Month
            boundaries use UTC.
          </p>
        </>
      )}
    </section>
  );
};
