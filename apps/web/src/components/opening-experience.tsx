import { motion } from 'framer-motion';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import type {
  BoxOpeningResponse,
  CurrentFairnessResponse,
  OpeningV2EntitlementStateContract,
  OpeningFairnessProofResponse,
  PublishedBoxVersionResponse,
  RewardRarity,
} from '@creatordrop/contracts';
import { verifyPersistedRewardSelectionProof } from '@creatordrop/rng-verifier/browser';

import {
  CreatorDropApiError,
  CreatorDropNetworkError,
  CreatorDropProtocolError,
  type CreatorDropApiClient,
} from '../api/client.js';
import { usePrefersReducedMotion } from '../accessibility/use-prefers-reduced-motion.js';
import type { SessionState } from '../auth/session-context-value.js';
import { formatMinorUnits } from '../formatting/money.js';
import { formatProbability } from '../formatting/probability.js';
import { isOpeningV1Catalog, isOpeningV2Catalog, type OpeningCatalog } from './opening-catalog.js';
import { calculateReelWinnerTranslation } from './reel-geometry.js';

type Opening = BoxOpeningResponse['opening'];
type Stage =
  | 'confirm'
  | 'idle'
  | 'preparing-confirmation'
  | 'reel'
  | 'resolving-result'
  | 'result'
  | 'result-error'
  | 'submitting';

type PendingRecovery = 'automatic' | 'manual';

interface PendingOpening {
  readonly clientSeed: string;
  readonly expectedBoxVersionId: string;
  readonly expectedConfigurationHash: string;
  readonly expectedSeedSetId: string;
  readonly expectedServerSeedCommitment: string;
  readonly idempotencyKey: string;
  readonly recovery: PendingRecovery;
  readonly userId: string;
}

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const storageKey = (boxId: string): string => `creatordrop:opening:v1:${boxId}`;

const readPending = (boxId: string, userId: string): PendingOpening | undefined => {
  try {
    const raw = window.sessionStorage.getItem(storageKey(boxId));
    if (raw === null) return undefined;
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const candidate = value as Record<string, unknown>;
    if (
      Object.keys(candidate).length !== 8 ||
      typeof candidate.clientSeed !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(candidate.clientSeed) ||
      typeof candidate.expectedBoxVersionId !== 'string' ||
      !canonicalUuidPattern.test(candidate.expectedBoxVersionId) ||
      typeof candidate.expectedConfigurationHash !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(candidate.expectedConfigurationHash) ||
      typeof candidate.expectedSeedSetId !== 'string' ||
      !canonicalUuidPattern.test(candidate.expectedSeedSetId) ||
      typeof candidate.expectedServerSeedCommitment !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(candidate.expectedServerSeedCommitment) ||
      typeof candidate.idempotencyKey !== 'string' ||
      !/^opening_[0-9a-f-]{36}$/u.test(candidate.idempotencyKey) ||
      (candidate.recovery !== 'automatic' && candidate.recovery !== 'manual') ||
      candidate.userId !== userId
    ) {
      return undefined;
    }
    return {
      clientSeed: candidate.clientSeed,
      expectedBoxVersionId: candidate.expectedBoxVersionId,
      expectedConfigurationHash: candidate.expectedConfigurationHash,
      expectedSeedSetId: candidate.expectedSeedSetId,
      expectedServerSeedCommitment: candidate.expectedServerSeedCommitment,
      idempotencyKey: candidate.idempotencyKey,
      recovery: candidate.recovery,
      userId,
    };
  } catch {
    return undefined;
  }
};

const writePending = (boxId: string, pending: PendingOpening): void => {
  window.sessionStorage.setItem(storageKey(boxId), JSON.stringify(pending));
};

const clearPending = (boxId: string): void => {
  window.sessionStorage.removeItem(storageKey(boxId));
};

const generateClientSeed = (): string => {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
};

