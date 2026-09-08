// @vitest-environment jsdom

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import type {
  BoxOpeningResponse,
  CurrentFairnessResponse,
  OpeningV2EntitlementStateResponse,
  PublishedBoxVersionResponse,
  PublicCreatorsResponse,
} from '@creatordrop/contracts';

import { usePrefersReducedMotion } from '../src/accessibility/use-prefers-reduced-motion.js';
import { ApiProvider } from '../src/api/api-context.js';
import { CreatorDropApiError, type CreatorDropApiClient } from '../src/api/client.js';
import { AppRoutes } from '../src/app.js';
import { SessionProvider } from '../src/auth/session-context.js';
import { isOpeningV2Catalog, type OpeningV2Catalog } from '../src/components/opening-catalog.js';
import { calculateReelWinnerTranslation } from '../src/components/reel-geometry.js';
import {
  authSessionResponseFixture,
  currentFairnessFixture,
  openingV2BoxFixture,
  openingV2ResponseFixture,
  pendingOpeningV2ProofFixture,
  publicCreatorBoxesResponseFixture,
  publicCreatorResponseFixture,
  publishedBoxFixture,
} from './fixtures.js';
import { browserSession, createTestApiClient, createTestAuthClient } from './test-clients.js';

vi.mock('../src/accessibility/use-prefers-reduced-motion.js', () => ({
  usePrefersReducedMotion: vi.fn(() => false),
}));

const mockedReducedMotion = vi.mocked(usePrefersReducedMotion);

const availableEntitlement = (
  overrides: Partial<OpeningV2EntitlementStateResponse['entitlement']> = {},
): OpeningV2EntitlementStateResponse => ({
  entitlement: {
    available: true,
    boxId: openingV2BoxFixture.manifest.boxId,
    consumed: '0',
    granted: '3',
    limitReached: false,
    maxOpeningsPerUser: '3',
    remaining: '3',
    successfulOpenings: '0',
    ...overrides,
  },
});

const renderRoute = (
  route: string,
  options: {
    readonly api?: ReturnType<typeof createTestApiClient>;
    readonly auth?: ReturnType<typeof createTestAuthClient>;
  } = {},
) => {
  const api = options.api ?? createTestApiClient();
  const auth = options.auth ?? createTestAuthClient();
  return {
    api,
    auth,
    ...render(
      <MemoryRouter initialEntries={[route]}>
        <ApiProvider client={api}>
          <SessionProvider apiClient={api} authClient={auth}>
            <AppRoutes />
          </SessionProvider>
        </ApiProvider>
      </MemoryRouter>,
    ),
  };
};

const renderAuthenticatedDrop = (overrides: Partial<CreatorDropApiClient> = {}) =>
  renderRoute(`/creators/creator-one/boxes/${openingV2BoxFixture.manifest.boxId}`, {
    api: createTestApiClient({
      getOpeningEntitlementState: () => Promise.resolve(availableEntitlement()),
      ...overrides,
    }),
    auth: createTestAuthClient({ getSession: () => Promise.resolve(browserSession()) }),
  });

const openConfirmation = async () => {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Open Drop' }));
  const heading = await screen.findByRole('heading', {
    name: 'Open one of your available Drops?',
  });
  const confirmation = heading.closest('section');
  if (confirmation === null) throw new Error('Expected the Drop confirmation section.');
  return { confirmation, user };
};

const deferred = <T,>() => {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
};

const rectangle = (left: number, width: number): DOMRect => ({
  bottom: 128,
  height: 128,
  left,
  right: left + width,
  toJSON: () => ({}),
  top: 0,
  width,
  x: left,
  y: 0,
});

const requireOpeningV2Catalog = (catalog: PublishedBoxVersionResponse): OpeningV2Catalog => {
  if (!isOpeningV2Catalog(catalog)) throw new Error('Expected an opening-v2 fixture.');
  return catalog;
};

type OpeningV2 = Extract<
  BoxOpeningResponse['opening'],
  { readonly openingCompatibilityVersion: 'opening-v2' }
>;

const requireOpeningV2 = (response: BoxOpeningResponse): OpeningV2 => {
  if (!('openingCompatibilityVersion' in response.opening)) {
    throw new Error('Expected an opening-v2 response fixture.');
  }
  return response.opening;
};

const committedVersionB = (uniqueWinner = false) => {
  const original = requireOpeningV2Catalog(openingV2BoxFixture);
  const originalOpening = requireOpeningV2(openingV2ResponseFixture);
  const originalEntry = original.entries[0];
  const originalManifestEntry = original.manifest.entries[0];
  if (originalEntry === undefined || originalManifestEntry === undefined) {
    throw new Error('Expected one opening-v2 reward entry.');
  }
  const versionId = '00000000-0000-4000-8000-000000000507';
  const configurationHash = 'e'.repeat(64);
  const rewardVersion = uniqueWinner
    ? {
        ...originalEntry.rewardVersion,
        id: '00000000-0000-4000-8000-000000000508',
        name: 'Version B only reward',
      }
    : originalEntry.rewardVersion;
  const entry = {
    ...originalEntry,
    id: '00000000-0000-4000-8000-000000000509',
    rarity: 'rare' as const,
    rewardVersion,
  };
  const box: OpeningV2Catalog = {
    configurationHash,
    entries: [entry],
    manifest: {
      ...original.manifest,
      boxVersionId: versionId,
      entries: [
        {
          ...originalManifestEntry,
          boxVersionRewardId: entry.id,
          rarity: entry.rarity,
          rewardVersionId: rewardVersion.id,
        },
      ],
    },
    version: {
      ...original.version,
      configurationHash,
      id: versionId,
      name: 'Updated Free Drop',
      versionNumber: 2,
    },
  };
  const opening: BoxOpeningResponse = {
    opening: {
      ...originalOpening,
      boxVersionId: versionId,
      fairness: { ...originalOpening.fairness, configurationHash },
      reward: {
        ...originalOpening.reward,
        name: rewardVersion.name,
        rarity: entry.rarity,
        rewardVersionId: rewardVersion.id,
      },
    },
  };
  return { box, opening };
};

