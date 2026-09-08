// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import type { BoxOpeningResponse, CurrentFairnessResponse } from '@creatordrop/contracts';
import { ApiProvider } from '../src/api/api-context.js';
import { CreatorDropApiError, type CreatorDropApiClient } from '../src/api/client.js';
import { AppRoutes } from '../src/app.js';
import type { BrowserAuthSession } from '../src/auth/auth-client.js';
import { SessionProvider } from '../src/auth/session-context.js';
import { isOpeningV2Catalog } from '../src/components/opening-catalog.js';
import {
  authSessionResponseFixture,
  currentFairnessFixture,
  openingV2BoxFixture,
  openingV2ResponseFixture,
  publicCreatorResponseFixture,
} from './fixtures.js';
import { browserSession, createTestApiClient, createTestAuthClient } from './test-clients.js';

vi.mock('../src/accessibility/use-prefers-reduced-motion.js', () => ({
  usePrefersReducedMotion: () => true,
}));

const original = openingV2ResponseFixture.opening;
if (!('openingCompatibilityVersion' in original) || !isOpeningV2Catalog(openingV2BoxFixture)) {
  throw new Error('Expected opening-v2 fixtures.');
}
const xpReward = { amount: '350', policyVersion: 'xp-v1' } as const;
const catalog = {
  ...openingV2BoxFixture,
  entries: openingV2BoxFixture.entries.map((entry) => ({
    ...entry,
    rewardVersion: { ...entry.rewardVersion, rewardType: 'xp' as const, xpReward },
  })),
  manifest: {
    ...openingV2BoxFixture.manifest,
    entries: openingV2BoxFixture.manifest.entries.map((entry) => ({ ...entry, xpReward })),
  },
};
const receipt: BoxOpeningResponse = {
  opening: {
    ...original,
    reward: { ...original.reward, xpReward },
    fulfillmentStatus: 'not_required',
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

const deferred = <T,>() => {
  let resolve: (value: T) => void = () => {
    throw new Error('Deferred request not initialized.');
  };
  let reject: (reason: Error) => void = () => {
    throw new Error('Deferred request not initialized.');
  };
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const mount = (overrides: Partial<CreatorDropApiClient> = {}) => {
  const openBox = vi.fn<CreatorDropApiClient['openBox']>(
    overrides.openBox ?? (() => Promise.resolve(receipt)),
  );
  let currentToken = 'actor-a-token';
  let notify: (session: BrowserAuthSession | null) => void = () => {
    throw new Error('Not subscribed.');
  };
  const exchangeSession = vi.fn((token: string) => {
    currentToken = token;
    return Promise.resolve({
      user:
        token === 'actor-a-token'
          ? authSessionResponseFixture.user
          : {
              ...authSessionResponseFixture.user,
              id: '00000000-0000-4000-8000-000000000699',
              username: 'other-fan',
            },
    });
  });
  const getOpeningEntitlementState = vi.fn(() =>
    Promise.resolve({
      entitlement: {
        available: currentToken === 'actor-a-token',
        boxId: catalog.manifest.boxId,
        consumed: '0',
        granted: currentToken === 'actor-a-token' ? '3' : '0',
        limitReached: false,
        maxOpeningsPerUser: '3',
        remaining: currentToken === 'actor-a-token' ? '3' : '0',
        successfulOpenings: '0',
      },
    }),
  );
  const api = createTestApiClient({
    exchangeSession,
    getOpeningEntitlementState,
    getCreatorBox: () =>
      Promise.resolve({ creator: publicCreatorResponseFixture.creator, box: catalog }),
    getPublishedBoxVersion: () => Promise.resolve(catalog),
    ...overrides,
    openBox,
  });
  const auth = createTestAuthClient({
    getSession: () => Promise.resolve(browserSession('actor-a-token')),
    onSessionChange: (listener) => {
      notify = listener;
      return () => undefined;
    },
  });
  render(
    <MemoryRouter initialEntries={[`/creators/creator-one/boxes/${catalog.manifest.boxId}`]}>
      <ApiProvider client={api}>
        <SessionProvider apiClient={api} authClient={auth}>
          <AppRoutes />
        </SessionProvider>
      </ApiProvider>
    </MemoryRouter>,
  );
  return {
    api,
    openBox,
    getOpeningEntitlementState,
    changeSession: async (session: BrowserAuthSession | null) => {
      await act(async () => {
        notify(session);
        await Promise.resolve();
      });
    },
  };
};

const prepare = async () => {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Open Drop' }));
  const heading = await screen.findByRole('heading', {
    name: 'Open one of your available Drops?',
  });
  const section = heading.closest('section');
  if (!section) throw new Error('Missing confirmation.');
  return { user, section };
};
const open = async () => {
  const { user, section } = await prepare();
  await user.click(within(section).getByRole('button', { name: 'Open Drop' }));
};
const expectNoPriorProgression = () => {
  expect(screen.queryByRole('region', { name: 'Your progression' })).not.toBeInTheDocument();
  expect(screen.queryByText(/640 lifetime XP/)).not.toBeInTheDocument();
};

describe('opening workflow session isolation', () => {
  it.each(['sign-out', 'account-change', 'invalid-session'] as const)(
    'clears a prior fan progression receipt after %s',
    async (change) => {
      const session = mount();
      await open();
      await screen.findByRole('region', { name: 'Your progression' });
      expect(screen.getByText(/640 lifetime XP/)).toBeVisible();
      if (change === 'invalid-session') {
        session.api.exchangeSession = () =>
          Promise.reject(
            new CreatorDropApiError(403, {
              error: {
                code: 'USER_SUSPENDED',
                message: 'Inactive synthetic account.',
                details: {},
                requestId: 'synthetic-session-audit',
              },
            }),
          );
      }
      await session.changeSession(
        change === 'sign-out'
          ? null
          : browserSession(change === 'account-change' ? 'actor-b-token' : 'actor-a-token'),
      );
      await waitFor(expectNoPriorProgression);
      if (change === 'account-change') {
        await screen.findByText('No Drops available');
        expect(screen.getByRole('button', { name: 'Open Drop' })).toBeDisabled();
      } else {
        expect(screen.getByText('Sign in to see and open your available Drops.')).toBeVisible();
      }
    },
  );

  it('ignores a prior fan opening response delivered after an account change', async () => {
    const pending = deferred<BoxOpeningResponse>();
    const openBox = vi.fn(() => pending.promise);
    const session = mount({ openBox });
    await open();
    await screen.findByRole('button', { name: 'Opening…' });
    await session.changeSession(browserSession('actor-b-token'));
    await screen.findByText('No Drops available');
    const reads = session.getOpeningEntitlementState.mock.calls.length;
    await act(async () => {
      pending.resolve(receipt);
      await pending.promise;
    });
    expectNoPriorProgression();
    expect(screen.getByRole('button', { name: 'Open Drop' })).toBeDisabled();
    expect(session.getOpeningEntitlementState).toHaveBeenCalledTimes(reads);
    expect(openBox).toHaveBeenCalledOnce();
  });

  it.each(['initialize', 'update-client-seed'] as const)(
    'does not %s for the new account when a previous preparation resolves',
    async (operation) => {
      const fairness = deferred<CurrentFairnessResponse>();
      const initializeFairness = vi.fn(() => Promise.resolve(currentFairnessFixture));
      const updateCurrentClientSeed = vi.fn(() => Promise.resolve(currentFairnessFixture));
      const session = mount({
        getCurrentFairness: () => fairness.promise,
        initializeFairness,
        updateCurrentClientSeed,
      });
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'Open Drop' }));
      await screen.findByText('Checking current Drop availability…');
      await session.changeSession(browserSession('actor-b-token'));
      await screen.findByText('No Drops available');
      await act(async () => {
        if (operation === 'initialize') {
          fairness.reject(
            new CreatorDropApiError(404, {
              error: {
                code: 'FAIRNESS_NOT_INITIALIZED',
                message: 'Synthetic profile missing.',
                details: {},
                requestId: 'synthetic-session-audit',
              },
            }),
          );
        } else {
          fairness.resolve({
            fairness: { ...currentFairnessFixture.fairness, clientSeed: null },
          });
        }
        await fairness.promise.catch(() => undefined);
      });
      expect(initializeFairness).not.toHaveBeenCalled();
      expect(updateCurrentClientSeed).not.toHaveBeenCalled();
      expect(session.openBox).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Open Drop' })).toBeDisabled();
    },
  );

  it('preserves the new account opening intent when a detached opening fails', async () => {
    const first = deferred<BoxOpeningResponse>();
    const second = deferred<BoxOpeningResponse>();
    const openBox = vi
      .fn<CreatorDropApiClient['openBox']>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const session = mount({
      openBox,
      getOpeningEntitlementState: () =>
        Promise.resolve({
          entitlement: {
            available: true,
            boxId: catalog.manifest.boxId,
            consumed: '0',
            granted: '3',
            limitReached: false,
            maxOpeningsPerUser: '3',
            remaining: '3',
            successfulOpenings: '0',
          },
        }),
    });
    await open();
    await screen.findByRole('button', { name: 'Opening…' });
    await session.changeSession(browserSession('actor-b-token'));
    await open();
    await screen.findByRole('button', { name: 'Opening…' });
    const key = `creatordrop:opening:v1:${catalog.manifest.boxId}`;
    const pendingForSecondUser = window.sessionStorage.getItem(key);
    expect(pendingForSecondUser).toContain('00000000-0000-4000-8000-000000000699');
    expect(openBox).toHaveBeenCalledTimes(2);
    expect(openBox.mock.calls[0]?.[2]).not.toBe(openBox.mock.calls[1]?.[2]);
    await act(async () => {
      first.reject(
        new CreatorDropApiError(409, {
          error: {
            code: 'BOX_NOT_OPENABLE',
            message: 'Detached synthetic opening failed.',
            details: {},
            requestId: 'synthetic-session-audit',
          },
        }),
      );
      await first.promise.catch(() => undefined);
    });
    expect(window.sessionStorage.getItem(key)).toBe(pendingForSecondUser);
    expect(screen.getByRole('button', { name: 'Opening…' })).toBeDisabled();
    expect(screen.queryByText('Detached synthetic opening failed.')).not.toBeInTheDocument();
    expectNoPriorProgression();
    expect(openBox).toHaveBeenCalledTimes(2);
  });

  it('preserves confirmed opening intent through unchanged-session revalidation', async () => {
    const getCurrentFairness = vi.fn(() => Promise.resolve(currentFairnessFixture));
    const session = mount({ getCurrentFairness });
    const { user, section } = await prepare();
    await session.changeSession(browserSession('actor-a-token'));
    expect(section).toBeInTheDocument();
    expect(getCurrentFairness).toHaveBeenCalledOnce();
    await user.click(within(section).getByRole('button', { name: 'Open Drop' }));
    await screen.findByRole('region', { name: 'Your progression' });
    expect(session.openBox).toHaveBeenCalledOnce();
  });
});