const catalogMatchesOpening = (
  catalog: PublishedBoxVersionResponse,
  opening: Opening,
): catalog is OpeningCatalog => {
  if ('openingCompatibilityVersion' in opening) {
    if (!isOpeningV2Catalog(catalog)) return false;
    if (catalog.version.maxOpeningsPerUser !== opening.entitlement.maxOpeningsPerUser) return false;
  } else {
    if (!isOpeningV1Catalog(catalog)) return false;
    if (
      catalog.version.priceMinor !== opening.cost.priceMinor ||
      catalog.version.currency !== opening.cost.currency ||
      catalog.manifest.priceMinor !== opening.cost.priceMinor ||
      catalog.manifest.currency !== opening.cost.currency
    ) {
      return false;
    }
  }
  if (
    catalog.manifest.boxId !== opening.boxId ||
    catalog.manifest.boxVersionId !== opening.boxVersionId ||
    catalog.version.id !== opening.boxVersionId ||
    catalog.configurationHash !== opening.fairness.configurationHash ||
    catalog.version.configurationHash !== opening.fairness.configurationHash ||
    catalog.version.state !== 'published' ||
    catalog.version.totalWeight !== catalog.manifest.totalWeight ||
    catalog.entries.length !== catalog.manifest.entries.length
  ) {
    return false;
  }

  let totalWeight = 0n;
  for (const [index, entry] of catalog.entries.entries()) {
    const manifestEntry = catalog.manifest.entries[index];
    if (
      entry.id !== manifestEntry?.boxVersionRewardId ||
      entry.position !== index ||
      manifestEntry.position !== index ||
      entry.rewardVersion.id !== manifestEntry.rewardVersionId ||
      entry.weight !== manifestEntry.weight
    ) {
      return false;
    }
    totalWeight += BigInt(entry.weight);
  }
  if (totalWeight.toString() !== catalog.manifest.totalWeight) return false;

  const winningEntries = catalog.entries.filter(
    (entry) => entry.rewardVersion.id === opening.reward.rewardVersionId,
  );
  if (winningEntries.length !== 1) return false;
  const winningEntry = winningEntries.at(0);
  return (
    winningEntry?.rewardVersion.name === opening.reward.name &&
    winningEntry.rewardVersion.imageUrl === opening.reward.imageUrl &&
    winningEntry.rarity === opening.reward.rarity &&
    winningEntry.rarityPolicyVersion === opening.reward.rarityPolicyVersion
  );
};

const rarityLabel = (rarity: RewardRarity | null): string =>
  rarity === null ? 'Unspecified' : `${rarity[0]?.toUpperCase() ?? ''}${rarity.slice(1)}`;

const FairnessProof = ({
  api,
  opening,
}: {
  readonly api: CreatorDropApiClient;
  readonly opening: Opening;
}) => {
  const [proof, setProof] = useState<OpeningFairnessProofResponse['proof']>();
  const [verification, setVerification] = useState<'invalid' | 'running' | 'valid'>();
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    setError(undefined);
    setVerification(undefined);
    try {
      const response = await api.getOpeningFairnessProof(opening.id);
      setProof(response.proof);
      if (response.proof.verificationStatus === 'ready') {
        setVerification('running');
        const result = await verifyPersistedRewardSelectionProof(response.proof);
        setVerification(result.valid ? 'valid' : 'invalid');
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Fairness proof is unavailable.');
    }
  }, [api, opening.id]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  return (
    <details className="opening-fairness">
      <summary>{verification === 'valid' ? 'Provably Fair ✓' : 'Provably fair details'}</summary>
      {error === undefined ? null : (
        <div className="inline-error" role="alert">
          {error} <button onClick={() => void load()}>Try again</button>
        </div>
      )}
      {proof === undefined ? (
        <p role="status">Loading the authoritative fairness proof…</p>
      ) : (
        <div className="proof-copy">
          {proof.verificationStatus === 'pending_reveal' ? (
            <p>
              This opening is committed. Full independent verification is waiting for the server
              seed to be revealed.
            </p>
          ) : null}
          {proof.verificationStatus === 'unverifiable' ? (
            <p className="proof-warning">
              This seed set was compromised, so this opening cannot receive normal independent
              verification.
            </p>
          ) : null}
          {proof.verificationStatus === 'ready' && verification === 'running' ? (
            <p role="status">Independently recomputing every HMAC round…</p>
          ) : null}
          {verification === 'valid' ? (
            <p className="proof-valid">
              Provably Fair ✓ — the independent verifier reproduced the committed result.
            </p>
          ) : null}
          {verification === 'invalid' ? (
            <p className="proof-warning" role="alert">
              Verification failed. The recorded proof does not reproduce this result.
            </p>
          ) : null}
          <p>
            CreatorDrop committed to a hidden server seed before the opening. Your client seed and
            nonce contributed to the deterministic result.
          </p>
          <dl>
            <div>
              <dt>Algorithm</dt>
              <dd>{proof.algorithmVersion}</dd>
            </div>
            <div>
              <dt>Seed commitment</dt>
              <dd className="hash-value">{proof.serverSeedCommitment}</dd>
            </div>
            <div>
              <dt>Client seed</dt>
              <dd className="hash-value">{proof.clientSeed}</dd>
            </div>
            <div>
              <dt>Nonce</dt>
              <dd>{proof.nonce}</dd>
            </div>
            <div>
              <dt>Configuration</dt>
              <dd className="hash-value">{proof.configurationHash}</dd>
            </div>
          </dl>
        </div>
      )}
    </details>
  );
};