describe('R1C active fan product', () => {
  it('renders the public creator catalog without authentication and escapes untrusted text', async () => {
    const maliciousName = '<script>window.hacked=true</script>';
    const response: PublicCreatorsResponse = {
      creators: [
        {
          customSlug: 'safe-creator',
          displayName: maliciousName,
          handle: 'safe_creator',
        },
      ],
      nextCursor: null,
    };
    const user = userEvent.setup();
    const { container } = renderRoute('/creators', {
      api: createTestApiClient({ listCreators: () => Promise.resolve(response) }),
    });

    const creatorLink = await screen.findByRole('link', { name: /window\.hacked/u });
    expect(creatorLink).toHaveTextContent(maliciousName);
    expect(container.querySelector('script')).toBeNull();
    expect(screen.getByRole('link', { name: 'Sign in' })).toBeInTheDocument();
    await user.tab();
    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveFocus();
  });

  it('renders v2 catalog cards and reward odds without prices, currencies, or raw weights', async () => {
    const user = userEvent.setup();
    const getCreatorBox = vi.fn(() =>
      Promise.resolve({ box: openingV2BoxFixture, creator: publicCreatorResponseFixture.creator }),
    );
    renderRoute('/creators/creator-one', {
      api: createTestApiClient({
        getCreator: () => Promise.resolve(publicCreatorResponseFixture),
        getCreatorBox,
        listCreatorBoxes: () => Promise.resolve(publicCreatorBoxesResponseFixture),
      }),
    });

    const boxLink = await screen.findByRole('link', { name: /Free Drop/u });
    expect(boxLink).toHaveTextContent('Open with an available Drop');
    expect(boxLink).not.toHaveTextContent(/USD|\$/u);
    await user.click(boxLink);

    expect(await screen.findByRole('heading', { level: 1, name: 'Free Drop' })).toBeInTheDocument();
    expect(screen.getByText('100%', { selector: '.odds strong' })).toBeInTheDocument();
    expect(screen.queryByText('1 / 1')).not.toBeInTheDocument();
    expect(
      screen.queryByText(/total weight|published version|immutable configuration/iu),
    ).toBeNull();
    expect(screen.queryByText(/USD|\$0\.00|price|currency/iu)).toBeNull();
    expect(getCreatorBox).toHaveBeenCalledWith(
      publicCreatorResponseFixture.creator.customSlug,
      openingV2BoxFixture.manifest.boxId,
      expect.any(AbortSignal),
    );
  });

  it('renders all v2 rarity percentages without raw weight fractions', async () => {
    const original = requireOpeningV2Catalog(openingV2BoxFixture);
    const originalEntry = original.entries[0];
    if (originalEntry === undefined) throw new Error('Expected one opening-v2 reward entry.');
    const rewards = [
      ['720', '72%', 'common'],
      ['190', '19%', 'uncommon'],
      ['70', '7%', 'rare'],
      ['16', '1.6%', 'epic'],
      ['4', '0.4%', 'legendary'],
    ] as const;
    const entries = rewards.map(([weight, , rarity], index) => ({
      ...originalEntry,
      id: `00000000-0000-4000-8000-00000000051${index.toString()}`,
      position: index,
      rarity,
      rewardVersion: {
        ...originalEntry.rewardVersion,
        id: `00000000-0000-4000-8000-00000000052${index.toString()}`,
        name: `${rarity} demo reward`,
      },
      weight,
    }));
    const box: OpeningV2Catalog = {
      ...original,
      entries,
      manifest: {
        ...original.manifest,
        entries: entries.map((entry) => ({
          boxVersionRewardId: entry.id,
          position: entry.position,
          rarity: entry.rarity,
          rarityPolicyVersion: 'rarity-v1',
          rewardVersionId: entry.rewardVersion.id,
          weight: entry.weight,
        })),
        totalWeight: '1000',
      },
      version: { ...original.version, totalWeight: '1000' },
    };
    renderRoute(`/creators/creator-one/boxes/${box.manifest.boxId}`, {
      api: createTestApiClient({
        getCreatorBox: () =>
          Promise.resolve({ box, creator: publicCreatorResponseFixture.creator }),
      }),
    });

    await screen.findByRole('heading', { level: 1, name: 'Free Drop' });
    for (const [weight, percentage] of rewards) {
      expect(screen.getByText(percentage, { selector: '.odds strong' })).toBeVisible();
      expect(screen.queryByText(`${weight} / 1000`)).toBeNull();
    }
  });

  it('keeps opening-v1 visible only as historical, non-actionable catalog content', async () => {
    renderRoute(`/creators/creator-one/boxes/${publishedBoxFixture.manifest.boxId}`, {
      api: createTestApiClient({
        getCreatorBox: () =>
          Promise.resolve({
            box: publishedBoxFixture,
            creator: publicCreatorResponseFixture.creator,
          }),
      }),
      auth: createTestAuthClient({ getSession: () => Promise.resolve(browserSession()) }),
    });

    expect(await screen.findByText('Legacy version · view only')).toBeInTheDocument();
    expect(screen.getByText(/preserved for past records and proofs/iu)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /open/iu })).not.toBeInTheDocument();
  });

  it('asks anonymous fans to sign in without showing paid-opening language', async () => {
    renderRoute(`/creators/creator-one/boxes/${openingV2BoxFixture.manifest.boxId}`);

    expect(await screen.findByText('Sign in to see and open your available Drops.')).toBeVisible();
    expect(screen.queryByText(/wallet|credit|fund|price|cost|checkout/iu)).toBeNull();
  });

  it.each([
    {
      available: true,
      label: '3 Drops available',
      limitReached: false,
      remaining: '3',
      successfulOpenings: '0',
    },
    {
      available: true,
      label: '1 Drop available',
      limitReached: false,
      remaining: '1',
      successfulOpenings: '0',
    },
    {
      available: false,
      label: 'No Drops available',
      limitReached: false,
      remaining: '0',
      successfulOpenings: '0',
    },
    {
      available: false,
      label: "You've reached the opening limit for this Drop.",
      limitReached: true,
      remaining: '2',
      successfulOpenings: '3',
    },
  ])('renders server-provided availability as "$label"', async (state) => {
    renderAuthenticatedDrop({
      getOpeningEntitlementState: () =>
        Promise.resolve(
          availableEntitlement({
            available: state.available,
            limitReached: state.limitReached,
            remaining: state.remaining,
            successfulOpenings: state.successfulOpenings,
          }),
        ),
    });

    expect(await screen.findByText(state.label)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Drop' })).toHaveProperty(
      'disabled',
      !state.available,
    );
  });

  it('confirms and reveals a v2 Drop with consumer copy and no financial or raw-weight fields', async () => {
    const openBox = vi.fn(() => Promise.resolve(openingV2ResponseFixture));
    renderAuthenticatedDrop({ openBox });
    const { confirmation, user } = await openConfirmation();

    expect(within(confirmation).getByText('Free Drop')).toBeVisible();
    expect(within(confirmation).getByText('Provably Fair')).toBeVisible();
    expect(
      within(confirmation).queryByText(
        /wallet|credit|fund|price|cost|checkout|deduct|entitlement|commitment|seed|HMAC|nonce/iu,
      ),
    ).toBeNull();
    await user.click(within(confirmation).getByRole('button', { name: 'Open Drop' }));
    await user.click(await screen.findByRole('button', { name: 'Skip to reveal' }));

    const heading = await screen.findByRole('heading', { level: 2, name: 'Free Drop reward' });
    const result = heading.closest('section');
    if (result === null) throw new Error('Expected the Drop result section.');
    expect(within(result).getByText('YOU WON')).toBeInTheDocument();
    expect(within(result).getByText('Common · 100% chance')).toBeInTheDocument();
    expect(within(result).getByText('1 Drop remaining')).toBeInTheDocument();
    expect(within(result).getByText('Reward ready for fulfillment')).toBeInTheDocument();
    expect(
      within(result).queryByText(/wallet|credit|fund|price|cost|checkout|points|1 \/ 1/iu),
    ).toBeNull();
    expect(openBox).toHaveBeenCalledOnce();
  });

  it('keeps raw fairness inputs inside the optional result verifier', async () => {
    const user = userEvent.setup();
    renderAuthenticatedDrop();
    await user.click(await screen.findByRole('button', { name: 'Open Drop' }));
    await user.click(await screen.findByRole('button', { name: 'Open Drop', hidden: false }));
    await user.click(await screen.findByRole('button', { name: 'Skip to reveal' }));

    const details = (await screen.findByText('Verify opening')).closest('details');
    if (details === null) throw new Error('Expected the fairness verifier disclosure.');
    const commitment = pendingOpeningV2ProofFixture.proof.serverSeedCommitment;
    expect(within(details).getByText(commitment)).not.toBeVisible();
    await user.click(within(details).getByText('Verify opening'));
    expect(within(details).getByText(commitment)).toBeVisible();
  });

  it('cancels confirmation without submitting an opening', async () => {
    const openBox = vi.fn(() => Promise.resolve(openingV2ResponseFixture));
    renderAuthenticatedDrop({ openBox });
    const { confirmation, user } = await openConfirmation();
    await user.click(within(confirmation).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('heading', { name: 'Open one of your available Drops?' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Open Drop' })).toBeInTheDocument();
    expect(openBox).not.toHaveBeenCalled();
  });

  it('collapses duplicate confirmation clicks into one opening command', async () => {
    const pending = deferred<BoxOpeningResponse>();
    const openBox = vi.fn(() => pending.promise);
    renderAuthenticatedDrop({ openBox });
    const { confirmation, user } = await openConfirmation();

    await user.dblClick(within(confirmation).getByRole('button', { name: 'Open Drop' }));
    expect(openBox).toHaveBeenCalledOnce();
    act(() => pending.resolve(openingV2ResponseFixture));
    expect(await screen.findByRole('heading', { name: 'Unwrapping your reward…' })).toBeVisible();
  });

  it.each([
    [16, 375],
    [16, 1440],
    [18, 375],
    [18, 1440],
    [20, 375],
    [20, 1440],
  ])(
    'measures the committed v2 reel winner at %ipx root sizing and %ipx viewport width',
    async (rootFontSize, viewportWidth) => {
      const itemWidth = 6.5 * rootFontSize;
      const itemStep = 7 * rootFontSize;
      const trackLeft = viewportWidth / 2;
      const winnerLeft = trackLeft + 16 * itemStep;
      const bounds = vi
        .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
        .mockImplementation(function (this: HTMLElement) {
          if (this.classList.contains('reel-track')) {
            return rectangle(trackLeft, 20 * itemWidth + 19 * 0.5 * rootFontSize);
          }
          if (this.dataset.reelWinner === 'true') return rectangle(winnerLeft, itemWidth);
          return rectangle(0, 0);
        });
      document.documentElement.style.fontSize = `${rootFontSize.toString()}px`;
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: viewportWidth });

      try {
        renderAuthenticatedDrop();
        const { confirmation, user } = await openConfirmation();
        await user.click(within(confirmation).getByRole('button', { name: 'Open Drop' }));
        const reel = await waitFor(() => {
          const candidate = document.querySelector<HTMLOListElement>('.reel-track');
          if (candidate === null) throw new Error('Expected the reel track.');
          return candidate;
        });
        const expectedTarget = calculateReelWinnerTranslation(trackLeft, winnerLeft, itemWidth);
        await waitFor(() =>
          expect(reel).toHaveAttribute('data-reel-target-x', expectedTarget.toString()),
        );
        expect(winnerLeft + itemWidth / 2 + expectedTarget).toBeCloseTo(trackLeft, 8);
        expect(reel.querySelector('[data-reel-winner="true"]')).toBe(reel.children[16]);
      } finally {
        bounds.mockRestore();
        document.documentElement.style.removeProperty('font-size');
      }
    },
  );

  it('reuses one idempotency key after a lost response and preserves the committed reward', async () => {
    const openBox = vi
      .fn<CreatorDropApiClient['openBox']>()
      .mockRejectedValueOnce(new Error('The response was lost.'))
      .mockResolvedValueOnce(openingV2ResponseFixture);
    renderAuthenticatedDrop({ openBox });
    const { confirmation, user } = await openConfirmation();
    await user.click(within(confirmation).getByRole('button', { name: 'Open Drop' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The response was lost.');
    await user.click(screen.getByRole('button', { name: 'Open Drop' }));

    expect(await screen.findByRole('heading', { name: 'Unwrapping your reward…' })).toBeVisible();
    expect(openBox).toHaveBeenCalledTimes(2);
    expect(openBox.mock.calls[0]?.[2]).toBe(openBox.mock.calls[1]?.[2]);
  });

  it('initializes first-use fairness without displaying raw cryptographic inputs', async () => {
    const notInitialized = new CreatorDropApiError(404, {
      error: {
        code: 'FAIRNESS_NOT_INITIALIZED',
        details: {},
        message: 'Fairness state has not been initialized.',
        requestId: 'fairness-not-initialized',
      },
    });
    const unconfigured: CurrentFairnessResponse = {
      fairness: { ...currentFairnessFixture.fairness, clientSeed: null },
    };
    const getCurrentFairness = vi
      .fn<CreatorDropApiClient['getCurrentFairness']>()
      .mockRejectedValueOnce(notInitialized)
      .mockResolvedValueOnce(unconfigured);
    const initializeFairness = vi.fn(() => Promise.resolve(unconfigured));
    const updateCurrentClientSeed = vi.fn((clientSeed: string) =>
      Promise.resolve({
        fairness: { ...currentFairnessFixture.fairness, clientSeed, revision: 2 },
      }),
    );
    renderAuthenticatedDrop({ getCurrentFairness, initializeFairness, updateCurrentClientSeed });
    const { confirmation } = await openConfirmation();

    expect(initializeFairness).toHaveBeenCalledOnce();
    expect(updateCurrentClientSeed).toHaveBeenCalledWith(
      expect.stringMatching(/^[0-9a-f]{64}$/u),
      unconfigured.fairness.revision,
      unconfigured.fairness.activeSeedSet.id,
      unconfigured.fairness.activeSeedSet.commitment,
    );
    expect(
      within(confirmation).queryByText(unconfigured.fairness.activeSeedSet.commitment),
    ).toBeNull();
    expect(within(confirmation).queryByLabelText(/client seed/iu)).toBeNull();
  });

  it('converges on an existing fairness state after concurrent first-use setup', async () => {
    const notInitialized = new CreatorDropApiError(404, {
      error: {
        code: 'FAIRNESS_NOT_INITIALIZED',
        details: {},
        message: 'Fairness state has not been initialized.',
        requestId: 'fairness-race-not-initialized',
      },
    });
    const revisionConflict = new CreatorDropApiError(409, {
      error: {
        code: 'FAIRNESS_REVISION_CONFLICT',
        details: { currentRevision: 2 },
        message: 'The fairness revision is stale.',
        requestId: 'fairness-race-conflict',
      },
    });
    const unconfigured: CurrentFairnessResponse = {
      fairness: { ...currentFairnessFixture.fairness, clientSeed: null },
    };
    const getCurrentFairness = vi
      .fn<CreatorDropApiClient['getCurrentFairness']>()
      .mockRejectedValueOnce(notInitialized)
      .mockResolvedValueOnce(unconfigured)
      .mockResolvedValueOnce(currentFairnessFixture);
    const initializeFairness = vi.fn(() => Promise.resolve(unconfigured));
    const updateCurrentClientSeed = vi.fn(() => Promise.reject(revisionConflict));
    renderAuthenticatedDrop({ getCurrentFairness, initializeFairness, updateCurrentClientSeed });

    await openConfirmation();
    expect(getCurrentFairness).toHaveBeenCalledTimes(3);
    expect(initializeFairness).toHaveBeenCalledOnce();
    expect(updateCurrentClientSeed).toHaveBeenCalledOnce();
  });

  it('requires a new confirmation after fairness state rotates', async () => {
    const rotatedFairness: CurrentFairnessResponse = {
      fairness: {
        ...currentFairnessFixture.fairness,
        activeSeedSet: {
          ...currentFairnessFixture.fairness.activeSeedSet,
          commitment: 'e'.repeat(64),
          id: '00000000-0000-4000-8000-000000000405',
        },
      },
    };
    const stale = new CreatorDropApiError(409, {
      error: {
        code: 'FAIRNESS_CONFIRMATION_STALE',
        details: {},
        message: 'The active fairness seed changed.',
        requestId: 'fairness-confirmation-stale',
      },
    });
    const getCurrentFairness = vi
      .fn<CreatorDropApiClient['getCurrentFairness']>()
      .mockResolvedValueOnce(currentFairnessFixture)
      .mockResolvedValueOnce(rotatedFairness);
    const rotatedOpening = requireOpeningV2(openingV2ResponseFixture);
    const openBox = vi
      .fn<CreatorDropApiClient['openBox']>()
      .mockRejectedValueOnce(stale)
      .mockResolvedValueOnce({
        opening: {
          ...rotatedOpening,
          fairness: {
            ...rotatedOpening.fairness,
            commitment: rotatedFairness.fairness.activeSeedSet.commitment,
            seedSetId: rotatedFairness.fairness.activeSeedSet.id,
          },
        },
      });
    renderAuthenticatedDrop({ getCurrentFairness, openBox });
    const { confirmation, user } = await openConfirmation();

    await user.click(within(confirmation).getByRole('button', { name: 'Open Drop' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The fairness information changed. Please confirm this Drop again.',
    );
    expect(openBox).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'Open Drop' }));
    expect(await screen.findByRole('heading', { name: 'Unwrapping your reward…' })).toBeVisible();
    expect(openBox).toHaveBeenCalledTimes(2);
    expect(openBox.mock.calls[0]?.[2]).not.toBe(openBox.mock.calls[1]?.[2]);
    expect(openBox.mock.calls[1]?.slice(5)).toEqual([
      rotatedFairness.fairness.activeSeedSet.id,
      rotatedFairness.fairness.activeSeedSet.commitment,
    ]);
  });

  it('fails first-use fairness setup without submitting or retaining an opening command', async () => {
    const notInitialized = new CreatorDropApiError(404, {
      error: {
        code: 'FAIRNESS_NOT_INITIALIZED',
        details: {},
        message: 'Fairness state has not been initialized.',
        requestId: 'fairness-failure-not-initialized',
      },
    });
    const initializationFailure = new CreatorDropApiError(503, {
      error: {
        code: 'SEED_ENCRYPTION_KEY_UNAVAILABLE',
        details: {},
        message: 'Fairness initialization is temporarily unavailable.',
        requestId: 'fairness-initialization-failure',
      },
    });
    const initializeFairness = vi.fn(() => Promise.reject(initializationFailure));
    const openBox = vi.fn(() => Promise.resolve(openingV2ResponseFixture));
    renderAuthenticatedDrop({
      getCurrentFairness: () => Promise.reject(notInitialized),
      initializeFairness,
      openBox,
    });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Open Drop' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Fairness initialization is temporarily unavailable.',
    );
    expect(initializeFairness).toHaveBeenCalledOnce();
    expect(openBox).not.toHaveBeenCalled();
    expect(window.sessionStorage).toHaveLength(0);
  });

  it.each([
    ['OPENING_ENTITLEMENT_REQUIRED', "You don't have an available Drop yet."],
    ['OPENING_LIMIT_REACHED', "You've reached the opening limit for this Drop."],
    ['BOX_NOT_OPENABLE', 'This Drop is currently unavailable.'],
    ['INVENTORY_UNAVAILABLE', 'This Drop is currently unavailable.'],
  ])('maps %s to fan-facing language', async (code, message) => {
    const openBox = vi.fn(() =>
      Promise.reject(
        new CreatorDropApiError(409, {
          error: {
            code,
            details: {},
            message: 'Internal product terminology must not be displayed.',
            requestId: `request-${code.toLowerCase()}`,
          },
        }),
      ),
    );
    renderAuthenticatedDrop({ openBox });
    const { confirmation, user } = await openConfirmation();
    await user.click(within(confirmation).getByRole('button', { name: 'Open Drop' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(screen.queryByText('Internal product terminology must not be displayed.')).toBeNull();
    expect(openBox).toHaveBeenCalledOnce();
  });

  it('refreshes and requires confirmation again when the Drop version is stale', async () => {
    const committed = committedVersionB();
    const stale = new CreatorDropApiError(409, {
      error: {
        code: 'OPENING_CONFIRMATION_STALE',
        details: {},
        message: 'The box version changed.',
        requestId: 'request-stale-drop',
      },
    });
    const openBox = vi.fn().mockRejectedValueOnce(stale).mockResolvedValue(committed.opening);
    const getCreatorBox = vi
      .fn()
      .mockResolvedValueOnce({
        box: openingV2BoxFixture,
        creator: publicCreatorResponseFixture.creator,
      })
      .mockResolvedValueOnce({
        box: openingV2BoxFixture,
        creator: publicCreatorResponseFixture.creator,
      })
      .mockResolvedValue({ box: committed.box, creator: publicCreatorResponseFixture.creator });
    renderAuthenticatedDrop({ getCreatorBox, openBox });
    const { confirmation, user } = await openConfirmation();
    await user.click(within(confirmation).getByRole('button', { name: 'Open Drop' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This Drop changed after you reviewed it. Check it and confirm again.',
    );
    expect(
      screen.getByRole('heading', { name: 'Open one of your available Drops?' }),
    ).toBeVisible();
    expect(screen.getByRole('heading', { level: 1, name: 'Updated Free Drop' })).toBeVisible();
    expect(openBox).toHaveBeenCalledOnce();
    expect(getCreatorBox).toHaveBeenCalledTimes(3);

    await user.click(screen.getByRole('button', { name: 'Open Drop' }));
    expect(await screen.findByRole('heading', { name: 'Unwrapping your reward…' })).toBeVisible();
    expect(openBox).toHaveBeenCalledTimes(2);
    expect(openBox.mock.calls[0]?.[2]).not.toBe(openBox.mock.calls[1]?.[2]);
    expect(openBox.mock.calls[1]?.slice(3)).toEqual([
      committed.box.version.id,
      committed.box.configurationHash,
      currentFairnessFixture.fairness.activeSeedSet.id,
      currentFairnessFixture.fairness.activeSeedSet.commitment,
    ]);
  });

  it('uses the exact refreshed v2 version for the committed reward and odds', async () => {
    const committed = committedVersionB();
    const getCreatorBox = vi
      .fn()
      .mockResolvedValueOnce({
        box: openingV2BoxFixture,
        creator: publicCreatorResponseFixture.creator,
      })
      .mockResolvedValue({ box: committed.box, creator: publicCreatorResponseFixture.creator });
    const getPublishedBoxVersion = vi.fn(() => Promise.resolve(committed.box));
    renderAuthenticatedDrop({
      getCreatorBox,
      getPublishedBoxVersion,
      openBox: () => Promise.resolve(committed.opening),
    });
    const { confirmation, user } = await openConfirmation();

    expect(within(confirmation).getByText('Updated Free Drop')).toBeVisible();
    await user.click(within(confirmation).getByRole('button', { name: 'Open Drop' }));
    await user.click(await screen.findByRole('button', { name: 'Skip to reveal' }));
    expect(await screen.findByText('Rare · 100% chance')).toBeVisible();
    expect(screen.getByRole('heading', { level: 1, name: 'Updated Free Drop' })).toBeVisible();
    expect(getCreatorBox).toHaveBeenCalledTimes(2);
    expect(getPublishedBoxVersion).not.toHaveBeenCalled();
  });

  it('recovers a v2 result whose reward exists only in its committed historical version', async () => {
    const committed = committedVersionB(true);
    const idempotencyKey = 'opening_00000000-0000-4000-8000-000000000497';
    window.sessionStorage.setItem(
      `creatordrop:opening:v1:${openingV2BoxFixture.manifest.boxId}`,
      JSON.stringify({
        clientSeed: currentFairnessFixture.fairness.clientSeed,
        expectedBoxVersionId: committed.box.version.id,
        expectedConfigurationHash: committed.box.configurationHash,
        expectedSeedSetId: currentFairnessFixture.fairness.activeSeedSet.id,
        expectedServerSeedCommitment: currentFairnessFixture.fairness.activeSeedSet.commitment,
        idempotencyKey,
        recovery: 'automatic',
        userId: authSessionResponseFixture.user.id,
      }),
    );
    const openBox = vi.fn(() => Promise.resolve(committed.opening));
    const getPublishedBoxVersion = vi.fn(() => Promise.resolve(committed.box));
    renderAuthenticatedDrop({ getPublishedBoxVersion, openBox });
    const user = userEvent.setup();

    expect(await screen.findByRole('heading', { name: 'Unwrapping your reward…' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Skip to reveal' }));
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Version B only reward' }),
    ).toBeVisible();
    expect(openBox).toHaveBeenCalledWith(
      openingV2BoxFixture.manifest.boxId,
      currentFairnessFixture.fairness.clientSeed,
      idempotencyKey,
      committed.box.version.id,
      committed.box.configurationHash,
      currentFairnessFixture.fairness.activeSeedSet.id,
      currentFairnessFixture.fairness.activeSeedSet.commitment,
    );
    expect(getPublishedBoxVersion).toHaveBeenCalledOnce();
  });

  it('fails closed and only refetches result data when the committed v2 hash mismatches', async () => {
    const committed = committedVersionB();
    const mismatched = {
      ...committed.box,
      configurationHash: 'f'.repeat(64),
      version: { ...committed.box.version, configurationHash: 'f'.repeat(64) },
    };
    const getPublishedBoxVersion = vi
      .fn()
      .mockResolvedValueOnce(mismatched)
      .mockResolvedValueOnce(committed.box);
    renderAuthenticatedDrop({
      getPublishedBoxVersion,
      openBox: () => Promise.resolve(committed.opening),
    });
    const { confirmation, user } = await openConfirmation();

    await user.click(within(confirmation).getByRole('button', { name: 'Open Drop' }));
    expect(
      await screen.findByRole('heading', { name: 'Your result is safely recorded' }),
    ).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('reward details could not be loaded');
    expect(document.querySelector('.reel-track')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Retry result data' }));
    expect(await screen.findByRole('heading', { name: 'Unwrapping your reward…' })).toBeVisible();
    expect(getPublishedBoxVersion).toHaveBeenCalledTimes(2);
  });

  it('recovers an R1B pending v2 opening after upgrade even when no entitlement remains', async () => {
    const pending = {
      clientSeed: currentFairnessFixture.fairness.clientSeed,
      expectedBoxVersionId: openingV2BoxFixture.version.id,
      expectedConfigurationHash: openingV2BoxFixture.configurationHash,
      expectedSeedSetId: currentFairnessFixture.fairness.activeSeedSet.id,
      expectedServerSeedCommitment: currentFairnessFixture.fairness.activeSeedSet.commitment,
      idempotencyKey: 'opening_019c0000-0000-7000-8000-000000000099',
      recovery: 'automatic',
      userId: authSessionResponseFixture.user.id,
    };
    // R1B used this storage-schema namespace for both opening models.
    window.sessionStorage.setItem(
      `creatordrop:opening:v1:${openingV2BoxFixture.manifest.boxId}`,
      JSON.stringify(pending),
    );
    const openBox = vi
      .fn<CreatorDropApiClient['openBox']>()
      .mockResolvedValue(openingV2ResponseFixture);
    renderAuthenticatedDrop({
      getOpeningEntitlementState: () =>
        Promise.resolve(
          availableEntitlement({
            available: false,
            remaining: '0',
            consumed: '3',
            successfulOpenings: '3',
            limitReached: true,
          }),
        ),
      openBox,
    });

    expect(await screen.findByRole('heading', { name: 'Unwrapping your reward…' })).toBeVisible();
    expect(openBox).toHaveBeenCalledExactlyOnceWith(
      openingV2BoxFixture.manifest.boxId,
      pending.clientSeed,
      pending.idempotencyKey,
      pending.expectedBoxVersionId,
      pending.expectedConfigurationHash,
      pending.expectedSeedSetId,
      pending.expectedServerSeedCommitment,
    );
  });

  it('auto-recovers an ambiguous v2 response on remount with the exact original command', async () => {
    const openBox = vi
      .fn<CreatorDropApiClient['openBox']>()
      .mockRejectedValueOnce(new Error('The response was lost.'))
      .mockResolvedValueOnce(openingV2ResponseFixture);
    const api = createTestApiClient({
      getOpeningEntitlementState: () => Promise.resolve(availableEntitlement()),
      openBox,
    });
    const auth = createTestAuthClient({ getSession: () => Promise.resolve(browserSession()) });
    const firstVisit = renderRoute(
      `/creators/creator-one/boxes/${openingV2BoxFixture.manifest.boxId}`,
      { api, auth },
    );
    const { confirmation, user } = await openConfirmation();

    await user.click(within(confirmation).getByRole('button', { name: 'Open Drop' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The response was lost.');
    const stored = window.sessionStorage.getItem(
      `creatordrop:opening:v1:${openingV2BoxFixture.manifest.boxId}`,
    );
    const original = JSON.parse(stored ?? '{}') as { readonly idempotencyKey?: string };
    firstVisit.unmount();

    renderRoute(`/creators/creator-one/boxes/${openingV2BoxFixture.manifest.boxId}`, { api, auth });
    expect(await screen.findByRole('heading', { name: 'Unwrapping your reward…' })).toBeVisible();
    expect(openBox).toHaveBeenCalledTimes(2);
    expect(openBox.mock.calls[1]?.[2]).toBe(original.idempotencyKey);
    expect(openBox.mock.calls[1]?.[1]).toBe(currentFairnessFixture.fairness.clientSeed);
  });

  it('requires user action for OPENING_RETRY_REQUIRED and reuses its original identity', async () => {
    const retryRequired = new CreatorDropApiError(409, {
      error: {
        code: 'OPENING_RETRY_REQUIRED',
        details: {},
        message: 'Internal retry message.',
        requestId: 'request-retry-required',
      },
    });
    const openBox = vi
      .fn<CreatorDropApiClient['openBox']>()
      .mockRejectedValueOnce(retryRequired)
      .mockResolvedValueOnce(openingV2ResponseFixture);
    const api = createTestApiClient({
      getOpeningEntitlementState: () => Promise.resolve(availableEntitlement()),
      openBox,
    });
    const auth = createTestAuthClient({ getSession: () => Promise.resolve(browserSession()) });
    const firstVisit = renderRoute(
      `/creators/creator-one/boxes/${openingV2BoxFixture.manifest.boxId}`,
      { api, auth },
    );
    const { confirmation, user } = await openConfirmation();

    await user.click(within(confirmation).getByRole('button', { name: 'Open Drop' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This opening needs your confirmation to retry.',
    );
    const stored = window.sessionStorage.getItem(
      `creatordrop:opening:v1:${openingV2BoxFixture.manifest.boxId}`,
    );
    const original = JSON.parse(stored ?? '{}') as {
      readonly idempotencyKey?: string;
      readonly recovery?: string;
    };
    expect(original.recovery).toBe('manual');
    firstVisit.unmount();

    renderRoute(`/creators/creator-one/boxes/${openingV2BoxFixture.manifest.boxId}`, { api, auth });
    expect(await screen.findByRole('button', { name: 'Open Drop' })).toBeVisible();
    await act(() => Promise.resolve());
    expect(openBox).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'Open Drop' }));
    await user.click(screen.getByRole('button', { name: 'Open Drop' }));
    expect(await screen.findByRole('heading', { name: 'Unwrapping your reward…' })).toBeVisible();
    expect(openBox).toHaveBeenCalledTimes(2);
    expect(openBox.mock.calls[1]?.[2]).toBe(original.idempotencyKey);
  });

  it.each([
    'OPENING_ENTITLEMENT_REQUIRED',
    'OPENING_LIMIT_REACHED',
    'BOX_NOT_OPENABLE',
    'INVENTORY_UNAVAILABLE',
  ])('clears %s recovery so revisiting cannot open automatically', async (code) => {
    const failure = new CreatorDropApiError(409, {
      error: {
        code,
        details: {},
        message: `Definitive ${code} failure.`,
        requestId: `request-${code.toLowerCase()}`,
      },
    });
    const openBox = vi
      .fn<CreatorDropApiClient['openBox']>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(openingV2ResponseFixture);
    const api = createTestApiClient({
      getOpeningEntitlementState: () => Promise.resolve(availableEntitlement()),
      openBox,
    });
    const auth = createTestAuthClient({ getSession: () => Promise.resolve(browserSession()) });
    const firstVisit = renderRoute(
      `/creators/creator-one/boxes/${openingV2BoxFixture.manifest.boxId}`,
      { api, auth },
    );
    const { confirmation, user } = await openConfirmation();

    await user.click(within(confirmation).getByRole('button', { name: 'Open Drop' }));
    expect(await screen.findByRole('alert')).toBeVisible();
    expect(
      window.sessionStorage.getItem(`creatordrop:opening:v1:${openingV2BoxFixture.manifest.boxId}`),
    ).toBeNull();
    firstVisit.unmount();

    renderRoute(`/creators/creator-one/boxes/${openingV2BoxFixture.manifest.boxId}`, { api, auth });
    expect(await screen.findByRole('button', { name: 'Open Drop' })).toBeVisible();
    await act(() => Promise.resolve());
    expect(openBox).toHaveBeenCalledOnce();
  });

  it('skips the decorative reel when reduced motion is requested', async () => {
    mockedReducedMotion.mockReturnValue(true);
    try {
      renderAuthenticatedDrop();
      const { confirmation, user } = await openConfirmation();
      await user.click(within(confirmation).getByRole('button', { name: 'Open Drop' }));

      expect(
        await screen.findByRole('heading', { level: 2, name: 'Free Drop reward' }),
      ).toBeVisible();
      expect(screen.queryByRole('heading', { name: 'Unwrapping your reward…' })).toBeNull();
    } finally {
      mockedReducedMotion.mockReturnValue(false);
    }
  });

  it('restores account-global progression from the server with readable progress text', async () => {
    const getProgression = vi.fn().mockResolvedValue({
      progression: {
        lifetimeXp: '640',
        level: '4',
        xpInLevel: '40',
        xpForNextLevel: '400',
        universalEntriesAvailable: '3',
        universalEntriesEarned: '3',
      },
    });
    const view = renderRoute('/account', {
      api: createTestApiClient({ getProgression }),
      auth: createTestAuthClient({ getSession: () => Promise.resolve(browserSession()) }),
    });
    await screen.findByRole('heading', { name: 'Level 4' });
    expect(screen.getByText('40 of 400 XP toward your next level')).toBeVisible();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuetext', '40 of 400 XP');
    expect(screen.getByText('Universal Entries available')).toBeVisible();
    view.unmount();
    renderRoute('/account', {
      api: createTestApiClient({ getProgression }),
      auth: createTestAuthClient({ getSession: () => Promise.resolve(browserSession()) }),
    });
    await screen.findByRole('heading', { name: 'Level 4' });
    expect(getProgression).toHaveBeenCalledTimes(2);
  });

  it('shows all crossed levels and explicit XP without a fulfillment obligation', async () => {
    mockedReducedMotion.mockReturnValue(true);
    const xpReward = { amount: '350', policyVersion: 'xp-v1' } as const;
    const original = requireOpeningV2Catalog(openingV2BoxFixture);
    const xpCatalog = {
      ...original,
      entries: original.entries.map((entry) => ({
        ...entry,
        rewardVersion: { ...entry.rewardVersion, rewardType: 'xp' as const, xpReward },
      })),
      manifest: {
        ...original.manifest,
        entries: original.manifest.entries.map((entry) => ({ ...entry, xpReward })),
      },
    };
    const response = {
      opening: {
        ...requireOpeningV2(openingV2ResponseFixture),
        fulfillmentStatus: 'not_required' as const,
        reward: { ...requireOpeningV2(openingV2ResponseFixture).reward, xpReward },
        progression: {
          lifetimeXp: '640',
          level: '4',
          xpInLevel: '40',
          xpForNextLevel: '400',
          universalEntriesAvailable: '3',
          universalEntriesEarned: '3',
          xpAwarded: '350',
          levelsGained: '2',
          universalEntriesGranted: '2',
        },
      },
    };
    renderAuthenticatedDrop({
      getCreatorBox: () =>
        Promise.resolve({ creator: publicCreatorResponseFixture.creator, box: xpCatalog }),
      getPublishedBoxVersion: () => Promise.resolve(xpCatalog),
      openBox: () => Promise.resolve(response),
    });
    const { confirmation, user } = await openConfirmation();
    await user.click(within(confirmation).getByRole('button', { name: 'Open Drop' }));
    await screen.findByRole('heading', { name: '+350 XP', level: 2 });
    expect(screen.getByText('+2 Universal Entries · 2 levels gained')).toBeVisible();
    expect(screen.getByText('XP added to your account')).toBeVisible();
    expect(screen.queryByText('Reward ready for fulfillment')).not.toBeInTheDocument();
    expect(screen.queryByText(/Universal Entry used/)).not.toBeInTheDocument();
  });

  it('explains Universal Entry fallback and shows only the server-confirmed consumption', async () => {
    mockedReducedMotion.mockReturnValue(true);
    const response = {
      opening: {
        ...requireOpeningV2(openingV2ResponseFixture),
        entitlement: {
          ...requireOpeningV2(openingV2ResponseFixture).entitlement,
          remaining: '0',
          source: 'universal' as const,
          universalEntriesRemaining: '1',
        },
      },
    };
    const openBox = vi.fn().mockResolvedValue(response);
    renderAuthenticatedDrop({
      getOpeningEntitlementState: () =>
        Promise.resolve(
          availableEntitlement({
            remaining: '0',
            source: 'universal',
            universalEntriesAvailable: '2',
          }),
        ),
      openBox,
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Use Universal Entry' }));
    const heading = await screen.findByRole('heading', {
      name: 'Use one Universal Entry on this Drop?',
    });
    const section = heading.closest('section');
    if (section === null) throw new Error('Expected confirmation');
    await user.click(within(section).getByRole('button', { name: 'Use Universal Entry' }));
    await screen.findByText('Universal Entry used · 1 remaining');
    expect(openBox).toHaveBeenCalledOnce();
    expect(JSON.stringify(openBox.mock.calls)).not.toContain('universalEntries');
  });

  it('restores a protected account without wallet or test-credit controls', async () => {
    renderRoute('/account', {
      api: createTestApiClient(),
      auth: createTestAuthClient({ getSession: () => Promise.resolve(browserSession()) }),
    });

    expect(
      await screen.findByRole('heading', { name: authSessionResponseFixture.user.username }),
    ).toBeVisible();
    expect(screen.getByText(/see and open your available Drops/iu)).toBeVisible();
    expect(screen.queryByText(/wallet|credit|fund|payment|balance/iu)).toBeNull();
  });

  it('covers public not-found and catalog empty states', async () => {
    const { unmount } = renderRoute('/missing');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeVisible();
    unmount();

    renderRoute('/creators/creator-one', {
      api: createTestApiClient({
        getCreator: () => Promise.resolve(publicCreatorResponseFixture),
        listCreatorBoxes: () => Promise.resolve({ boxes: [], nextCursor: null }),
      }),
    });
    expect(await screen.findByRole('heading', { name: 'No active drops' })).toBeVisible();
  });

  it('covers catalog loading and retryable error states', async () => {
    const pending = deferred<PublicCreatorsResponse>();
    const loading = renderRoute('/creators', {
      api: createTestApiClient({ listCreators: () => pending.promise }),
    });
    expect(screen.getByRole('status')).toHaveTextContent('Loading creators');
    loading.unmount();

    renderRoute('/creators', {
      api: createTestApiClient({
        listCreators: () => Promise.reject(new Error('The network is unavailable.')),
      }),
    });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The network is unavailable.');
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  it('restores an authenticated session before protected content renders', async () => {
    const restored = deferred<ReturnType<typeof browserSession>>();
    renderRoute('/account', {
      auth: createTestAuthClient({ getSession: () => restored.promise }),
    });

    expect(await screen.findByText(/Restoring your session/u)).toBeVisible();
    expect(screen.queryByText(authSessionResponseFixture.user.username)).toBeNull();
    act(() => restored.resolve(browserSession()));
    expect(
      await screen.findByRole('heading', { name: authSessionResponseFixture.user.username }),
    ).toBeVisible();
  });

  it('clears an invalid restored session and keeps protected routes private', async () => {
    const signOut = vi.fn(() => Promise.resolve());
    const expired = new CreatorDropApiError(401, {
      error: {
        code: 'AUTHENTICATION_REQUIRED',
        details: {},
        message: 'Authentication is required.',
        requestId: 'request-expired',
      },
    });
    renderRoute('/account', {
      api: createTestApiClient({ exchangeSession: () => Promise.reject(expired) }),
      auth: createTestAuthClient({
        getSession: () => Promise.resolve(browserSession('expired-token')),
        signOut,
      }),
    });

    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeVisible();
    expect(signOut).toHaveBeenCalledOnce();
    expect(screen.queryByText(authSessionResponseFixture.user.username)).toBeNull();
  });

  it('supports accessible sign-in and sign-out transitions', async () => {
    const signOut = vi.fn(() => Promise.resolve());
    const auth = createTestAuthClient({
      signIn: () =>
        Promise.resolve({ confirmationRequired: false, session: browserSession('signed-in') }),
      signOut,
    });
    const user = userEvent.setup();
    renderRoute('/auth', { auth });

    await user.type(await screen.findByLabelText('Email address'), 'fan@example.test');
    await user.type(screen.getByLabelText('Password'), 'safe-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(
      await screen.findByRole('heading', { name: authSessionResponseFixture.user.username }),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeVisible();
    expect(signOut).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'Show account creation form' }));
    await user.type(screen.getByLabelText('Email address'), 'new-fan@example.test');
    await user.type(screen.getByLabelText('Password'), 'another-safe-password');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Check your email');
  });

  it('surfaces accessible auth form failures', async () => {
    const user = userEvent.setup();
    renderRoute('/auth', {
      auth: createTestAuthClient({ signIn: () => Promise.reject(new Error('Sign in failed.')) }),
    });

    await user.type(await screen.findByLabelText('Email address'), 'fan@example.test');
    await user.type(screen.getByLabelText('Password'), 'safe-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign in failed.');
  });

  it('does not replay another user session pending Drop command', async () => {
    const openBox = vi.fn(() => Promise.resolve(openingV2ResponseFixture));
    window.sessionStorage.setItem(
      `creatordrop:opening:v1:${openingV2BoxFixture.manifest.boxId}`,
      JSON.stringify({
        clientSeed: currentFairnessFixture.fairness.clientSeed,
        expectedBoxVersionId: openingV2BoxFixture.version.id,
        expectedConfigurationHash: openingV2BoxFixture.configurationHash,
        expectedSeedSetId: currentFairnessFixture.fairness.activeSeedSet.id,
        expectedServerSeedCommitment: currentFairnessFixture.fairness.activeSeedSet.commitment,
        idempotencyKey: 'opening_00000000-0000-4000-8000-000000000999',
        recovery: 'automatic',
        userId: '00000000-0000-4000-8000-000000000999',
      }),
    );
    renderAuthenticatedDrop({ openBox });

    await waitFor(() => expect(screen.getByText('3 Drops available')).toBeVisible());
    expect(openBox).not.toHaveBeenCalled();
  });
});
