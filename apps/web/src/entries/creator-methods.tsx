import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  EntryMethodContract,
  EntryPolicyDefinition,
  PublishedBoxVersionResponse,
  CreatorRole,
} from '@creatordrop/contracts';
import { useApi } from '../api/use-api.js';
import { CreatorDropApiError } from '../api/client.js';
import { useApiResource } from '../api/use-api-resource.js';
import { LoadingState } from '../components/page-states.js';
import { formatProbability } from '../formatting/probability.js';
import { MethodEditor } from './method-editor.js';
import { actionNames, drops, entryError, platformNames, proofSummary } from './presentation.js';

export const CreatorMethods = ({
  creatorId,
  boxId,
  box,
  role,
  onRefresh,
}: {
  readonly creatorId: string;
  readonly boxId: string;
  readonly box: PublishedBoxVersionResponse;
  readonly role: CreatorRole;
  readonly onRefresh: () => void;
}) => {
  const api = useApi();
  const loader = useCallback(
    (signal: AbortSignal) => api.listDraftEntryMethods(creatorId, boxId, signal),
    [api, creatorId, boxId],
  );
  const { state, reload } = useApiResource(loader);
  const [editing, setEditing] = useState<EntryMethodContract | 'new' | null>(null);
  const [publication, setPublication] = useState<EntryMethodContract | null>(null);
  const [busy, setBusy] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const working = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const publicationPanel = useRef<HTMLElement>(null);
  useEffect(() => {
    publicationPanel.current?.focus();
  }, [publication]);
  const canEdit = role !== 'viewer';
  const canPublish = role === 'owner' || role === 'manager';
  const run = async (operation: () => Promise<unknown>, message: string) => {
    if (working.current || needsRefresh) return;
    working.current = true;
    setBusy(true);
    setError(null);
    try {
      await operation();
      setEditing(null);
      setPublication(null);
      setNotice(message);
      reload();
      heading.current?.focus();
    } catch (e) {
      setNeedsRefresh(!(e instanceof CreatorDropApiError && e.status === 400));
      setError(`${entryError(e)} Refresh the methods before retrying an unconfirmed change.`);
    } finally {
      working.current = false;
      setBusy(false);
    }
  };
  const save = (definition: EntryPolicyDefinition) =>
    void run(
      () =>
        api.saveEntryMethod(
          creatorId,
          boxId,
          definition,
          editing && editing !== 'new' ? editing : undefined,
        ),
      'Draft saved. Review it before publishing.',
    );
  return (
    <div className="entry-stack">
      <header>
        <p className="eyebrow">Unlock methods</p>
        <h1 tabIndex={-1} ref={heading}>
          {box.version.name}
        </h1>
        <p>
          Give fans a clear way to earn this Drop. Every proof submission is reviewed by your team.
        </p>
      </header>
      <section className="entry-panel">
        <h2>Drop overview</h2>
        <p>{box.version.maxOpeningsPerUser} openings per fan</p>
        <ul className="entry-reward-summary">
          {box.entries.map((e) => (
            <li key={e.id}>
              <span>{e.rewardVersion.name}</span>
              <strong>{formatProbability(e.weight, box.manifest.totalWeight)}</strong>
            </li>
          ))}
        </ul>
      </section>
      {notice ? (
        <p role="status" className="inline-notice">
          {notice}
        </p>
      ) : null}
      {error && editing === null ? (
        <p role="alert" className="inline-error">
          {error}
        </p>
      ) : null}
      <div className="entry-actions">
        <h2>Ways to unlock</h2>
        <button
          className="button secondary"
          disabled={busy}
          onClick={() => {
            setEditing(null);
            setPublication(null);
            setError(null);
            setNeedsRefresh(false);
            reload();
            onRefresh();
          }}
        >
          Refresh methods
        </button>
        {canEdit ? (
          <button
            className="button primary"
            disabled={busy || needsRefresh}
            onClick={() => {
              setEditing('new');
              setPublication(null);
              setError(null);
            }}
          >
            Add a method
          </button>
        ) : null}
      </div>
      {state.status === 'loading' ? (
        <LoadingState label="Loading entry methods" />
      ) : state.status === 'error' ? (
        <p className="inline-error" role="alert">
          {entryError(state.error)}
        </p>
      ) : (
        <>
          {state.data.methods.length === 0 ? (
            <div className="entry-panel">
              <h3>No unlock methods yet</h3>
              <p>Add a platform and action to give fans a way to earn this Drop.</p>
            </div>
          ) : null}
          {state.data.methods.map((method) => (
            <article className="entry-panel" key={method.id}>
              <div className="entry-card-heading">
                <h3>
                  {platformNames[(method.published?.definition ?? method.draft).platform]} ·{' '}
                  {actionNames[(method.published?.definition ?? method.draft).action]}
                </h3>
                <span className="status-pill">
                  {!method.enabled ? 'Disabled' : method.published ? 'Published' : 'Draft'}
                </span>
              </div>
              {method.published ? (
                <>
                  <h4>{method.published.definition.title}</h4>
                  <p>
                    {drops(method.published.definition.openingsGranted)} ·{' '}
                    {method.published.definition.perUserClaimLimit}{' '}
                    {method.published.definition.perUserClaimLimit === '1' ? 'claim' : 'claims'} per
                    fan
                  </p>
                  <p>{proofSummary(method.published.definition)} required</p>
                  <p className="entry-help">
                    Published rules are fixed. Changes need a replacement publication.
                  </p>
                </>
              ) : (
                <>
                  <p>{method.draft.title}</p>
                  <p>
                    {drops(method.draft.openingsGranted)} · {method.draft.perUserClaimLimit} claims
                    per fan
                  </p>
                  <p>{proofSummary(method.draft)} required</p>
                </>
              )}
              {method.published &&
              JSON.stringify(method.published.definition) !== JSON.stringify(method.draft) ? (
                <p className="inline-notice">A replacement draft is ready to review.</p>
              ) : null}
              <div className="entry-actions">
                {canEdit ? (
                  <button
                    className="button secondary"
                    disabled={busy || needsRefresh}
                    onClick={() => {
                      setEditing(method);
                      setPublication(null);
                      setError(null);
                    }}
                  >
                    {method.published ? 'Edit replacement draft' : 'Edit draft'}
                  </button>
                ) : null}
                {canPublish ? (
                  <>
                    <button
                      className="button primary"
                      disabled={busy || needsRefresh}
                      onClick={() => {
                        setPublication(method);
                        setEditing(null);
                        setError(null);
                      }}
                    >
                      Review &amp; publish
                    </button>
                    <button
                      className="button secondary"
                      disabled={busy || needsRefresh}
                      onClick={() =>
                        void run(
                          () =>
                            api.setEntryMethodEnabled(creatorId, boxId, method, !method.enabled),
                          method.enabled ? 'Method disabled for new claims.' : 'Method enabled.',
                        )
                      }
                    >
                      {method.enabled ? 'Disable' : 'Enable'}
                    </button>
                  </>
                ) : null}
              </div>
            </article>
          ))}
        </>
      )}
      {editing !== null ? (
        <MethodEditor
          key={editing === 'new' ? 'new' : editing.id}
          {...(editing === 'new' ? {} : { current: editing })}
          busy={busy}
          blocked={needsRefresh}
          error={error}
          onSave={save}
          onCancel={() => setEditing(null)}
        />
      ) : null}
      {publication ? (
        <section
          className="entry-panel publication-review"
          ref={publicationPanel}
          tabIndex={-1}
          aria-labelledby="publish-heading"
        >
          <p className="eyebrow">Before you publish</p>
          <h2 id="publish-heading">Fans will unlock {drops(publication.draft.openingsGranted)}</h2>
          <h3>{publication.draft.title}</h3>
          <p>{publication.draft.instructions}</p>
          <p>
            {platformNames[publication.draft.platform]} · {actionNames[publication.draft.action]}
          </p>
          <p>
            {publication.draft.perUserClaimLimit} claims per fan · {proofSummary(publication.draft)}{' '}
            required
          </p>
          <p>
            Reward odds and the {box.version.maxOpeningsPerUser}-opening limit shown above stay the
            same. Existing claims keep their original rules.
          </p>
          {!publication.enabled ? (
            <p>This method is disabled. Enable it after publication to accept new claims.</p>
          ) : null}
          <div className="entry-actions">
            <button
              className="button primary"
              disabled={busy || needsRefresh}
              onClick={() =>
                void run(
                  () => api.publishEntryMethod(creatorId, boxId, publication, box.version.id),
                  'Entry rule published.',
                )
              }
            >
              {busy ? 'Publishing…' : 'Publish entry rule'}
            </button>
            <button
              className="button secondary"
              disabled={busy || needsRefresh}
              onClick={() => setPublication(null)}
            >
              Back
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
};