export const OpeningExperience = ({
  api,
  box,
  customSlug,
  onCatalogChange,
  session,
}: {
  readonly api: CreatorDropApiClient;
  readonly box: OpeningCatalog;
  readonly customSlug: string;
  readonly onCatalogChange: (catalog: PublishedBoxVersionResponse) => void;
  readonly session: SessionState;
}) => {
  const reducedMotion = usePrefersReducedMotion();
  const [stage, setStage] = useState<Stage>('idle');
  const [opening, setOpening] = useState<Opening>();
  const [confirmationCatalog, setConfirmationCatalog] = useState<OpeningCatalog>();
  const [committedCatalog, setCommittedCatalog] = useState<OpeningCatalog>();
  const [entitlementState, setEntitlementState] = useState<OpeningV2EntitlementStateContract>();
  const [error, setError] = useState<string>();
  const [resultError, setResultError] = useState<string>();
  const [clientSeed, setClientSeed] = useState<string>();
  const [fairnessRevision, setFairnessRevision] = useState<number>();
  const [serverSeedCommitment, setServerSeedCommitment] = useState<string>();
  const [seedSetId, setSeedSetId] = useState<string>();
  const [reelTargetX, setReelTargetX] = useState<number>();
  const confirmationHeading = useRef<HTMLHeadingElement>(null);
  const reelTrack = useRef<HTMLOListElement>(null);
  const reelWinner = useRef<HTMLLIElement>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const originalClientSeed = useRef<string | undefined>(undefined);
  const confirming = useRef(false);
  const preparingConfirmation = useRef(false);
  const recovered = useRef(false);
  const entitlementAvailability =
    entitlementState === undefined
      ? 'Checking Drop availability…'
      : entitlementState.limitReached
        ? `This Drop's personal limit of ${entitlementState.maxOpeningsPerUser} has been reached.`
        : entitlementState.remaining === '0'
          ? 'No Drops available'
          : `${entitlementState.remaining} ${entitlementState.remaining === '1' ? 'Drop' : 'Drops'} available`;

  const loadOrInitializeFairness = useCallback(async () => {
    let fairness: CurrentFairnessResponse;
    try {
      fairness = await api.getCurrentFairness();
    } catch (currentError) {
      if (
        !(currentError instanceof CreatorDropApiError) ||
        currentError.code !== 'FAIRNESS_NOT_INITIALIZED'
      ) {
        throw currentError;
      }
      try {
        await api.initializeFairness();
      } catch (initializationError) {
        const ambiguousResponse =
          initializationError instanceof CreatorDropNetworkError ||
          initializationError instanceof CreatorDropProtocolError;
        if (!ambiguousResponse) throw initializationError;
      }
      try {
        fairness = await api.getCurrentFairness();
      } catch {
        throw currentError;
      }
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (fairness.fairness.clientSeed !== null) return fairness;
      const generatedClientSeed = generateClientSeed();
      try {
        const updated = await api.updateCurrentClientSeed(
          generatedClientSeed,
          fairness.fairness.revision,
          fairness.fairness.activeSeedSet.id,
          fairness.fairness.activeSeedSet.commitment,
        );
        if (updated.fairness.clientSeed === null) {
          throw new CreatorDropProtocolError();
        }
        return updated;
      } catch (updateError) {
        const retryableConflict =
          updateError instanceof CreatorDropApiError &&
          (updateError.code === 'FAIRNESS_REVISION_CONFLICT' ||
            updateError.code === 'FAIRNESS_CONFIRMATION_STALE');
        const ambiguousResponse =
          updateError instanceof CreatorDropNetworkError ||
          updateError instanceof CreatorDropProtocolError;
        if (!retryableConflict && !ambiguousResponse) throw updateError;
        try {
          fairness = await api.getCurrentFairness();
        } catch {
          throw updateError;
        }
      }
    }
    throw new Error('Fairness setup changed repeatedly. Review it and try again.');
  }, [api]);

  const loadCurrentCatalog = useCallback(async (): Promise<OpeningCatalog> => {
    const current = await api.getCreatorBox(customSlug, box.manifest.boxId);
    if (
      current.creator.customSlug !== customSlug ||
      current.box.manifest.boxId !== box.manifest.boxId
    ) {
      throw new Error('The current box version is not available for opening.');
    }
    if (isOpeningV2Catalog(box)) {
      if (!isOpeningV2Catalog(current.box)) {
        throw new Error('The current box version is not available for opening.');
      }
      onCatalogChange(current.box);
      return current.box;
    }
    if (!isOpeningV1Catalog(current.box)) {
      throw new Error('The current box version is not available for opening.');
    }
    onCatalogChange(current.box);
    return current.box;
  }, [api, box, customSlug, onCatalogChange]);

  useEffect(() => {
    if (!isOpeningV2Catalog(box) || session.status !== 'authenticated') {
      return;
    }
    let current = true;
    void api
      .getOpeningEntitlementState(box.manifest.boxId)
      .then(({ entitlement }) => {
        if (current) setEntitlementState(entitlement);
      })
      .catch(() => {
        if (current) setEntitlementState(undefined);
      });
    return () => {
      current = false;
    };
  }, [api, box, session.status]);

  const resolveCommittedCatalog = useCallback(
    async (committedOpening: Opening, forceFetch = false): Promise<void> => {
      setResultError(undefined);
      setStage('resolving-result');
      try {
        const catalog =
          !forceFetch && catalogMatchesOpening(box, committedOpening)
            ? box
            : await api.getPublishedBoxVersion(
                committedOpening.boxId,
                committedOpening.boxVersionId,
              );
        if (!catalogMatchesOpening(catalog, committedOpening)) {
          throw new Error('The published version did not match the committed opening.');
        }
        setReelTargetX(undefined);
        setCommittedCatalog(catalog);
        onCatalogChange(catalog);
        setStage(reducedMotion ? 'result' : 'reel');
      } catch {
        setCommittedCatalog(undefined);
        setResultError(
          'The opening is committed, but its authoritative published version could not be loaded.',
        );
        setStage('result-error');
      }
    },
    [api, box, onCatalogChange, reducedMotion],
  );

  const submit = useCallback(
    async (pending: PendingOpening) => {
      setError(undefined);
      setStage('submitting');
      try {
        const response = await api.openBox(
          box.manifest.boxId,
          pending.clientSeed,
          pending.idempotencyKey,
          pending.expectedBoxVersionId,
          pending.expectedConfigurationHash,
          pending.expectedSeedSetId,
          pending.expectedServerSeedCommitment,
        );
        if (
          response.opening.fairness.clientSeed !== pending.clientSeed ||
          response.opening.fairness.seedSetId !== pending.expectedSeedSetId ||
          response.opening.fairness.commitment !== pending.expectedServerSeedCommitment
        ) {
          throw new Error('The committed opening did not match the confirmed fairness seed.');
        }
        if ('openingCompatibilityVersion' in response.opening) {
          void api
            .getOpeningEntitlementState(response.opening.boxId)
            .then(({ entitlement }) => setEntitlementState(entitlement))
            .catch(() => setEntitlementState(undefined));
        }
        setOpening(response.opening);
        await resolveCommittedCatalog(response.opening);
      } catch (submissionError) {
        if (submissionError instanceof CreatorDropApiError) {
          if (submissionError.code === 'OPENING_RETRY_REQUIRED') {
            writePending(box.manifest.boxId, { ...pending, recovery: 'manual' });
          } else {
            clearPending(box.manifest.boxId);
          }
          if (submissionError.code === 'FAIRNESS_CONFIRMATION_STALE') {
            try {
              const refreshed = await api.getCurrentFairness();
              if (refreshed.fairness.clientSeed === null) {
                setError('Your fairness commitment changed. Reload it before opening.');
                setStage('idle');
                return;
              }
              originalClientSeed.current = refreshed.fairness.clientSeed;
              setClientSeed(refreshed.fairness.clientSeed);
              setFairnessRevision(refreshed.fairness.revision);
              setSeedSetId(refreshed.fairness.activeSeedSet.id);
              setServerSeedCommitment(refreshed.fairness.activeSeedSet.commitment);
              setError(
                'Your fairness commitment changed. Review the new commitment and confirm again.',
              );
              setStage('confirm');
              return;
            } catch {
              setError('Your fairness commitment changed. Reload it before opening.');
              setStage('idle');
              return;
            }
          }
          if (submissionError.code === 'OPENING_CONFIRMATION_STALE') {
            try {
              const currentCatalog = await loadCurrentCatalog();
              setConfirmationCatalog(currentCatalog);
              setError(
                'This box changed after you reviewed it. Check the updated version and price, then confirm again.',
              );
              setStage('confirm');
              return;
            } catch {
              setConfirmationCatalog(undefined);
              setError(
                'This box changed, but the current version could not be loaded. Try again before opening.',
              );
              setStage('idle');
              return;
            }
          }
        }
        setError(
          submissionError instanceof Error
            ? submissionError.message
            : 'The opening could not be completed.',
        );
        setStage('confirm');
      }
    },
    [api, box.manifest.boxId, loadCurrentCatalog, resolveCommittedCatalog],
  );

  useEffect(() => {
    if (recovered.current || session.status !== 'authenticated') return;
    recovered.current = true;
    const pending = readPending(box.manifest.boxId, session.user.id);
    if (pending?.recovery === 'automatic') void Promise.resolve().then(() => submit(pending));
  }, [box.manifest.boxId, session, submit]);

  useEffect(() => {
    if (stage === 'confirm') confirmationHeading.current?.focus();
    if (stage === 'result') resultHeading.current?.focus();
  }, [stage]);

  const confirm = async (): Promise<void> => {
    if (confirming.current) return;
    confirming.current = true;
    try {
      if (session.status !== 'authenticated') {
        throw new Error('Sign in before opening this box.');
      }
      if (confirmationCatalog === undefined) {
        throw new Error('Review the current box version before confirming this opening.');
      }
      let pending = readPending(box.manifest.boxId, session.user.id);
      if (
        pending !== undefined &&
        (pending.expectedBoxVersionId !== confirmationCatalog.version.id ||
          pending.expectedConfigurationHash !== confirmationCatalog.configurationHash)
      ) {
        clearPending(box.manifest.boxId);
        pending = undefined;
      }
      if (pending === undefined) {
        if (
          clientSeed === undefined ||
          fairnessRevision === undefined ||
          seedSetId === undefined ||
          serverSeedCommitment === undefined ||
          !/^[0-9a-f]{64}$/u.test(clientSeed)
        ) {
          throw new Error('Client seed must be exactly 64 lowercase hexadecimal characters.');
        }
        let authoritativeClientSeed = clientSeed;
        if (originalClientSeed.current !== clientSeed) {
          const updated = await api.updateCurrentClientSeed(
            clientSeed,
            fairnessRevision,
            seedSetId,
            serverSeedCommitment,
          );
          if (
            updated.fairness.clientSeed === null ||
            updated.fairness.activeSeedSet.id !== seedSetId ||
            updated.fairness.activeSeedSet.commitment !== serverSeedCommitment
          ) {
            throw new CreatorDropProtocolError();
          }
          authoritativeClientSeed = updated.fairness.clientSeed;
          originalClientSeed.current = authoritativeClientSeed;
          setFairnessRevision(updated.fairness.revision);
        }
        pending = {
          clientSeed: authoritativeClientSeed,
          expectedBoxVersionId: confirmationCatalog.version.id,
          expectedConfigurationHash: confirmationCatalog.configurationHash,
          expectedSeedSetId: seedSetId,
          expectedServerSeedCommitment: serverSeedCommitment,
          idempotencyKey: `opening_${globalThis.crypto.randomUUID()}`,
          recovery: 'automatic',
          userId: session.user.id,
        };
        writePending(box.manifest.boxId, pending);
      }
      const submittedPending = { ...pending, recovery: 'automatic' as const };
      writePending(box.manifest.boxId, submittedPending);
      await submit(submittedPending);
    } catch (confirmationError) {
      if (
        confirmationError instanceof CreatorDropApiError &&
        (confirmationError.code === 'FAIRNESS_REVISION_CONFLICT' ||
          confirmationError.code === 'FAIRNESS_CONFIRMATION_STALE')
      ) {
        clearPending(box.manifest.boxId);
        try {
          const refreshed = await api.getCurrentFairness();
          if (refreshed.fairness.clientSeed === null) {
            setError('Your fairness settings changed. Reload them before opening.');
            setStage('idle');
            return;
          }
          originalClientSeed.current = refreshed.fairness.clientSeed;
          setClientSeed(refreshed.fairness.clientSeed);
          setFairnessRevision(refreshed.fairness.revision);
          setSeedSetId(refreshed.fairness.activeSeedSet.id);
          setServerSeedCommitment(refreshed.fairness.activeSeedSet.commitment);
          setError('Your fairness settings changed. Review them and confirm again.');
          setStage('confirm');
          return;
        } catch {
          setError('Your fairness settings changed. Reload them before opening.');
          setStage('idle');
          return;
        }
      }
      setError(
        confirmationError instanceof Error
          ? confirmationError.message
          : 'Your fairness state could not be loaded.',
      );
      setStage('confirm');
    } finally {
      confirming.current = false;
    }
  };

  const beginConfirmation = async (): Promise<void> => {
    if (preparingConfirmation.current) return;
    preparingConfirmation.current = true;
    setError(undefined);
    setStage('preparing-confirmation');
    try {
      if (session.status !== 'authenticated') {
        throw new Error('Sign in before opening this box.');
      }
      const [fairness, currentCatalog] = await Promise.all([
        loadOrInitializeFairness(),
        loadCurrentCatalog(),
      ]);
      if (fairness.fairness.clientSeed === null) {
        throw new Error('Choose a client seed before opening.');
      }
      const existing = readPending(box.manifest.boxId, session.user.id);
      if (
        existing?.recovery === 'manual' &&
        (existing.expectedBoxVersionId !== currentCatalog.version.id ||
          existing.expectedConfigurationHash !== currentCatalog.configurationHash ||
          existing.expectedSeedSetId !== fairness.fairness.activeSeedSet.id ||
          existing.expectedServerSeedCommitment !== fairness.fairness.activeSeedSet.commitment)
      ) {
        clearPending(box.manifest.boxId);
      }
      setConfirmationCatalog(currentCatalog);
      originalClientSeed.current = fairness.fairness.clientSeed;
      setClientSeed(fairness.fairness.clientSeed);
      setFairnessRevision(fairness.fairness.revision);
      setSeedSetId(fairness.fairness.activeSeedSet.id);
      setServerSeedCommitment(fairness.fairness.activeSeedSet.commitment);
      setStage('confirm');
    } catch (loadError) {
      setConfirmationCatalog(undefined);
      setSeedSetId(undefined);
      setServerSeedCommitment(undefined);
      setError(
        loadError instanceof Error ? loadError.message : 'Your fairness state is unavailable.',
      );
      setStage('idle');
    } finally {
      preparingConfirmation.current = false;
    }
  };

  const winnerEntry = committedCatalog?.entries.find(
    (entry) => entry.rewardVersion.id === opening?.reward.rewardVersionId,
  );
  const reelEntries =
    opening === undefined || winnerEntry === undefined || committedCatalog === undefined
      ? []
      : Array.from({ length: 20 }, (_, index) =>
          index === 16
            ? winnerEntry
            : committedCatalog.entries[index % committedCatalog.entries.length],
        );

  useLayoutEffect(() => {
    if (stage !== 'reel') return;
    const track = reelTrack.current;
    const winner = reelWinner.current;
    if (track === null || winner === null) return;

    const measure = (): void => {
      const trackBounds = track.getBoundingClientRect();
      const winnerBounds = winner.getBoundingClientRect();
      if (winnerBounds.width <= 0) return;
      const nextTarget = calculateReelWinnerTranslation(
        trackBounds.left,
        winnerBounds.left,
        winnerBounds.width,
      );
      if (Number.isFinite(nextTarget)) setReelTargetX(nextTarget);
    };

    measure();
    const observer =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => measure());
    observer?.observe(track);
    observer?.observe(winner);
    if (track.parentElement !== null) observer?.observe(track.parentElement);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [committedCatalog?.version.id, opening?.id, stage]);

  if (stage === 'idle') {
    if (session.status !== 'authenticated') {
      return (
        <section className="opening-callout">
          <p>
            {isOpeningV2Catalog(box)
              ? 'Sign in to use an available Drop entitlement.'
              : 'Sign in to spend wallet balance and open this box.'}
          </p>
          <Link className="button primary" to="/auth">
            Sign in to open
          </Link>
        </section>
      );
    }
    return (
      <section className="opening-callout">
        <p>The result is committed by the backend before the reveal animation begins.</p>
        {isOpeningV2Catalog(box) ? (
          <p>
            <strong>{entitlementAvailability}</strong>
            {entitlementState === undefined || entitlementState.limitReached
              ? null
              : ` · ${entitlementState.successfulOpenings} of ${entitlementState.maxOpeningsPerUser} opened`}
          </p>
        ) : null}
        {error === undefined ? null : (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <button
          className="button primary"
          disabled={isOpeningV2Catalog(box) && !entitlementState?.available}
          onClick={() => void beginConfirmation()}
        >
          {isOpeningV2Catalog(box) ? 'Open Drop' : 'Open this box'}
        </button>
      </section>
    );
  }

  if (stage === 'preparing-confirmation') {
    return (
      <section className="opening-dialog">
        <p className="eyebrow">Preparing confirmation</p>
        <p role="status">
          {isOpeningV2Catalog(box)
            ? 'Checking the current authoritative box version and entitlement…'
            : 'Checking the current authoritative box version and price…'}
        </p>
      </section>
    );
  }

  if ((stage === 'confirm' || stage === 'submitting') && confirmationCatalog !== undefined) {
    return (
      <section aria-labelledby="opening-confirm-heading" className="opening-dialog">
        <p className="eyebrow">Confirm opening</p>
        <h2 id="opening-confirm-heading" ref={confirmationHeading} tabIndex={-1}>
          Open {confirmationCatalog.version.name}?
        </h2>
        {isOpeningV1Catalog(confirmationCatalog) ? (
          <>
            <p className="opening-confirmation-price">
              {formatMinorUnits(
                confirmationCatalog.version.priceMinor,
                confirmationCatalog.version.currency,
              )}
            </p>
            <p className="opening-confirmation-charge">
              This amount will be deducted from your wallet.
            </p>
          </>
        ) : (
          <p className="opening-confirmation-charge">
            This uses one available Drop entitlement. It does not charge your wallet.
          </p>
        )}
        <details className="opening-confirmation-fairness">
          <summary>
            <span className="opening-confirmation-fairness-status">
              <span aria-hidden="true">🔒</span>
              Provably fair
            </span>
            <span className="opening-confirmation-fairness-label">Fairness details</span>
          </summary>
          <div className="opening-confirmation-fairness-content">
            <p>
              CreatorDrop fixed a hidden server seed before this opening. The commitment lets you
              verify the result after that seed is revealed; your client seed and nonce also
              contribute to the result.
            </p>
            <dl>
              <div>
                <dt>Server-seed commitment</dt>
                <dd className="hash-value">{serverSeedCommitment}</dd>
              </div>
              <div>
                <dt>Seed-set ID</dt>
                <dd className="hash-value">{seedSetId}</dd>
              </div>
            </dl>
            <label className="client-seed-control">
              Client seed
              <input
                aria-describedby="client-seed-help"
                autoComplete="off"
                disabled={stage === 'submitting'}
                maxLength={64}
                onChange={(event) => setClientSeed(event.target.value)}
                spellCheck={false}
                value={clientSeed ?? ''}
              />
            </label>
            <p id="client-seed-help" className="field-help">
              This seed is combined with the hidden server seed and nonce. If you generate a new
              one, CreatorDrop saves it before submitting the opening.
            </p>
            <button
              className="text-button"
              disabled={stage === 'submitting'}
              onClick={() => setClientSeed(generateClientSeed())}
              type="button"
            >
              Generate a new client seed
            </button>
          </div>
        </details>
        {error === undefined ? null : (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <div className="opening-actions">
          <button
            className="button primary"
            disabled={stage === 'submitting' || !/^[0-9a-f]{64}$/u.test(clientSeed ?? '')}
            onClick={() => void confirm()}
          >
            {stage === 'submitting'
              ? 'Committing opening…'
              : isOpeningV2Catalog(confirmationCatalog)
                ? 'Open Drop'
                : 'Open box'}
          </button>
          <button
            className="button secondary"
            disabled={stage === 'submitting'}
            onClick={() => setStage('idle')}
          >
            Cancel
          </button>
        </div>
      </section>
    );
  }

  if (stage === 'resolving-result' && opening !== undefined) {
    return (
      <section aria-labelledby="opening-committed-heading" className="opening-dialog">
        <p className="eyebrow">Opening committed</p>
        <h2 id="opening-committed-heading">Loading your authoritative result…</h2>
        <p role="status">
          CreatorDrop is loading the exact immutable box version used for this opening.
        </p>
      </section>
    );
  }

  if (stage === 'result-error' && opening !== undefined) {
    return (
      <section aria-labelledby="opening-committed-heading" className="opening-dialog">
        <p className="eyebrow">Opening committed</p>
        <h2 id="opening-committed-heading">Your result is safely recorded</h2>
        <p className="inline-error" role="alert">
          {resultError}
        </p>
        <p>No second opening will be submitted while the authoritative result is reloaded.</p>
        <button
          className="button secondary"
          onClick={() => void resolveCommittedCatalog(opening, true)}
        >
          Retry result data
        </button>
      </section>
    );
  }

  if (
    stage === 'reel' &&
    opening !== undefined &&
    committedCatalog !== undefined &&
    winnerEntry !== undefined
  ) {
    return (
      <section aria-labelledby="reel-heading" className="reel-stage">
        <p className="eyebrow">Opening committed</p>
        <h2 id="reel-heading">Unwrapping your reward…</h2>
        <div className="reel-window">
          <div className="reel-marker" aria-hidden="true" />
          <motion.ol
            animate={reelTargetX === undefined ? false : { x: reelTargetX }}
            className="reel-track"
            data-reel-target-x={reelTargetX}
            initial={false}
            onAnimationComplete={() => {
              if (reelTargetX !== undefined) setStage('result');
            }}
            ref={reelTrack}
            transition={{ duration: 6, ease: [0.12, 0.68, 0.12, 1] }}
          >
            {reelEntries.map((entry, index) => (
              <li
                className={`gift rarity-${entry?.rarity ?? 'unspecified'}`}
                data-reel-winner={index === 16 ? 'true' : undefined}
                key={`${entry?.id ?? 'gift'}-${index.toString()}`}
                ref={index === 16 ? reelWinner : undefined}
              >
                <span className="gift-icon" aria-hidden="true" />
                <small>{rarityLabel(entry?.rarity ?? null)}</small>
              </li>
            ))}
          </motion.ol>
        </div>
        <button className="button secondary" onClick={() => setStage('result')}>
          Skip to reveal
        </button>
      </section>
    );
  }

  if (opening === undefined || committedCatalog === undefined || winnerEntry === undefined) {
    return null;
  }
  return (
    <section
      aria-live="polite"
      aria-labelledby="opening-result-heading"
      className={`opening-result rarity-${opening.reward.rarity ?? 'unspecified'}`}
    >
      <p className="eyebrow">Your reward</p>
      <div className="result-art">
        {winnerEntry.rewardVersion.imageUrl === null ? (
          <div className="result-gift gift" aria-hidden="true">
            <span className="gift-icon" />
          </div>
        ) : (
          <img
            src={winnerEntry.rewardVersion.imageUrl}
            alt={`${winnerEntry.rewardVersion.name} reward`}
          />
        )}
      </div>
      <h2 id="opening-result-heading" ref={resultHeading} tabIndex={-1}>
        {winnerEntry.rewardVersion.name}
      </h2>
      <p className="rarity-name">{rarityLabel(winnerEntry.rarity)}</p>
      <p>
        Opened {committedCatalog.version.name}, published version{' '}
        {committedCatalog.version.versionNumber.toString()}
        {'cost' in opening ? (
          <>
            , for{' '}
            <strong>{formatMinorUnits(opening.cost.priceMinor, opening.cost.currency)}</strong>
          </>
        ) : (
          <> using one Drop entitlement</>
        )}
        .
      </p>
      <p>
        Exact odds:{' '}
        <strong>
          {formatProbability(winnerEntry.weight, committedCatalog.manifest.totalWeight)}
        </strong>{' '}
        ({winnerEntry.weight} / {committedCatalog.manifest.totalWeight})
      </p>
      <p>
        {'pointsAwarded' in opening ? (
          <>
            <strong>+{opening.pointsAwarded.toString()} points</strong> ·{' '}
          </>
        ) : (
          <>
            <strong>
              {opening.entitlement.remaining}{' '}
              {opening.entitlement.remaining === '1' ? 'Drop' : 'Drops'} remaining
            </strong>{' '}
            ·{' '}
          </>
        )}
        Fulfillment: {opening.fulfillmentStatus.replaceAll('_', ' ')}
      </p>
      <FairnessProof api={api} opening={opening} />
      <button
        className="button secondary"
        onClick={() => {
          clearPending(box.manifest.boxId);
          setOpening(undefined);
          setCommittedCatalog(undefined);
          setStage('idle');
        }}
      >
        Open another
      </button>
    </section>
  );
};
