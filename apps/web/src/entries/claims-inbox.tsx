import { useCallback, useEffect, useRef, useState } from 'react';
import type { EntryClaimContract, PublishedBoxVersionResponse } from '@creatordrop/contracts';
import { useApi } from '../api/use-api.js';
import { useApiResource } from '../api/use-api-resource.js';
import { CreatorDropApiError } from '../api/client.js';
import {
  actionNames,
  drops,
  entryError,
  evidenceFields,
  evidenceLabel,
  platformNames,
  safeExternalUrl,
} from './presentation.js';

const ReviewEvidence = ({
  creatorId,
  evidenceId,
}: {
  readonly creatorId: string;
  readonly evidenceId: string;
}) => {
  const api = useApi();
  const [attempt, setAttempt] = useState(0);
  const [image, setImage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let url: string | null = null;
    void api
      .getReviewEvidence(creatorId, evidenceId, controller.signal)
      .then((blob) => {
        if (!controller.signal.aborted) {
          url = URL.createObjectURL(blob);
          setImage(url);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [api, creatorId, evidenceId, attempt]);
  return (
    <div>
      {image ? (
        <img
          className="evidence-preview review-evidence"
          src={image}
          alt="Fan’s submitted screenshot proof"
        />
      ) : failed ? (
        <div className="inline-error" role="alert">
          <p>The private screenshot could not be loaded.</p>
          <button
            className="button secondary"
            onClick={() => {
              setImage(null);
              setFailed(false);
              setAttempt((a) => a + 1);
            }}
          >
            Retry evidence
          </button>
        </div>
      ) : (
        <p role="status">Loading private screenshot…</p>
      )}
    </div>
  );
};

const ReviewDetail = ({
  creatorId,
  claimId,
  onClose,
  onReviewed,
}: {
  readonly creatorId: string;
  readonly claimId: string;
  readonly onClose: () => void;
  readonly onReviewed: () => void;
}) => {
  const api = useApi();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [confirmed, setConfirmed] = useState<EntryClaimContract | null>(null);
  const result = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    result.current?.focus();
  }, []);
  const load = useCallback(
    async (signal: AbortSignal) => {
      const { claim } = await api.getReviewClaim(creatorId, claimId, signal);
      let own = false;
      try {
        await api.getOwnEntryClaim(claimId, signal);
        own = true;
      } catch (e) {
        if (!(e instanceof CreatorDropApiError && e.status === 404)) throw e;
      }
      return { claim, own };
    },
    [api, creatorId, claimId],
  );
  const { state, reload } = useApiResource(load);
  const decision = async (choice: 'approved' | 'rejected') => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError(null);
    try {
      const response = await api.reviewEntryClaim(creatorId, claimId, choice, note.trim() || null);
      const current = await api.getReviewClaim(creatorId, claimId);
      setConfirmed(current.claim);
      setNotice(
        current.claim.status === 'approved'
          ? `Claim approved · ${drops(response.claim.policy.definition.openingsGranted)} granted`
          : 'Claim rejected',
      );
      onReviewed();
      result.current?.focus();
    } catch (e) {
      try {
        const latest = await api.getReviewClaim(creatorId, claimId);
        if (latest.claim.status !== 'pending') {
          setConfirmed(latest.claim);
          setNotice(
            latest.claim.status === 'approved'
              ? `Claim approved · ${drops(latest.claim.policy.definition.openingsGranted)} granted`
              : 'Claim rejected',
          );
          onReviewed();
          result.current?.focus();
        } else setError(entryError(e));
      } catch {
        setError('The review could not be confirmed. Refresh this claim before retrying.');
      }
    } finally {
      working.current = false;
      setBusy(false);
    }
  };
  const claim = confirmed ?? (state.status === 'success' ? state.data.claim : null);
  return (
    <section className="entry-panel review-detail" aria-labelledby="review-detail-heading">
      <div className="entry-card-heading">
        <h2 id="review-detail-heading" ref={result} tabIndex={-1}>
          Review claim
        </h2>
        <button className="button secondary" disabled={busy} onClick={onClose}>
          Back to inbox
        </button>
      </div>
      {state.status === 'loading' ? (
        <p role="status">Loading claim and review permissions…</p>
      ) : state.status === 'error' ? (
        <div role="alert">
          <p>{entryError(state.error)}</p>
          <button className="button secondary" onClick={reload}>
            Refresh claim
          </button>
        </div>
      ) : null}
      {claim ? (
        <>
          <p className="eyebrow">
            {platformNames[claim.policy.definition.platform]} ·{' '}
            {actionNames[claim.policy.definition.action]}
          </p>
          <h3>{claim.policy.definition.title}</h3>
          <p>{claim.policy.definition.instructions}</p>
          <p>
            {drops(claim.policy.definition.openingsGranted)} on approval · Submitted{' '}
            {new Date(claim.createdAt).toLocaleString(undefined, { timeZone: 'UTC' })} UTC
          </p>
          <dl className="entry-evidence-fields">
            {evidenceFields
              .filter((f) => f !== 'screenshot' && claim.evidence[f])
              .map((field) => (
                <div key={field}>
                  <dt>{evidenceLabel(field, claim.policy.definition.platform)}</dt>
                  <dd>
                    {field === 'profile_url' && safeExternalUrl(claim.evidence[field]) ? (
                      <a
                        href={safeExternalUrl(claim.evidence[field]) ?? undefined}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {claim.evidence[field]}
                      </a>
                    ) : (
                      claim.evidence[field]
                    )}
                  </dd>
                </div>
              ))}
          </dl>
          {claim.evidence.screenshot ? (
            <ReviewEvidence
              key={claim.evidence.screenshot}
              creatorId={creatorId}
              evidenceId={claim.evidence.screenshot}
            />
          ) : (
            <p className="entry-help">No screenshot was submitted for this requirement.</p>
          )}
          {notice ? (
            <p className="inline-notice" role="status">
              {notice}
            </p>
          ) : claim.status !== 'pending' ? (
            <p role="status">
              {claim.status === 'approved'
                ? `Claim approved · ${drops(claim.policy.definition.openingsGranted)} granted`
                : 'Claim rejected'}
            </p>
          ) : null}
          {state.status === 'success' && state.data.own ? (
            <p className="inline-notice">
              This is your claim. Another authorized team member must review it.
            </p>
          ) : null}
          {claim.status === 'pending' && state.status === 'success' && !state.data.own ? (
            <>
              <label className="entry-form">
                Private review note (optional)
                <textarea
                  maxLength={2000}
                  disabled={busy}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </label>
              <p className="entry-help">
                This note stays private to the review record and is not shown to the fan.
              </p>
              <div className="entry-actions">
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => void decision('rejected')}
                >
                  Reject
                </button>
                <button
                  className="button primary"
                  disabled={busy}
                  aria-busy={busy}
                  onClick={() => void decision('approved')}
                >
                  {busy ? 'Saving review…' : 'Approve'}
                </button>
              </div>
            </>
          ) : null}
        </>
      ) : null}
      {error ? (
        <div role="alert" className="inline-error">
          <p>{error}</p>
          <button className="button secondary" disabled={busy} onClick={reload}>
            Refresh claim
          </button>
        </div>
      ) : null}
    </section>
  );
};

