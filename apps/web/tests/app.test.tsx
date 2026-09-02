// @vitest-environment jsdom

import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import type { PublicCreatorsResponse } from '@creatordrop/contracts';

import { ApiProvider } from '../src/api/api-context.js';
import { CreatorDropApiError } from '../src/api/client.js';
import { SessionProvider } from '../src/auth/session-context.js';
import { AppRoutes } from '../src/app.js';
import {
  authSessionResponseFixture,
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
