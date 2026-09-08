// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiProvider } from '../src/api/api-context.js';
import { createApiClient } from '../src/api/client.js';
import { createSupabaseBrowserAuthClient } from '../src/auth/auth-client.js';
import { SessionProvider } from '../src/auth/session-context.js';
import { useSession } from '../src/auth/use-session.js';
import { FanEntryMethods } from '../src/entries/fan-entry-methods.js';
import { entryClaim, entryPolicy, entryState } from './entry-fixtures.js';
import { authSessionResponseFixture } from './fixtures.js';

class TabStorage implements Storage {
  private readonly values = new Map<string, string>();
  failReads = false;
  beforeNextRead: (() => void) | undefined;
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    const beforeRead = this.beforeNextRead;
    this.beforeNextRead = undefined;
    beforeRead?.();
    if (this.failReads) throw new Error('Synthetic unavailable tab storage');
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

type Fan = 'fan-a' | 'fan-b';
const userId = (fan: Fan) =>
  fan === 'fan-a' ? authSessionResponseFixture.user.id : '00000000-0000-4000-8000-000000000699';
const providerSession = (fan: Fan) => ({
  access_token: `synthetic-${fan}-token`,
  refresh_token: `synthetic-${fan}-refresh`,
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  token_type: 'bearer',
  user: {
    id: userId(fan),
    aud: 'authenticated',
    role: 'authenticated',
    email: `${fan}@example.invalid`,
    app_metadata: {},
    user_metadata: {},
    created_at: '2026-09-08T00:00:00Z',
  },
});
const NativeBroadcastChannel = globalThis.BroadcastChannel;
const channels: BroadcastChannel[] = [];
const unsubscribe: (() => void)[] = [];
const revokePreview = vi.fn();
let fixtureNumber = 0;
const requestUrl = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
beforeEach(() => {
  revokePreview.mockClear();
  URL.createObjectURL = vi.fn(() => 'blob:synthetic-session-proof');
  URL.revokeObjectURL = revokePreview;
  // Use genuine channels, while closing all SDK-owned channels after the test.
  vi.stubGlobal(
    'BroadcastChannel',
    class extends NativeBroadcastChannel {
      constructor(name: string) {
        super(name);
        channels.push(this);
      }
    },
  );
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.includes('/token?grant_type=password'))
        return Promise.resolve(Response.json(providerSession('fan-b')));
      if (url.includes('/token?grant_type=refresh_token'))
        return Promise.resolve(
          Response.json({
            ...providerSession('fan-a'),
            access_token: 'synthetic-fan-a-rotated-token',
            refresh_token: 'synthetic-fan-a-rotated-refresh',
          }),
        );
      if (url.includes('/logout')) return Promise.resolve(Response.json({}));
      return Promise.reject(new Error('Unexpected synthetic provider request'));
    }),
  );
});
afterEach(() => {
  unsubscribe.splice(0).forEach((stop) => stop());
  channels.splice(0).forEach((channel) => channel.close());
  vi.unstubAllGlobals();
});

const fixture = () => {
  fixtureNumber += 1;
  const host = `r2b-session-${fixtureNumber.toString()}`;
  const storageKey = `sb-${host}-auth-token`;
  const createTab = (fan: Fan) => {
    const storage = new TabStorage();
    storage.setItem(storageKey, JSON.stringify(providerSession(fan)));
    const auth = createSupabaseBrowserAuthClient({
      publishableKey: 'synthetic-publishable-key',
      url: `https://${host}.supabase.co`,
      storage,
    });
    return { auth, storage };
  };
  const tab = createTab('fan-a');
  const uploads: { readonly bearer: string | null; readonly file: BodyInit | null | undefined }[] =
    [];
  const metadata = {
    id: entryClaim.evidence.screenshot,
    mediaType: 'image/png',
    byteLength: 3,
    uploaded: false,
  };
  const api = createApiClient({
    baseUrl: 'https://api.example.invalid',
    getAccessToken: () => tab.auth.getAccessToken(),
    fetcher: (input, options) => {
      const bearer = new Headers(options?.headers).get('Authorization');
      const path = new URL(requestUrl(input)).pathname;
      if (path.endsWith('/session/exchange')) {
        const fan = bearer === 'Bearer synthetic-fan-a-token' ? 'fan-a' : 'fan-b';
        return Promise.resolve(
          Response.json({
            user: { ...authSessionResponseFixture.user, id: userId(fan), username: fan },
          }),
        );
      }
      if (path.endsWith('/entry-state'))
        return Promise.resolve(
          Response.json({ boxId: entryPolicy.boxId, methods: [entryState()] }),
        );
      if (path.endsWith('/entry-methods'))
        return Promise.resolve(Response.json({ methods: [entryPolicy] }));
      if (path.endsWith('/entry-evidence'))
        return Promise.resolve(Response.json({ evidence: metadata }));
      if (path.endsWith('/content')) {
        uploads.push({ bearer, file: options?.body });
        return Promise.resolve(Response.json({ evidence: { ...metadata, uploaded: true } }));
      }
      return Promise.reject(new Error('Unexpected synthetic API request'));
    },
  });
  const mount = () =>
    render(
      <MemoryRouter>
        <ApiProvider client={api}>
          <SessionProvider apiClient={api} authClient={tab.auth}>
            <FanSession />
          </SessionProvider>
        </ApiProvider>
      </MemoryRouter>,
    );
  const broadcast = () => new BroadcastChannel(storageKey);
  return { ...tab, api, broadcast, createTab, mount, storageKey, uploads };
};
const FanSession = () => {
  const { state } = useSession();
  return state.status === 'authenticated' ? (
    <>
      <h1>{state.user.username}</h1>
      <FanEntryMethods
        key={state.user.id}
        boxId={entryPolicy.boxId}
        authenticated
        onApproved={() => undefined}
      />
    </>
  ) : (
    <p>{state.status}</p>
  );
};
const selectProof = async (user: ReturnType<typeof userEvent.setup>, fan: Fan) => {
  await user.click(await screen.findByRole('button', { name: 'Complete requirement' }));
  await user.type(screen.getByLabelText('Instagram username'), `@private-${fan}`);
  const proof = new File(['png'], `${fan}-private.png`, { type: 'image/png' });
  await user.upload(screen.getByLabelText('Screenshot proof'), proof);
  await screen.findByText('Screenshot uploaded.');
  return proof;
};

