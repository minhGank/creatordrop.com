import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import type { EntryMethodState, EntryPolicySnapshot } from '@creatordrop/contracts';
import { useApi } from '../api/use-api.js';
import { useApiResource } from '../api/use-api-resource.js';
import { ClaimForm } from './claim-form.js';
import { actionNames, drops, entryError, platformMarks, platformNames } from './presentation.js';

export const FanEntryMethods = ({
  boxId,
  authenticated,
  onApproved,
}: {
  readonly boxId: string;
  readonly authenticated: boolean;
  readonly onApproved: () => void;
}) => {
  const api = useApi();
  const location = useLocation();
  const [selected, setSelected] = useState<EntryPolicySnapshot | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const approved = useRef<string | null>(null);
  const load = useCallback(
    async (
      signal: AbortSignal,
    ): Promise<{
      methods: readonly EntryPolicySnapshot[];
      states: readonly EntryMethodState[];
    }> => {
      if (authenticated) {
        const response = await api.getEntryState(boxId, signal);
        return { methods: response.methods.map((m) => m.policy), states: response.methods };
      }
      return { ...(await api.listEntryMethods(boxId, signal)), states: [] };
    },
    [api, boxId, authenticated],
  );
  const { state, reload } = useApiResource(load);
  const approvalKey =
    state.status === 'success'
      ? state.data.states.map((s) => `${s.policy.methodId}:${s.consumedSlots}`).join('|')
      : null;
  useEffect(() => {
    if (approvalKey !== null && approved.current !== approvalKey) {
      const previous = approved.current;
      approved.current = approvalKey;
      if (previous !== null) onApproved();
    }
  }, [approvalKey, onApproved]);
  const hasPending =
    state.status === 'success' && state.data.states.some((s) => s.reservedSlots !== '0');
  useEffect(() => {
    if (!hasPending || selected) return;
    const refresh = () => {
      if (document.visibilityState !== 'hidden') reload();
    };
    const timer = window.setInterval(refresh, 30000);
    window.addEventListener('focus', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [hasPending, selected, reload]);
  const finish = () => {
    setSelected(null);
    reload();
    heading.current?.focus();
  };
  return (
    <section className="entry-section" aria-labelledby="unlock-heading">
      <div className="entry-card-heading">
        <div>
          <p className="eyebrow">Earn your next reveal</p>
          <h2 id="unlock-heading" ref={heading} tabIndex={-1}>
            Unlock this Drop
          </h2>
        </div>
        {authenticated ? (
          <button className="button secondary" disabled={selected !== null} onClick={reload}>
            Refresh claim status
          </button>
        ) : null}
      </div>
      <p>Complete a requirement and submit proof. The creator’s team reviews every claim.</p>
      {state.status === 'loading' ? (
        <p role="status">Loading ways to unlock…</p>
      ) : state.status === 'error' ? (
        <div className="inline-error" role="alert">
          <p>{entryError(state.error)}</p>
          <button className="button secondary" onClick={reload}>
            Try again
          </button>
        </div>
      ) : state.data.methods.length === 0 ? (
        <div className="entry-panel">
          <h3>No unlock methods yet</h3>
          <p>The creator has not published any requirements for this Drop. Check back soon.</p>
        </div>
      ) : (
        <div className="entry-method-grid">
          {state.data.methods.map((policy) => {
            const own = state.data.states.find((s) => s.policy.methodId === policy.methodId);
            const latest = own?.claims[0];
            const d = policy.definition;
            return (
              <article className="entry-panel" key={policy.methodId}>
                <div className="entry-card-heading">
                  <span className={`platform-mark platform-${d.platform}`} aria-hidden="true">
                    {platformMarks[d.platform]}
                  </span>
                  <p className="eyebrow">
                    {platformNames[d.platform]} · {actionNames[d.action]}
                  </p>
                </div>
                <h3>{d.title}</h3>
                <p className="entry-earn">
                  Earn <strong>{drops(d.openingsGranted)}</strong>
                </p>
                <p>{d.instructions}</p>
                {own && own.reservedSlots !== '0' ? (
                  <p role="status" className="inline-notice">
                    <strong>Awaiting review</strong>
                    <br />
                    Your proof was submitted. The creator’s team will review it.
                    {own.reservedSlots !== '1' ? ` ${own.reservedSlots} claims pending.` : ''}
                  </p>
                ) : null}
                {latest?.status === 'approved' ? (
                  <div className="inline-notice" role="status">
                    <strong>Approved ✓</strong>
                    <p>You unlocked {drops(latest.openingsGranted)}.</p>
                    <a href="#open-drop" onClick={() => onApproved()}>
                      Open Drop
                    </a>
                  </div>
                ) : null}
                {latest?.status === 'rejected' ? (
                  <p role="status" className="entry-help">
                    <strong>Proof couldn’t be verified</strong>
                    <br />
                    {own?.canSubmit
                      ? 'You can submit corrected proof for a new review.'
                      : 'You have no claim slots remaining.'}
                  </p>
                ) : null}
                {own && !own.canSubmit && own.reservedSlots === '0' ? (
                  <p className="entry-help">Claim limit reached for this requirement.</p>
                ) : null}
                {own && BigInt(own.claimCount) > 1n ? (
                  <details>
                    <summary>Your claim history ({own.claimCount})</summary>
                    <ul className="claim-history">
                      {own.claims.map((c) => (
                        <li key={c.id}>
                          {c.status === 'pending'
                            ? 'Awaiting review'
                            : c.status === 'approved'
                              ? `Approved · ${drops(c.openingsGranted)} unlocked`
                              : 'Proof couldn’t be verified'}{' '}
                          ·{' '}
                          {new Date(c.createdAt).toLocaleDateString(undefined, { timeZone: 'UTC' })}
                        </li>
                      ))}
                    </ul>
                    {BigInt(own.claimCount) > 100n ? (
                      <p>Showing your 100 most recent submissions.</p>
                    ) : null}
                  </details>
                ) : null}
                {!authenticated ? (
                  <Link className="button primary" to="/auth" state={{ from: location.pathname }}>
                    Sign in to submit proof
                  </Link>
                ) : own?.canSubmit ? (
                  <button
                    className="button primary"
                    disabled={selected !== null}
                    onClick={() => setSelected(policy)}
                  >
                    {latest?.status === 'rejected'
                      ? 'Submit corrected proof'
                      : own.reservedSlots !== '0'
                        ? 'Submit another claim'
                        : 'Complete requirement'}
                  </button>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
      {selected ? (
        <ClaimForm
          key={selected.id}
          policy={selected}
          onSubmitted={finish}
          onCancel={() => {
            setSelected(null);
            heading.current?.focus();
          }}
        />
      ) : null}
    </section>
  );
};