export const ClaimsInbox = ({
  creatorId,
  boxes,
}: {
  readonly creatorId: string;
  readonly boxes: readonly { id: string; published: PublishedBoxVersionResponse }[];
}) => {
  const api = useApi();
  const [status, setStatus] = useState<EntryClaimContract['status']>('pending');
  const [cursor, setCursor] = useState<string | undefined>();
  const [selected, setSelected] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const load = useCallback(
    (signal: AbortSignal) => api.listReviewClaims(creatorId, status, cursor, signal),
    [api, creatorId, status, cursor],
  );
  const { state, reload } = useApiResource(load);
  return (
    <div className="entry-stack">
      <header>
        <p className="eyebrow">Manual verification</p>
        <h1 ref={heading} tabIndex={-1}>
          Entry Claims
        </h1>
        <p>Review the fan’s submitted proof against the rule they claimed.</p>
      </header>
      <div className="entry-actions" aria-label="Filter claims">
        {(['pending', 'approved', 'rejected'] as const).map((value) => (
          <button
            key={value}
            className="button secondary"
            aria-pressed={status === value}
            onClick={() => {
              setStatus(value);
              setCursor(undefined);
              setSelected(null);
            }}
          >
            {value === 'pending' ? 'Pending' : value === 'approved' ? 'Approved' : 'Rejected'}
          </button>
        ))}
        <button className="button secondary" onClick={reload}>
          Refresh inbox
        </button>
      </div>
      {selected ? (
        <ReviewDetail
          key={selected}
          creatorId={creatorId}
          claimId={selected}
          onReviewed={reload}
          onClose={() => {
            setSelected(null);
            heading.current?.focus();
          }}
        />
      ) : state.status === 'loading' ? (
        <p role="status">Loading claims…</p>
      ) : state.status === 'error' ? (
        <p role="alert" className="inline-error">
          {entryError(state.error)}
        </p>
      ) : (
        <>
          {state.data.claims.length === 0 ? (
            <section className="entry-panel">
              <h2>No {status} claims</h2>
              <p>
                {status === 'pending'
                  ? 'You’re all caught up. New submissions will appear here.'
                  : 'Reviewed claims will appear here once your team makes a decision.'}
              </p>
            </section>
          ) : (
            state.data.claims.map((claim) => (
              <article className="entry-panel" key={claim.id}>
                <p className="eyebrow">
                  {boxes.find((b) => b.id === claim.boxId)?.published.version.name ??
                    'Creator Drop'}{' '}
                  · {platformNames[claim.policy.definition.platform]}
                </p>
                <h2>{claim.policy.definition.title}</h2>
                <p>
                  {actionNames[claim.policy.definition.action]} ·{' '}
                  {claim.evidence.platform_username ??
                    claim.evidence.order_reference ??
                    'Fan submitted proof'}
                </p>
                <p className="entry-help">
                  {new Date(claim.createdAt).toLocaleString(undefined, { timeZone: 'UTC' })} UTC ·{' '}
                  {claim.evidence.screenshot ? 'Screenshot attached' : 'Text proof'}
                </p>
                <button className="button primary" onClick={() => setSelected(claim.id)}>
                  {status === 'pending' ? 'Review claim' : 'View claim'}
                </button>
              </article>
            ))
          )}
          <div className="entry-actions">
            {cursor ? (
              <button className="button secondary" onClick={() => setCursor(undefined)}>
                First page
              </button>
            ) : null}
            {state.data.nextCursor ? (
              <button
                className="button secondary"
                onClick={() => setCursor(state.data.nextCursor ?? undefined)}
              >
                Next claims
              </button>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
};
