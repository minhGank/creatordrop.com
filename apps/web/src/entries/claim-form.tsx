import { useEffect, useRef, useState } from 'react';
import type { EntryEvidence, EntryPolicySnapshot } from '@creatordrop/contracts';
import { useApi } from '../api/use-api.js';
import { CreatorDropApiError } from '../api/client.js';
import {
  drops,
  entryError,
  evidenceFields,
  evidenceLabel,
  platformNames,
  safeExternalUrl,
} from './presentation.js';

export const ClaimForm = ({
  policy,
  onSubmitted,
  onCancel,
}: {
  readonly policy: EntryPolicySnapshot;
  readonly onSubmitted: () => void;
  readonly onCancel: () => void;
}) => {
  const api = useApi();
  const [evidence, setEvidence] = useState<EntryEvidence>({});
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [upload, setUpload] = useState<'empty' | 'uploading' | 'uploaded' | 'failed'>('empty');
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const active = useRef(true);
  const working = useRef(false);
  const uploading = useRef(false);
  const previewUrl = useRef<string | null>(null);
  const registered = useRef<{ file: File; id: string } | null>(null);
  const command = useRef<{ key: string; evidence: EntryEvidence } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    active.current = true;
    heading.current?.focus();
    return () => {
      active.current = false;
      if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    };
  }, []);
  const uploadFile = async (chosen: File) => {
    if (uploading.current) return;
    uploading.current = true;
    setUploadError(null);
    setUpload('uploading');
    try {
      const metadata =
        registered.current?.file === chosen
          ? registered.current
          : {
              file: chosen,
              id: (await api.createEntryEvidence(policy.boxId, policy.id, chosen)).evidence.id,
            };
      registered.current = metadata;
      const result = await api.uploadEntryEvidence(metadata.id, chosen);
      if (!result.evidence.uploaded) throw new Error('Upload incomplete');
      if (active.current) {
        setEvidence((e) => ({ ...e, screenshot: result.evidence.id }));
        setUpload('uploaded');
      }
    } catch (e) {
      if (active.current) {
        setUpload('failed');
        setUploadError(`Upload failed. ${entryError(e)}`);
      }
    } finally {
      uploading.current = false;
    }
  };
  const selectFile = (selected: File | undefined) => {
    if (uploading.current) return;
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    previewUrl.current = null;
    setEvidence((e) => {
      const copy = { ...e };
      delete copy.screenshot;
      return copy;
    });
    setUploadError(null);
    setUpload('empty');
    setFile(null);
    setPreview(null);
    registered.current = null;
    if (!selected) return;
    if (!['image/png', 'image/jpeg'].includes(selected.type)) {
      setUploadError('Choose a PNG or JPEG screenshot.');
      return;
    }
    if (selected.size > 5242880) {
      setUploadError('This screenshot is too large. Choose a file no larger than 5 MiB.');
      return;
    }
    if (selected.size === 0) {
      setUploadError('This file is empty. Choose a PNG or JPEG screenshot.');
      return;
    }
    setFile(selected);
    previewUrl.current = URL.createObjectURL(selected);
    setPreview(previewUrl.current);
    void uploadFile(selected);
  };
  const submit = async () => {
    if (working.current || upload === 'uploading') return;
    working.current = true;
    setBusy(true);
    setError(null);
    const clean: Partial<Record<(typeof evidenceFields)[number], string>> = {};
    for (const field of evidenceFields) {
      const value = evidence[field]?.trim();
      if (value) clean[field] = value;
    }
    command.current ??= { key: crypto.randomUUID(), evidence: clean };
    try {
      await api.submitEntryClaim(
        policy.boxId,
        policy.id,
        command.current.evidence,
        command.current.key,
      );
      if (active.current) onSubmitted();
    } catch (e) {
      if (active.current) {
        setError(entryError(e));
        if (e instanceof CreatorDropApiError && e.status < 500) {
          command.current = null;
          setUncertain(false);
        } else setUncertain(true);
      }
    } finally {
      working.current = false;
      if (active.current) setBusy(false);
    }
  };
  const definition = policy.definition;
  const target = safeExternalUrl(definition.targetReference);
  return (
    <section className="entry-panel claim-form">
      <h3 ref={heading} tabIndex={-1}>
        Submit proof · {definition.title}
      </h3>
      <p>{definition.instructions}</p>
      {target ? (
        <>
          <a className="button secondary" href={target} target="_blank" rel="noopener noreferrer">
            Open {platformNames[definition.platform]} requirement ↗
          </a>
          <p className="entry-help">
            Complete the action on {platformNames[definition.platform]}, then return here and submit
            proof. Opening the link does not verify completion.
          </p>
        </>
      ) : null}
      <form
        className="entry-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <fieldset disabled={busy || uncertain}>
          <legend>Proof for manual review</legend>
          {evidenceFields
            .filter((f) => definition.evidenceRequirements[f] !== 'not_applicable')
            .map((field) =>
              field === 'screenshot' ? (
                <div className="upload-field" key={field}>
                  <label>
                    Screenshot proof
                    {definition.evidenceRequirements.screenshot === 'optional' ? ' (optional)' : ''}
                    <input
                      type="file"
                      accept="image/png,image/jpeg"
                      disabled={upload === 'uploading'}
                      aria-describedby="screenshot-help screenshot-status"
                      aria-invalid={uploadError !== null}
                      onChange={(e) => selectFile(e.target.files?.[0])}
                    />
                  </label>
                  <p id="screenshot-help" className="entry-help">
                    PNG or JPEG · up to 5 MiB · private to you and the creator’s authorized
                    reviewers
                  </p>
                  <p id="screenshot-status" role="status">
                    {upload === 'empty'
                      ? 'No screenshot selected.'
                      : upload === 'uploading'
                        ? 'Uploading screenshot…'
                        : upload === 'uploaded'
                          ? 'Screenshot uploaded.'
                          : 'Screenshot upload failed.'}
                  </p>
                  {preview ? (
                    <img
                      className="evidence-preview"
                      src={preview}
                      alt="Your selected screenshot proof"
                    />
                  ) : null}
                  {uploadError ? (
                    <p role="alert" className="inline-error">
                      {uploadError}
                    </p>
                  ) : null}
                  {file && upload === 'failed' ? (
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => void uploadFile(file)}
                    >
                      Retry upload
                    </button>
                  ) : null}
                </div>
              ) : (
                <label key={field}>
                  {evidenceLabel(field, definition.platform)}
                  {definition.evidenceRequirements[field] === 'optional' ? ' (optional)' : ''}
                  {field === 'note' ? (
                    <textarea
                      rows={3}
                      required={definition.evidenceRequirements[field] === 'required'}
                      maxLength={2000}
                      value={evidence.note ?? ''}
                      onChange={(e) => setEvidence((v) => ({ ...v, note: e.target.value }))}
                    />
                  ) : (
                    <input
                      type={field === 'profile_url' ? 'url' : 'text'}
                      required={definition.evidenceRequirements[field] === 'required'}
                      maxLength={
                        field === 'profile_url' ? 2048 : field === 'order_reference' ? 160 : 120
                      }
                      value={evidence[field] ?? ''}
                      onChange={(e) => setEvidence((v) => ({ ...v, [field]: e.target.value }))}
                      placeholder={
                        field === 'platform_username'
                          ? '@yourusername'
                          : field === 'order_reference'
                            ? 'Your order reference'
                            : 'https://'
                      }
                    />
                  )}
                </label>
              ),
            )}
        </fieldset>
        {error ? (
          <p role="alert" className="inline-error">
            {error}
          </p>
        ) : null}
        {uncertain ? (
          <p className="entry-help">
            Your submission could not be confirmed. Retry this same submission to safely check the
            result.
          </p>
        ) : null}
        <p className="entry-help">
          Approval unlocks {drops(definition.openingsGranted)}. The creator’s team reviews the proof
          before any Drops are granted.
        </p>
        <div className="entry-actions">
          <button
            className="button primary"
            disabled={
              busy ||
              upload === 'uploading' ||
              (definition.evidenceRequirements.screenshot === 'required' && upload !== 'uploaded')
            }
            aria-busy={busy}
          >
            {busy ? 'Submitting…' : uncertain ? 'Retry submission' : 'Submit proof'}
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={busy || uncertain || upload === 'uploading'}
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
};
