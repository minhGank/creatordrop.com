// @vitest-environment jsdom

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import type {
  BoxOpeningResponse,
  OpeningFairnessProofResponse,
  PublishedBoxVersionResponse,
  PublicCreatorsResponse,
} from '@creatordrop/contracts';

import { ApiProvider } from '../src/api/api-context.js';
import { CreatorDropApiError } from '../src/api/client.js';
import { SessionProvider } from '../src/auth/session-context.js';
import { AppRoutes } from '../src/app.js';
import { calculateReelWinnerTranslation } from '../src/components/reel-geometry.js';
import {
  authSessionResponseFixture,
  boxOpeningFixture,
  currentFairnessFixture,
  pendingOpeningProofFixture,
  publicCreatorBoxesResponseFixture,
  publicCreatorResponseFixture,
  publishedBoxFixture,
} from './fixtures.js';
import { browserSession, createTestApiClient, createTestAuthClient } from './test-clients.js';

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

const committedVersionB = (
  options: { readonly priceMinor?: string; readonly uniqueWinner?: boolean } = {},
): { readonly box: PublishedBoxVersionResponse; readonly opening: BoxOpeningResponse } => {
  const versionId = '00000000-0000-4000-8000-000000000105';
  const first = publishedBoxFixture.entries[0];
  const second = publishedBoxFixture.entries[1];
  if (first === undefined || second === undefined) throw new Error('Expected two catalog entries.');
  const winnerRewardVersion = options.uniqueWinner
    ? {
        ...first.rewardVersion,
        id: '00000000-0000-4000-8000-000000000305',
        name: 'Version B only reward',
      }
    : first.rewardVersion;
  const entries: PublishedBoxVersionResponse['entries'] = [
    {
      ...first,
      id: '00000000-0000-4000-8000-000000000205',
      rarity: 'common',
      rarityPolicyVersion: 'rarity-v1',
      rewardVersion: winnerRewardVersion,
      weight: '200',
    },
    {
      ...second,
      id: '00000000-0000-4000-8000-000000000206',
      rarity: 'common',
      rarityPolicyVersion: 'rarity-v1',
      weight: '800',
    },
  ];
  const configurationHash = 'e'.repeat(64);
  const priceMinor = options.priceMinor ?? '10000';
  const box: PublishedBoxVersionResponse = {
    configurationHash,
    entries,
    manifest: {
      ...publishedBoxFixture.manifest,
      boxVersionId: versionId,
      entries: entries.map((entry) => ({
        boxVersionRewardId: entry.id,
        position: entry.position,
        rewardVersionId: entry.rewardVersion.id,
        weight: entry.weight,
      })),
      priceMinor,
      totalWeight: '1000',
    },
    version: {
      ...publishedBoxFixture.version,
      configurationHash,
      id: versionId,
      name: 'Second Drop',
      priceMinor,
      totalWeight: '1000',
      versionNumber: 3,
    },
  };
  const opening: BoxOpeningResponse = {
    opening: {
      ...boxOpeningFixture.opening,
      boxVersionId: versionId,
      cost: { currency: box.version.currency, priceMinor },
      fairness: { ...boxOpeningFixture.opening.fairness, configurationHash },
      pointsAwarded: 5,
      reward: {
        ...boxOpeningFixture.opening.reward,
        imageUrl: winnerRewardVersion.imageUrl,
        name: winnerRewardVersion.name,
        rarity: 'common',
        rarityPolicyVersion: 'rarity-v1',
        rewardVersionId: winnerRewardVersion.id,
      },
    },
  };
  return { box, opening };
};

const pendingProofFor = (
  committed: ReturnType<typeof committedVersionB>,
): OpeningFairnessProofResponse => {
  const winner = committed.box.entries.find(
    (entry) => entry.rewardVersion.id === committed.opening.opening.reward.rewardVersionId,
  );
  if (winner === undefined) throw new Error('Expected the committed winner entry.');
  return {
    proof: {
      ...pendingOpeningProofFixture.proof,
      configurationHash: committed.box.configurationHash,
      manifest: committed.box.manifest,
      openingId: committed.opening.opening.id,
      recorded: {
        ...pendingOpeningProofFixture.proof.recorded,
        boxVersionRewardId: winner.id,
        position: winner.position,
        rewardVersionId: winner.rewardVersion.id,
      },
    },
  };
};

