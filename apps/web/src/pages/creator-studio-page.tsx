import { useCallback } from 'react';
import { Link, Navigate, useLocation, useParams } from 'react-router-dom';
import { useApi } from '../api/use-api.js';
import { useApiResource } from '../api/use-api-resource.js';
import { useSession } from '../auth/use-session.js';
import { LoadingState } from '../components/page-states.js';
import { CreatorMethods } from '../entries/creator-methods.js';
import { ClaimsInbox } from '../entries/claims-inbox.js';
import { entryError } from '../entries/presentation.js';

export const CreatorStudioPage = () => {
  const { state } = useSession();
  const location = useLocation();
  if (state.status === 'loading') return <LoadingState label="Restoring session" />;
  if (state.status !== 'authenticated')
    return <Navigate to="/auth" replace state={{ from: location.pathname }} />;
  return <StudioContent key={state.user.id} />;
};
const StudioContent = () => {
  const api = useApi();
  const params = useParams<{ creatorId: string; boxId: string }>();
  const location = useLocation();
  const load = useCallback((signal: AbortSignal) => api.listMyWorkspaces(signal), [api]);
  const { state, reload } = useApiResource(load);
  if (state.status === 'loading') return <LoadingState label="Loading your creator workspaces" />;
  if (state.status === 'error')
    return (
      <div className="page">
        <p role="alert">{entryError(state.error)}</p>
        <button className="button secondary" onClick={reload}>
          Try again
        </button>
      </div>
    );
  const membership = state.data.memberships.find((m) => m.creator.id === params.creatorId);
  if (params.creatorId && !membership)
    return (
      <div className="page">
        <h1>Workspace unavailable</h1>
        <p>You do not have access to this creator workspace.</p>
        <Link to="/studio">Your workspaces</Link>
      </div>
    );
  return (
    <div className="page entry-studio">
      {membership ? (
        <>
          <Link className="back-link" to="/studio">
            ← Your workspaces
          </Link>
          <nav className="entry-actions" aria-label="Creator workspace">
            <Link to={`/studio/${membership.creator.id}`}>
              {membership.creator.displayName} · Drops
            </Link>
            {membership.role === 'owner' || membership.role === 'manager' ? (
              <Link to={`/studio/${membership.creator.id}/claims`}>Entry Claims</Link>
            ) : null}
          </nav>
          <Workspace
            key={membership.creator.id}
            creatorId={membership.creator.id}
            role={membership.role}
            boxId={params.boxId}
            inbox={location.pathname.endsWith('/claims')}
          />
        </>
      ) : (
        <>
          <header>
            <p className="eyebrow">Creator workspace</p>
            <h1>Give fans a way in.</h1>
            <p>Configure how fans earn your Drops and review their proof.</p>
          </header>
          <div className="entry-method-grid">
            {state.data.memberships.map((m) => (
              <Link
                key={m.creator.id}
                className="entry-panel studio-link"
                to={`/studio/${m.creator.id}`}
              >
                <h2>{m.creator.displayName}</h2>
                <p>@{m.creator.handle}</p>
                <span>Manage entry methods →</span>
              </Link>
            ))}
          </div>
          {state.data.memberships.length === 0 ? (
            <p>You don’t belong to a creator workspace yet.</p>
          ) : null}
        </>
      )}
    </div>
  );
};
const Workspace = ({
  creatorId,
  role,
  boxId,
  inbox,
}: {
  readonly creatorId: string;
  readonly role: 'owner' | 'manager' | 'editor' | 'viewer';
  readonly boxId: string | undefined;
  readonly inbox: boolean;
}) => {
  const api = useApi();
  const load = useCallback(
    async (signal: AbortSignal) => {
      const response = await api.listWorkspaceBoxes(creatorId, signal);
      return Promise.all(
        response.boxes
          .filter((b) => b.status === 'active' && b.currentPublishedVersionId)
          .map(async (b) => ({
            id: b.id,
            published: await api.getPublishedBoxVersion(
              b.id,
              b.currentPublishedVersionId ?? '',
              signal,
            ),
          })),
      );
    },
    [api, creatorId],
  );
  const { state, reload } = useApiResource(load);
  if (inbox && role !== 'owner' && role !== 'manager')
    return (
      <section className="entry-panel">
        <h1>Review access required</h1>
        <p>Only this creator’s owners and managers can review claims.</p>
      </section>
    );
  if (state.status === 'loading') return <LoadingState label="Loading published Drops" />;
  if (state.status === 'error')
    return (
      <section className="entry-panel">
        <p role="alert">{entryError(state.error)}</p>
        <button className="button secondary" onClick={reload}>
          Try again
        </button>
      </section>
    );
  if (inbox) return <ClaimsInbox creatorId={creatorId} boxes={state.data} />;
  const boxes = state.data.filter(
    (b) => b.published.version.openingCompatibilityVersion === 'opening-v2',
  );
  const selected = boxes.find((b) => b.id === boxId);
  if (boxId)
    return selected ? (
      <CreatorMethods
        key={boxId}
        creatorId={creatorId}
        boxId={boxId}
        box={selected.published}
        role={role}
        onRefresh={reload}
      />
    ) : (
      <section className="entry-panel">
        <h1>Drop unavailable</h1>
        <p>Choose an active published Drop to configure its entry methods.</p>
      </section>
    );
  return (
    <>
      <h1>Your Drops</h1>
      <p>Choose a published Drop to manage its unlock requirements.</p>
      <div className="entry-method-grid">
        {boxes.map((b) => (
          <Link
            key={b.id}
            className="entry-panel studio-link"
            to={`/studio/${creatorId}/boxes/${b.id}/entries`}
          >
            <h2>{b.published.version.name}</h2>
            <p>{b.published.version.maxOpeningsPerUser} openings per fan</p>
            <span>Configure unlock methods →</span>
          </Link>
        ))}
      </div>
      {boxes.length === 0 ? (
        <section className="entry-panel">
          <h2>No published Drops yet</h2>
          <p>This workspace needs a published free-entry Drop before you can add unlock methods.</p>
        </section>
      ) : null}
    </>
  );
};
