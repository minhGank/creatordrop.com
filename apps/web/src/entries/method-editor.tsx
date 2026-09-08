import { useEffect, useRef, useState } from 'react';
import {
  entryPlatformActions,
  type EntryMethodContract,
  type EntryPlatform,
  type EntryPolicyDefinition,
} from '@creatordrop/contracts';
import {
  actionNames,
  defaults,
  evidenceFields,
  evidenceLabel,
  platformMarks,
  platformNames,
} from './presentation.js';

export const MethodEditor = ({
  current,
  busy,
  blocked = false,
  error,
  onSave,
  onCancel,
}: {
  readonly current?: EntryMethodContract;
  readonly busy: boolean;
  readonly blocked?: boolean;
  readonly error: string | null;
  readonly onSave: (definition: EntryPolicyDefinition) => void;
  readonly onCancel: () => void;
}) => {
  const [platform, setPlatform] = useState<EntryPlatform | undefined>(current?.draft.platform);
  const [definition, setDefinition] = useState<EntryPolicyDefinition | undefined>(current?.draft);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const update = (change: Partial<EntryPolicyDefinition>) =>
    setDefinition((d) => (d ? { ...d, ...change } : d));
  return (
    <section className="entry-panel entry-editor" aria-labelledby="method-editor-heading">
      <p className="eyebrow">
        {current?.published ? 'Replacement draft' : 'Create an unlock method'}
      </p>
      <h2 ref={heading} tabIndex={-1} id="method-editor-heading">
        How can fans unlock this Drop?
      </h2>
      {current?.published ? (
        <p>
          The published rule stays live. Save and publish this replacement when you are ready.
          Existing claims keep their original rules.
        </p>
      ) : null}
      <fieldset disabled={busy || blocked}>
        <legend>1. Choose a platform</legend>
        <div className="platform-grid">
          {(Object.keys(entryPlatformActions) as EntryPlatform[]).map((p) => (
            <button
              type="button"
              key={p}
              className="platform-choice"
              aria-pressed={platform === p}
              onClick={() => {
                setPlatform(p);
                setDefinition(undefined);
              }}
            >
              <span aria-hidden="true" className={`platform-mark platform-${p}`}>
                {platformMarks[p]}
              </span>
              {platformNames[p]}
            </button>
          ))}
        </div>
      </fieldset>
      {platform ? (
        <fieldset disabled={busy || blocked}>
          <legend>2. Choose an action on {platformNames[platform]}</legend>
          <div className="action-grid">
            {entryPlatformActions[platform].map((a) => (
              <button
                key={a}
                type="button"
                className="action-choice"
                aria-pressed={definition?.action === a}
                onClick={() => setDefinition(defaults(platform, a))}
              >
                {actionNames[a]}
              </button>
            ))}
          </div>
        </fieldset>
      ) : null}
      {definition ? (
        <form
          className="entry-form"
          onSubmit={(event) => {
            event.preventDefault();
            onSave({
              ...definition,
              title: definition.title.trim(),
              instructions: definition.instructions.trim(),
              targetReference:
                definition.targetReference?.trim() === ''
                  ? null
                  : (definition.targetReference?.trim() ?? null),
            });
          }}
        >
          <fieldset disabled={busy || blocked}>
            <legend>
              3. Configure {platformNames[definition.platform]} · {actionNames[definition.action]}
            </legend>
            <label>
              Title fans will see
              <input
                required
                maxLength={120}
                value={definition.title}
                onChange={(e) => update({ title: e.target.value })}
              />
            </label>
            <label>
              Instructions
              <textarea
                required
                maxLength={2000}
                rows={3}
                value={definition.instructions}
                onChange={(e) => update({ instructions: e.target.value })}
                placeholder="Explain the action and the proof fans should submit."
              />
            </label>
            <label>
              {definition.platform === 'commerce' || definition.platform === 'custom'
                ? 'Target link or reference (optional)'
                : 'Target post, profile or channel link'}
              <input
                type={
                  definition.platform === 'commerce' || definition.platform === 'custom'
                    ? 'text'
                    : 'url'
                }
                required={definition.platform !== 'commerce' && definition.platform !== 'custom'}
                maxLength={2048}
                placeholder="https://"
                value={definition.targetReference ?? ''}
                onChange={(e) => update({ targetReference: e.target.value })}
              />
            </label>
            <p className="entry-help">
              Social links must use HTTPS on the selected platform. Remove tracking parameters;
              YouTube video links may include their video parameter.
            </p>
            <div className="entry-columns">
              <label>
                Drops granted
                <input
                  required
                  inputMode="numeric"
                  pattern="[1-9][0-9]*"
                  maxLength={19}
                  value={definition.openingsGranted}
                  onChange={(e) => update({ openingsGranted: e.target.value })}
                />
              </label>
              <label>
                Claims allowed per fan
                <input
                  required
                  inputMode="numeric"
                  pattern="[1-9][0-9]*"
                  maxLength={19}
                  value={definition.perUserClaimLimit}
                  onChange={(e) => update({ perUserClaimLimit: e.target.value })}
                />
              </label>
            </div>
          </fieldset>
          <fieldset disabled={busy || blocked}>
            <legend>Proof fans must submit</legend>
            <p className="entry-help">
              Choose at least one required field. Your team reviews every submission.
            </p>
            <div className="entry-columns">
              {evidenceFields.map((field) => (
                <label key={field}>
                  {evidenceLabel(field, definition.platform)}
                  <select
                    value={definition.evidenceRequirements[field]}
                    onChange={(e) => {
                      const value = e.target.value;
                      if (
                        value === 'required' ||
                        value === 'optional' ||
                        value === 'not_applicable'
                      )
                        update({
                          evidenceRequirements: {
                            ...definition.evidenceRequirements,
                            [field]: value,
                          },
                        });
                    }}
                  >
                    <option value="required">Required</option>
                    <option value="optional">Optional</option>
                    <option value="not_applicable">Not requested</option>
                  </select>
                </label>
              ))}
            </div>
          </fieldset>
          {error ? (
            <p role="alert" className="inline-error">
              {error}
            </p>
          ) : null}
          <div className="entry-actions">
            <button
              className="button primary"
              disabled={
                busy ||
                blocked ||
                !Object.values(definition.evidenceRequirements).includes('required')
              }
            >
              {busy ? 'Saving…' : 'Save draft'}
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={busy || blocked}
              onClick={onCancel}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button className="button secondary" onClick={onCancel} disabled={busy || blocked}>
          Cancel
        </button>
      )}
    </section>
  );
};