describe('Phase 14 web shell', () => {
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

  it('renders creator boxes and immutable box details with safe money and non-zero tiny odds', async () => {
    const user = userEvent.setup();
    const getCreatorBox = vi.fn(() =>
      Promise.resolve({ box: publishedBoxFixture, creator: publicCreatorResponseFixture.creator }),
    );
    renderRoute('/creators/creator-one', {
      api: createTestApiClient({
        getCreator: () => Promise.resolve(publicCreatorResponseFixture),
        getCreatorBox,
        listCreatorBoxes: () => Promise.resolve(publicCreatorBoxesResponseFixture),
      }),
    });

    const boxLink = await screen.findByRole('link', { name: /First Drop/u });
    expect(boxLink).toHaveTextContent('$9.99');
    await user.click(boxLink);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'First Drop' }),
    ).toBeInTheDocument();
    expect(screen.getByText('<0.000001%')).toBeInTheDocument();
    expect(screen.getByText('Base reward', { selector: '.base-label' })).toBeInTheDocument();
    expect(screen.getByText(publishedBoxFixture.configurationHash)).toBeInTheDocument();
    expect(getCreatorBox).toHaveBeenCalledWith(
      publicCreatorResponseFixture.creator.customSlug,
      publishedBoxFixture.manifest.boxId,
      expect.any(AbortSignal),
    );
    expect(screen.getByRole('link', { name: /Back to Creator One/u })).toHaveAttribute(
      'href',
      '/creators/creator-one',
    );
    expect(screen.queryByRole('button', { name: /open/i })).not.toBeInTheDocument();
  });

  it('opens once, reuses one idempotency key after a lost response, and reveals the committed result', async () => {
    const user = userEvent.setup();
    const openBox = vi
      .fn()
      .mockRejectedValueOnce(new Error('The response was lost.'))
      .mockResolvedValue(boxOpeningFixture);
    renderRoute('/creators/creator-one/boxes/00000000-0000-4000-8000-000000000101', {
      api: createTestApiClient({
        getCurrentFairness: () => Promise.resolve(currentFairnessFixture),
        getOpeningFairnessProof: () => Promise.resolve(pendingOpeningProofFixture),
        openBox,
      }),
      auth: createTestAuthClient({ getSession: () => Promise.resolve(browserSession()) }),
    });

    await user.click(await screen.findByRole('button', { name: 'Open this box' }));
    expect(screen.getByRole('heading', { name: 'Open First Drop?' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Confirm and open' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The response was lost.');
    await user.click(screen.getByRole('button', { name: 'Confirm and open' }));
    expect(
      await screen.findByRole('heading', { name: 'Unwrapping your reward…' }),
    ).toBeInTheDocument();
    const reelItems = document.querySelectorAll('.reel-track > li');
    expect(reelItems).toHaveLength(20);
    expect(reelItems[16]).toHaveClass('rarity-common');
    await user.click(screen.getByRole('button', { name: 'Skip to reveal' }));

    const resultHeading = await screen.findByRole('heading', { level: 2, name: 'Base reward' });
    expect(resultHeading).toHaveFocus();
    expect(screen.getByText('+20 points')).toBeInTheDocument();
    expect(screen.getByText(/Full independent verification is waiting/u)).toBeInTheDocument();
    expect(openBox).toHaveBeenCalledTimes(2);
    expect(openBox.mock.calls[0]?.[2]).toBe(openBox.mock.calls[1]?.[2]);
    expect(openBox.mock.calls[0]?.[1]).toBe(currentFairnessFixture.fairness.clientSeed);
  });

  it('collapses duplicate confirmation clicks into one opening command', async () => {
    const pending = deferred<BoxOpeningResponse>();
    const openBox = vi.fn(() => pending.promise);
    const user = userEvent.setup();
    renderRoute('/creators/creator-one/boxes/00000000-0000-4000-8000-000000000101', {
      api: createTestApiClient({ openBox }),
      auth: createTestAuthClient({ getSession: () => Promise.resolve(browserSession()) }),
    });

    await user.click(await screen.findByRole('button', { name: 'Open this box' }));
    await user.dblClick(screen.getByRole('button', { name: 'Confirm and open' }));
    expect(openBox).toHaveBeenCalledOnce();
    act(() => pending.resolve(boxOpeningFixture));
    expect(
      await screen.findByRole('heading', { name: 'Unwrapping your reward…' }),
    ).toBeInTheDocument();
  });

  it.each([
    [16, 375],
    [16, 1440],
    [18, 375],
    [18, 1440],
    [20, 375],
    [20, 1440],
  ])(
    'measures the committed reel winner at %ipx root sizing and %ipx viewport width',
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
        const user = userEvent.setup();
        renderRoute('/creators/creator-one/boxes/00000000-0000-4000-8000-000000000101', {
          auth: createTestAuthClient({ getSession: () => Promise.resolve(browserSession()) }),
        });
        await user.click(await screen.findByRole('button', { name: 'Open this box' }));
        await user.click(screen.getByRole('button', { name: 'Confirm and open' }));
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

  it('reveals a normal committed reward with its immutable rarity, exact odds, and 5 points', async () => {
    const entries = publishedBoxFixture.entries.map((entry, index) =>
      index === 0
        ? { ...entry, rarity: 'legendary' as const, rarityPolicyVersion: 'rarity-v1' as const }
        : entry,
    );
    const box = { ...publishedBoxFixture, entries };
    const first = entries[0];
    const response: BoxOpeningResponse = {
      opening: {
        ...boxOpeningFixture.opening,
        pointsAwarded: 5,
        reward: {
          ...boxOpeningFixture.opening.reward,
          name: first?.rewardVersion.name ?? 'Rare reward',
          rarity: 'legendary',
          rarityPolicyVersion: 'rarity-v1',
          rewardVersionId:
            first?.rewardVersion.id ?? boxOpeningFixture.opening.reward.rewardVersionId,
        },
      },
    };
    const user = userEvent.setup();
    renderRoute('/creators/creator-one/boxes/00000000-0000-4000-8000-000000000101', {
      api: createTestApiClient({
        getCreatorBox: () =>
          Promise.resolve({ box, creator: publicCreatorResponseFixture.creator }),
        openBox: () => Promise.resolve(response),
      }),
      auth: createTestAuthClient({ getSession: () => Promise.resolve(browserSession()) }),
    });

    await user.click(await screen.findByRole('button', { name: 'Open this box' }));
    await user.click(screen.getByRole('button', { name: 'Confirm and open' }));
    await user.click(await screen.findByRole('button', { name: 'Skip to reveal' }));

    const heading = await screen.findByRole('heading', { level: 2, name: 'Rare reward' });
    const result = heading.closest('section');
    if (result === null) throw new Error('Expected the opening result section.');
    expect(within(result).getByText('Legendary')).toBeInTheDocument();
    expect(within(result).getByText('<0.000001%')).toBeInTheDocument();
    expect(within(result).getByText('+5 points')).toBeInTheDocument();
  });

  it('uses the exact committed version when publication changes rarity and odds after page load', async () => {
    const committed = committedVersionB();
    const getCreatorBox = vi
      .fn()
      .mockResolvedValueOnce({
        box: publishedBoxFixture,
        creator: publicCreatorResponseFixture.creator,
      })
      .mockResolvedValue({
        box: committed.box,
        creator: publicCreatorResponseFixture.creator,
      });
    const getPublishedBoxVersion = vi.fn(() => Promise.resolve(committed.box));
    const openBox = vi.fn(() => Promise.resolve(committed.opening));
    const user = userEvent.setup();
    renderRoute('/creators/creator-one/boxes/00000000-0000-4000-8000-000000000101', {
      api: createTestApiClient({
        getCreatorBox,
        getOpeningFairnessProof: () => Promise.resolve(pendingProofFor(committed)),
        getPublishedBoxVersion,
        openBox,
      }),
      auth: createTestAuthClient({ getSession: () => Promise.resolve(browserSession()) }),
    });

    await user.click(await screen.findByRole('button', { name: 'Open this box' }));
    const confirmationHeading = await screen.findByRole('heading', { name: 'Open Second Drop?' });
    const confirmation = confirmationHeading.closest('section');
    if (confirmation === null) throw new Error('Expected the opening confirmation section.');
    expect(within(confirmation).getByText(/\$100\.00/u)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Confirm and open' }));
    expect(
      await screen.findByRole('heading', { name: 'Unwrapping your reward…' }),
    ).toBeInTheDocument();
    expect(document.querySelector('.reel-track > [data-reel-winner="true"]')).toHaveClass(
      'rarity-common',
    );
    await user.click(screen.getByRole('button', { name: 'Skip to reveal' }));

    const heading = await screen.findByRole('heading', { level: 2, name: 'Rare reward' });
    const result = heading.closest('section');
    if (result === null) throw new Error('Expected the opening result section.');
    expect(within(result).getByText('Common')).toBeInTheDocument();
    expect(within(result).getByText('20.00%')).toBeInTheDocument();
    expect(within(result).getByText(/published version 3/u)).toBeInTheDocument();
    expect(within(result).getByText(/\$100\.00/u)).toBeInTheDocument();
    expect(within(result).queryByText('<0.000001%')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Second Drop' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: 'First Drop' })).not.toBeInTheDocument();
    expect(await within(result).findByText(committed.box.configurationHash)).toBeInTheDocument();
    expect(getCreatorBox).toHaveBeenCalledTimes(2);
    expect(getPublishedBoxVersion).not.toHaveBeenCalled();
    expect(openBox).toHaveBeenCalledWith(
      committed.opening.opening.boxId,
      currentFairnessFixture.fairness.clientSeed,
      expect.stringMatching(/^opening_/u),
      committed.box.version.id,
      committed.box.configurationHash,
    );
  });

  it('requires fresh confirmation when the authoritative version changes after confirmation', async () => {
    const committed = committedVersionB();
    const creatorBoxA = {
      box: publishedBoxFixture,
      creator: publicCreatorResponseFixture.creator,
    };
    const creatorBoxB = {
      box: committed.box,
      creator: publicCreatorResponseFixture.creator,
    };
    const getCreatorBox = vi
      .fn()
      .mockResolvedValueOnce(creatorBoxA)
      .mockResolvedValueOnce(creatorBoxA)
      .mockResolvedValue(creatorBoxB);
    const stale = new CreatorDropApiError(409, {
      error: {
        code: 'OPENING_CONFIRMATION_STALE',
        details: {},
        message: 'The box changed after it was loaded.',
        requestId: 'request-stale-confirmation',
      },
    });
    const openBox = vi.fn().mockRejectedValueOnce(stale).mockResolvedValue(committed.opening);
    const user = userEvent.setup();
    renderRoute('/creators/creator-one/boxes/00000000-0000-4000-8000-000000000101', {
      api: createTestApiClient({ getCreatorBox, openBox }),
      auth: createTestAuthClient({ getSession: () => Promise.resolve(browserSession()) }),
    });

    await user.click(await screen.findByRole('button', { name: 'Open this box' }));
    const firstConfirmationHeading = await screen.findByRole('heading', {
      name: 'Open First Drop?',
    });
    const firstConfirmation = firstConfirmationHeading.closest('section');
    if (firstConfirmation === null) throw new Error('Expected the opening confirmation section.');
    expect(within(firstConfirmation).getByText(/\$9\.99/u)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Confirm and open' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('box changed');
    const secondConfirmationHeading = screen.getByRole('heading', { name: 'Open Second Drop?' });
    const secondConfirmation = secondConfirmationHeading.closest('section');
    if (secondConfirmation === null) throw new Error('Expected the updated confirmation section.');
    expect(within(secondConfirmation).getByText(/\$100\.00/u)).toBeInTheDocument();
    expect(openBox).toHaveBeenCalledOnce();

    await user.click(screen.getByRole('button', { name: 'Confirm and open' }));
    expect(
      await screen.findByRole('heading', { name: 'Unwrapping your reward…' }),
    ).toBeInTheDocument();
    expect(openBox).toHaveBeenCalledTimes(2);
    expect(openBox.mock.calls[0]?.[2]).not.toBe(openBox.mock.calls[1]?.[2]);
    expect(openBox.mock.calls[1]?.slice(3)).toEqual([
      committed.box.version.id,
      committed.box.configurationHash,
    ]);
  });

  it('recovers an idempotent Version B opening whose reward does not exist in loaded Version A', async () => {
    const committed = committedVersionB({ uniqueWinner: true });
    const idempotencyKey = 'opening_00000000-0000-4000-8000-000000000497';
    window.sessionStorage.setItem(
      `creatordrop:opening:v1:${publishedBoxFixture.manifest.boxId}`,
      JSON.stringify({
        clientSeed: currentFairnessFixture.fairness.clientSeed,
        expectedBoxVersionId: committed.box.version.id,
        expectedConfigurationHash: committed.box.configurationHash,
        idempotencyKey,
        recovery: 'automatic',
        userId: authSessionResponseFixture.user.id,
      }),
    );
    const openBox = vi.fn(() => Promise.resolve(committed.opening));
    const getPublishedBoxVersion = vi.fn(() => Promise.resolve(committed.box));
    const user = userEvent.setup();
    renderRoute('/creators/creator-one/boxes/00000000-0000-4000-8000-000000000101', {
      api: createTestApiClient({
        getOpeningFairnessProof: () => Promise.resolve(pendingProofFor(committed)),
        getPublishedBoxVersion,
        openBox,
      }),
      auth: createTestAuthClient({ getSession: () => Promise.resolve(browserSession()) }),
    });

    expect(
      await screen.findByRole('heading', { name: 'Unwrapping your reward…' }),
    ).toBeInTheDocument();
    expect(document.querySelectorAll('.reel-track > li')).toHaveLength(20);
    await user.click(screen.getByRole('button', { name: 'Skip to reveal' }));
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Version B only reward' }),
    ).toBeInTheDocument();
    expect(openBox).toHaveBeenCalledWith(
      publishedBoxFixture.manifest.boxId,
      currentFairnessFixture.fairness.clientSeed,
      idempotencyKey,
      committed.box.version.id,
      committed.box.configurationHash,
    );
    expect(getPublishedBoxVersion).toHaveBeenCalledOnce();
  });

  it('fails closed and only refetches result data when the committed version hash mismatches', async () => {
    const committed = committedVersionB();
    const mismatched = {
      ...committed.box,
      configurationHash: 'f'.repeat(64),
      version: { ...committed.box.version, configurationHash: 'f'.repeat(64) },
    };
    const openBox = vi.fn(() => Promise.resolve(committed.opening));
    const getPublishedBoxVersion = vi
      .fn()
      .mockResolvedValueOnce(mismatched)
      .mockResolvedValueOnce(committed.box);
    const user = userEvent.setup();
    renderRoute('/creators/creator-one/boxes/00000000-0000-4000-8000-000000000101', {
      api: createTestApiClient({ getPublishedBoxVersion, openBox }),
      auth: createTestAuthClient({ getSession: () => Promise.resolve(browserSession()) }),
    });

    await user.click(await screen.findByRole('button', { name: 'Open this box' }));
    await user.click(screen.getByRole('button', { name: 'Confirm and open' }));
    expect(
      await screen.findByRole('heading', { name: 'Your result is safely recorded' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('opening is committed');
    expect(document.querySelector('.reel-track')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Retry result data' }));
    expect(
      await screen.findByRole('heading', { name: 'Unwrapping your reward…' }),
    ).toBeInTheDocument();
    expect(getPublishedBoxVersion).toHaveBeenCalledTimes(2);
    expect(openBox).toHaveBeenCalledOnce();
  });

  it.each([
    ['INSUFFICIENT_BALANCE', 'Your wallet does not have enough funds.'],
    ['BOX_NOT_OPENABLE', 'This box is not currently available.'],
    ['INVENTORY_UNAVAILABLE', 'The selected reward is unavailable.'],
    ['OPENING_RETRY_REQUIRED', 'Please retry this opening with the same request.'],
  ])('shows %s without inventing or automatically retrying a result', async (code, message) => {
    const openBox = vi.fn(() =>
      Promise.reject(
        new CreatorDropApiError(409, {
          error: { code, details: {}, message, requestId: `request-${code.toLowerCase()}` },
        }),
      ),
    );
    const user = userEvent.setup();
    renderRoute('/creators/creator-one/boxes/00000000-0000-4000-8000-000000000101', {
      api: createTestApiClient({ openBox }),
      auth: createTestAuthClient({ getSession: () => Promise.resolve(browserSession()) }),
    });

    await user.click(await screen.findByRole('button', { name: 'Open this box' }));
    await user.click(screen.getByRole('button', { name: 'Confirm and open' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(screen.queryByText('Your reward')).not.toBeInTheDocument();
    expect(openBox).toHaveBeenCalledOnce();
  });

  it.each(['INSUFFICIENT_BALANCE', 'BOX_NOT_OPENABLE', 'INVENTORY_UNAVAILABLE'])(
    'clears %s recovery so revisiting cannot purchase automatically',
    async (code) => {
      const failure = new CreatorDropApiError(409, {
        error: {
          code,
          details: {},
          message: `Definitive ${code} failure.`,
          requestId: `request-${code.toLowerCase()}`,
        },
      });
      const openBox = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(boxOpeningFixture);
      const api = createTestApiClient({ openBox });
      const auth = createTestAuthClient({ getSession: () => Promise.resolve(browserSession()) });
      const user = userEvent.setup();
      const firstVisit = renderRoute(
        '/creators/creator-one/boxes/00000000-0000-4000-8000-000000000101',
        { api, auth },
      );

      await user.click(await screen.findByRole('button', { name: 'Open this box' }));
      await user.click(screen.getByRole('button', { name: 'Confirm and open' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(code);
      expect(
        window.sessionStorage.getItem(
          `creatordrop:opening:v1:${publishedBoxFixture.manifest.boxId}`,
        ),
      ).toBeNull();
      firstVisit.unmount();

      renderRoute('/creators/creator-one/boxes/00000000-0000-4000-8000-000000000101', {
        api,
        auth,
      });
      expect(await screen.findByRole('button', { name: 'Open this box' })).toBeInTheDocument();
      await act(() => Promise.resolve());
      expect(openBox).toHaveBeenCalledOnce();
    },
  );

  it('auto-recovers an ambiguous lost response on remount with the exact original command', async () => {
    const openBox = vi
      .fn()
      .mockRejectedValueOnce(new Error('The response was lost.'))
      .mockResolvedValue(boxOpeningFixture);
    const api = createTestApiClient({ openBox });
    const auth = createTestAuthClient({ getSession: () => Promise.resolve(browserSession()) });
    const user = userEvent.setup();
    const firstVisit = renderRoute(
      '/creators/creator-one/boxes/00000000-0000-4000-8000-000000000101',
      { api, auth },
    );

    await user.click(await screen.findByRole('button', { name: 'Open this box' }));
    await user.click(screen.getByRole('button', { name: 'Confirm and open' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('response was lost');
    const stored = window.sessionStorage.getItem(
      `creatordrop:opening:v1:${publishedBoxFixture.manifest.boxId}`,
    );
    expect(stored).not.toBeNull();
    const original = JSON.parse(stored ?? '{}') as { readonly idempotencyKey?: string };
    firstVisit.unmount();

    renderRoute('/creators/creator-one/boxes/00000000-0000-4000-8000-000000000101', {
      api,
      auth,
    });
    expect(
      await screen.findByRole('heading', { name: 'Unwrapping your reward…' }),
    ).toBeInTheDocument();
    expect(openBox).toHaveBeenCalledTimes(2);
    expect(openBox.mock.calls[1]?.[2]).toBe(original.idempotencyKey);
    expect(openBox.mock.calls[1]?.[1]).toBe(currentFairnessFixture.fairness.clientSeed);
  });

  it('requires user action for OPENING_RETRY_REQUIRED and reuses its original identity', async () => {
    const retryRequired = new CreatorDropApiError(409, {
      error: {
        code: 'OPENING_RETRY_REQUIRED',
        details: {},
        message: 'Please retry this opening with the same request.',
        requestId: 'request-retry-required',
      },
    });
    const openBox = vi
      .fn()
      .mockRejectedValueOnce(retryRequired)
      .mockResolvedValue(boxOpeningFixture);
    const api = createTestApiClient({ openBox });
    const auth = createTestAuthClient({ getSession: () => Promise.resolve(browserSession()) });
    const user = userEvent.setup();
    const firstVisit = renderRoute(
      '/creators/creator-one/boxes/00000000-0000-4000-8000-000000000101',
      { api, auth },
    );

    await user.click(await screen.findByRole('button', { name: 'Open this box' }));
    await user.click(screen.getByRole('button', { name: 'Confirm and open' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('same request');
    const stored = window.sessionStorage.getItem(
      `creatordrop:opening:v1:${publishedBoxFixture.manifest.boxId}`,
    );
    const original = JSON.parse(stored ?? '{}') as {
      readonly idempotencyKey?: string;
      readonly recovery?: string;
    };
    expect(original.recovery).toBe('manual');
    firstVisit.unmount();

    renderRoute('/creators/creator-one/boxes/00000000-0000-4000-8000-000000000101', {
      api,
      auth,
    });
    expect(await screen.findByRole('button', { name: 'Open this box' })).toBeInTheDocument();
    await act(() => Promise.resolve());
    expect(openBox).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'Open this box' }));
    await user.click(screen.getByRole('button', { name: 'Confirm and open' }));
    expect(
      await screen.findByRole('heading', { name: 'Unwrapping your reward…' }),
    ).toBeInTheDocument();
    expect(openBox).toHaveBeenCalledTimes(2);
    expect(openBox.mock.calls[1]?.[2]).toBe(original.idempotencyKey);
  });

  it('skips the decorative reel when reduced motion is requested', async () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        addEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
        matches: query === '(prefers-reduced-motion: reduce)',
        media: query,
        onchange: null,
        removeEventListener: vi.fn(),
      })),
    });
    const user = userEvent.setup();
    renderRoute('/creators/creator-one/boxes/00000000-0000-4000-8000-000000000101', {
      auth: createTestAuthClient({ getSession: () => Promise.resolve(browserSession()) }),
    });

    await user.click(await screen.findByRole('button', { name: 'Open this box' }));
    await user.click(screen.getByRole('button', { name: 'Confirm and open' }));

    expect(
      await screen.findByRole('heading', { level: 2, name: 'Base reward' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Unwrapping your reward…' }),
    ).not.toBeInTheDocument();
  });

  it('recovers a refreshed lost response with the persisted opening identity', async () => {
    const idempotencyKey = 'opening_00000000-0000-4000-8000-000000000499';
    window.sessionStorage.setItem(
      `creatordrop:opening:v1:${publishedBoxFixture.manifest.boxId}`,
      JSON.stringify({
        clientSeed: currentFairnessFixture.fairness.clientSeed,
        expectedBoxVersionId: publishedBoxFixture.version.id,
        expectedConfigurationHash: publishedBoxFixture.configurationHash,
        idempotencyKey,
        recovery: 'automatic',
        userId: authSessionResponseFixture.user.id,
      }),
    );
    const openBox = vi.fn(() => Promise.resolve(boxOpeningFixture));
    renderRoute('/creators/creator-one/boxes/00000000-0000-4000-8000-000000000101', {
      api: createTestApiClient({ openBox }),
      auth: createTestAuthClient({ getSession: () => Promise.resolve(browserSession()) }),
    });

    expect(
      await screen.findByRole('heading', { name: 'Unwrapping your reward…' }),
    ).toBeInTheDocument();
    expect(openBox).toHaveBeenCalledOnce();
    expect(openBox).toHaveBeenCalledWith(
      publishedBoxFixture.manifest.boxId,
      currentFairnessFixture.fairness.clientSeed,
      idempotencyKey,
      publishedBoxFixture.version.id,
      publishedBoxFixture.configurationHash,
    );
  });

  it("never replays another user session's pending opening", async () => {
    window.sessionStorage.setItem(
      `creatordrop:opening:v1:${publishedBoxFixture.manifest.boxId}`,
      JSON.stringify({
        clientSeed: currentFairnessFixture.fairness.clientSeed,
        expectedBoxVersionId: publishedBoxFixture.version.id,
        expectedConfigurationHash: publishedBoxFixture.configurationHash,
        idempotencyKey: 'opening_00000000-0000-4000-8000-000000000498',
        recovery: 'automatic',
        userId: '00000000-0000-4000-8000-000000000497',
      }),
    );
    const openBox = vi.fn(() => Promise.resolve(boxOpeningFixture));
    renderRoute('/creators/creator-one/boxes/00000000-0000-4000-8000-000000000101', {
      api: createTestApiClient({ openBox }),
      auth: createTestAuthClient({ getSession: () => Promise.resolve(browserSession()) }),
    });

    expect(await screen.findByRole('button', { name: 'Open this box' })).toBeInTheDocument();
    expect(openBox).not.toHaveBeenCalled();
  });

  it('covers loading, empty, retryable failure, and public 404 states', async () => {
    const pending = deferred<PublicCreatorsResponse>();
    const loading = renderRoute('/creators', {
      api: createTestApiClient({ listCreators: () => pending.promise }),
    });
    expect(screen.getByRole('status')).toHaveTextContent('Loading creators');
    loading.unmount();

    renderRoute('/creators', {
      api: createTestApiClient({
        listCreators: () => Promise.resolve({ creators: [], nextCursor: null }),
      }),
    });
    expect(
      await screen.findByRole('heading', { name: 'No public creators yet' }),
    ).toBeInTheDocument();

    const failure = new Error('The network is unavailable.');
    renderRoute('/creators', {
      api: createTestApiClient({ listCreators: () => Promise.reject(failure) }),
    });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The network is unavailable.');
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeInTheDocument();

    const notFound = new CreatorDropApiError(404, {
      error: {
        code: 'CATALOG_RESOURCE_NOT_FOUND',
        details: {},
        message: 'Not found.',
        requestId: 'request-not-found',
      },
    });
    renderRoute('/creators/creator-one/boxes/00000000-0000-4000-8000-000000000101', {
      api: createTestApiClient({ getCreatorBox: () => Promise.reject(notFound) }),
    });
    expect(await screen.findByRole('heading', { name: 'Not found' })).toBeInTheDocument();
  });

  it('restores an authenticated session before protected content can render', async () => {
    const restored = deferred<ReturnType<typeof browserSession>>();
    const auth = createTestAuthClient({ getSession: () => restored.promise });
    renderRoute('/account', { auth });

    expect(await screen.findByText(/Restoring your session/u)).toBeInTheDocument();
    expect(screen.queryByText(authSessionResponseFixture.user.username)).not.toBeInTheDocument();
    act(() => restored.resolve(browserSession()));
    expect(
      await screen.findByRole('heading', { name: authSessionResponseFixture.user.username }),
    ).toBeInTheDocument();
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

    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    expect(signOut).toHaveBeenCalledOnce();
    expect(screen.queryByText(authSessionResponseFixture.user.username)).not.toBeInTheDocument();
  });

  it('supports accessible sign-in and sign-out state transitions', async () => {
    const signOut = vi.fn(() => Promise.resolve());
    const auth = createTestAuthClient({
      signIn: () =>
        Promise.resolve({
          confirmationRequired: false,
          session: browserSession('signed-in-token'),
        }),
      signOut,
    });
    const user = userEvent.setup();
    renderRoute('/auth', { auth });

    await user.type(await screen.findByLabelText('Email address'), 'fan@example.test');
    await user.type(screen.getByLabelText('Password'), 'safe-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(
      await screen.findByRole('heading', { name: authSessionResponseFixture.user.username }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    expect(signOut).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'Show account creation form' }));
    await user.type(screen.getByLabelText('Email address'), 'new-fan@example.test');
    await user.type(screen.getByLabelText('Password'), 'another-safe-password');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Check your email');
  });

  it('surfaces accessible form failures and marks the reduced-motion preference', async () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        addEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
        matches: query === '(prefers-reduced-motion: reduce)',
        media: query,
        onchange: null,
        removeEventListener: vi.fn(),
      })),
    });
    const user = userEvent.setup();
    const { container } = renderRoute('/auth', {
      auth: createTestAuthClient({ signIn: () => Promise.reject(new Error('Sign in failed.')) }),
    });
    await user.type(await screen.findByLabelText('Email address'), 'fan@example.test');
    await user.type(screen.getByLabelText('Password'), 'safe-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign in failed.');
    expect(container.querySelector('[data-reduced-motion="true"]')).toBeInTheDocument();
  });
});