describe('tab-local authentication for private entry proof', () => {
  it('keeps the displayed actor and private upload aligned when another tab signs in', async () => {
    const user = userEvent.setup();
    const tab = fixture();
    const notifications = vi.fn();
    unsubscribe.push(tab.auth.onSessionChange(notifications));
    tab.mount();
    await screen.findByRole('heading', { name: 'fan-a' });
    await user.click(await screen.findByRole('button', { name: 'Complete requirement' }));
    await user.type(screen.getByLabelText('Instagram username'), '@private-fan-a');
    const beforeBroadcast = notifications.mock.calls.length;
    const otherTab = tab.createTab('fan-b');
    expect(await otherTab.auth.getAccessToken()).toBe('synthetic-fan-b-token');
    await waitFor(() => expect(notifications.mock.calls.length).toBeGreaterThan(beforeBroadcast));
    expect(notifications).toHaveBeenLastCalledWith({ accessToken: 'synthetic-fan-a-token' });
    expect(await tab.auth.getAccessToken()).toBe('synthetic-fan-a-token');
    expect(screen.getByRole('heading', { name: 'fan-a' })).toBeVisible();
    expect(screen.getByLabelText('Instagram username')).toHaveValue('@private-fan-a');
    const proof = new File(['png'], 'fan-a-private.png', { type: 'image/png' });
    await user.upload(screen.getByLabelText('Screenshot proof'), proof);
    await screen.findByText('Screenshot uploaded.');
    expect(tab.uploads).toEqual([{ bearer: 'Bearer synthetic-fan-a-token', file: proof }]);
  });

  it('clears proof on a local account change and sign-out, and uploads as the new actor', async () => {
    const user = userEvent.setup();
    const tab = fixture();
    tab.mount();
    await selectProof(user, 'fan-a');
    await act(() => tab.auth.signIn('fan-b@example.invalid', 'synthetic-test-password'));
    await screen.findByRole('heading', { name: 'fan-b' });
    expect(screen.queryByLabelText('Instagram username')).not.toBeInTheDocument();
    expect(screen.queryByAltText('Your selected screenshot proof')).not.toBeInTheDocument();
    expect(revokePreview).toHaveBeenCalledOnce();
    const proofB = await selectProof(user, 'fan-b');
    expect(tab.uploads[1]).toEqual({ bearer: 'Bearer synthetic-fan-b-token', file: proofB });
    await act(() => tab.auth.signOut());
    await screen.findByText('anonymous');
    expect(screen.queryByLabelText('Instagram username')).not.toBeInTheDocument();
    expect(screen.queryByAltText('Your selected screenshot proof')).not.toBeInTheDocument();
    expect(await tab.auth.getAccessToken()).toBeNull();
    expect(revokePreview).toHaveBeenCalledTimes(2);
  });

  it('clears sensitive proof if the originating tab session cannot be read', async () => {
    const user = userEvent.setup();
    const tab = fixture();
    tab.mount();
    await selectProof(user, 'fan-a');
    tab.storage.failReads = true;
    tab.broadcast().postMessage({ event: 'SIGNED_IN', session: providerSession('fan-b') });
    await screen.findByText('anonymous');
    expect(screen.queryByLabelText('Instagram username')).not.toBeInTheDocument();
    expect(screen.queryByAltText('Your selected screenshot proof')).not.toBeInTheDocument();
    expect(revokePreview).toHaveBeenCalledOnce();
  });

  it('does not deliver an asynchronous local session read after unsubscribe', async () => {
    const tab = fixture();
    const notifications = vi.fn();
    const stop = tab.auth.onSessionChange(notifications);
    unsubscribe.push(stop);
    await waitFor(() => expect(notifications).toHaveBeenCalled());
    const previousCalls = notifications.mock.calls.length;
    const readStarted = new Promise<void>((resolve) => {
      tab.storage.beforeNextRead = () => {
        stop();
        resolve();
      };
    });
    tab.broadcast().postMessage({ event: 'SIGNED_IN', session: providerSession('fan-b') });
    await readStarted;
    await tab.auth.getSession();
    expect(notifications).toHaveBeenCalledTimes(previousCalls);
  });

  it('delivers only the current local token when a session read triggers a refresh notification', async () => {
    const tab = fixture();
    const notifications = vi.fn();
    unsubscribe.push(tab.auth.onSessionChange(notifications));
    await waitFor(() => expect(notifications).toHaveBeenCalled());
    await tab.auth.getSession();
    const previousCalls = notifications.mock.calls.length;
    tab.storage.setItem(
      tab.storageKey,
      JSON.stringify({ ...providerSession('fan-a'), expires_at: 1 }),
    );
    tab.broadcast().postMessage({ event: 'SIGNED_IN', session: providerSession('fan-b') });
    await waitFor(() =>
      expect(notifications).toHaveBeenLastCalledWith({
        accessToken: 'synthetic-fan-a-rotated-token',
      }),
    );
    expect(notifications).toHaveBeenCalledTimes(previousCalls + 1);
    expect(await tab.auth.getAccessToken()).toBe('synthetic-fan-a-rotated-token');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
