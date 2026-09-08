// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { EntryClaimContract } from '@creatordrop/contracts';
import { ApiProvider } from '../src/api/api-context.js';
import { CreatorDropApiError } from '../src/api/client.js';
import { AppRoutes } from '../src/app.js';
import { SessionProvider } from '../src/auth/session-context.js';
import { MethodEditor } from '../src/entries/method-editor.js';
import { CreatorMethods } from '../src/entries/creator-methods.js';
import { FanEntryMethods } from '../src/entries/fan-entry-methods.js';
import { ClaimForm } from '../src/entries/claim-form.js';
import { ClaimsInbox } from '../src/entries/claims-inbox.js';
import { entryClaim, entryMethod, entryPolicy, entryState, membership } from './entry-fixtures.js';
import { openingV2BoxFixture } from './fixtures.js';
import { authSessionResponseFixture } from './fixtures.js';
import type { BrowserAuthSession } from '../src/auth/auth-client.js';
import { browserSession, createTestApiClient, createTestAuthClient } from './test-clients.js';

const apiError = (status: number) =>
  new CreatorDropApiError(status, {
    error: {
      code: 'ENTRY_CONFLICT',
      details: {},
      message: 'Synthetic error',
      requestId: 'synthetic-request',
    },
  });
const mount = (child: ReactNode, api = createTestApiClient()) =>
  render(
    <MemoryRouter>
      <ApiProvider client={api}>{child}</ApiProvider>
    </MemoryRouter>,
  );
const metadata = {
  id: entryClaim.evidence.screenshot ?? '',
  byteLength: 3,
  mediaType: 'image/png' as const,
  uploaded: true,
};
const proofApi = () =>
  createTestApiClient({
    createEntryEvidence: vi.fn(() =>
      Promise.resolve({ evidence: { ...metadata, uploaded: false } }),
    ),
    uploadEntryEvidence: vi.fn(() => Promise.resolve({ evidence: metadata })),
  });
const revokePreview = vi.fn();
beforeEach(() => {
  revokePreview.mockClear();
  URL.createObjectURL = vi.fn(() => 'blob:synthetic-proof');
  URL.revokeObjectURL = revokePreview;
});

describe('R2B creator configuration', () => {
  it('filters the shared platform actions and supplies editable evidence defaults', async () => {
    const user = userEvent.setup();
    const save = vi.fn();
    mount(<MethodEditor busy={false} error={null} onSave={save} onCancel={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'How can fans unlock this Drop?' })).toHaveFocus();
    for (const name of [
      'Instagram',
      'YouTube',
      'Twitch',
      'TikTok',
      'Facebook',
      'Purchase',
      'Custom',
    ])
      expect(screen.getByRole('button', { name })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Instagram' }));
    expect(screen.queryByRole('button', { name: 'Subscribe to channel' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Like post' }));
    expect(screen.getByLabelText('Instagram username')).toHaveValue('required');
    expect(screen.getByLabelText('Screenshot proof')).toHaveValue('required');
    await user.type(screen.getByLabelText('Instructions'), 'Like this synthetic post.');
    await user.type(
      screen.getByLabelText('Target post, profile or channel link'),
      'https://www.instagram.com/p/synthetic/',
    );
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: 'instagram',
        action: 'like_post',
        openingsGranted: '1',
        perUserClaimLimit: '1',
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Twitch' }));
    expect(screen.queryByRole('button', { name: 'Like post' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Paid subscription' }));
    expect(screen.getByLabelText('Twitch username')).toHaveValue('required');
    await user.click(screen.getByRole('button', { name: 'Purchase' }));
    await user.click(screen.getByRole('button', { name: 'Previous purchase' }));
    expect(screen.getByLabelText('Order/reference number')).toHaveValue('required');
    expect(screen.getByLabelText('Screenshot proof')).toHaveValue('optional');
  });
  it('saves a replacement draft and publishes only after a human summary', async () => {
    const user = userEvent.setup();
    const api = createTestApiClient({
      listDraftEntryMethods: () => Promise.resolve({ methods: [entryMethod] }),
      saveEntryMethod: vi.fn(() => Promise.resolve({ method: entryMethod })),
      publishEntryMethod: vi.fn(() => Promise.resolve({ method: entryMethod })),
    });
    mount(
      <CreatorMethods
        creatorId={entryPolicy.creatorId}
        boxId={entryPolicy.boxId}
        box={openingV2BoxFixture}
        role="owner"
        onRefresh={vi.fn()}
      />,
      api,
    );
    await user.click(await screen.findByRole('button', { name: 'Edit replacement draft' }));
    expect(screen.getByText(/Existing claims keep their original rules/)).toBeVisible();
    await user.clear(screen.getByLabelText('Title fans will see'));
    await user.type(screen.getByLabelText('Title fans will see'), 'Updated title');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() =>
      expect(api.saveEntryMethod).toHaveBeenCalledWith(
        entryPolicy.creatorId,
        entryPolicy.boxId,
        expect.objectContaining({ title: 'Updated title' }),
        entryMethod,
      ),
    );
    expect(api.publishEntryMethod).not.toHaveBeenCalled();
    await user.click(await screen.findByRole('button', { name: 'Review & publish' }));
    expect(screen.getByRole('heading', { name: 'Fans will unlock 1 Drop' })).toBeVisible();
    expect(screen.getByText('100%')).toBeVisible();
    expect(screen.getByText('3 openings per fan')).toBeVisible();
    expect(document.body.textContent).not.toContain(entryPolicy.id);
    await user.click(screen.getByRole('button', { name: 'Publish entry rule' }));
    await screen.findByText('Entry rule published.');
    expect(api.publishEntryMethod).toHaveBeenCalledWith(
      entryPolicy.creatorId,
      entryPolicy.boxId,
      entryMethod,
      openingV2BoxFixture.version.id,
    );
  });
  it('creates a draft and forces an authoritative refresh after an ambiguous save', async () => {
    const user = userEvent.setup();
    const api = createTestApiClient({
      saveEntryMethod: vi.fn(() => {
        return Promise.reject(new Error('network'));
      }),
    });
    mount(
      <CreatorMethods
        creatorId={entryPolicy.creatorId}
        boxId={entryPolicy.boxId}
        box={openingV2BoxFixture}
        role="manager"
        onRefresh={vi.fn()}
      />,
      api,
    );
    await user.click(await screen.findByRole('button', { name: 'Add a method' }));
    await user.click(screen.getByRole('button', { name: 'Custom' }));
    await user.click(screen.getByRole('button', { name: 'Manual requirement' }));
    await user.type(screen.getByLabelText('Instructions'), 'Send a note.');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Refresh the methods');
    expect(api.saveEntryMethod).toHaveBeenCalledWith(
      entryPolicy.creatorId,
      entryPolicy.boxId,
      expect.objectContaining({ platform: 'custom' }),
      undefined,
    );
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Refresh methods' }));
    expect(screen.queryByRole('button', { name: 'Save draft' })).not.toBeInTheDocument();
  });
});

describe('R2B fan proof and authoritative state', () => {
  it('keeps proof during same-token focus revalidation, but clears it on account failure or change', async () => {
    const user = userEvent.setup();
    let listener: (session: BrowserAuthSession | null) => void = () => {
      throw new Error('No listener');
    };
    const api = createTestApiClient({
      getEntryState: () => Promise.resolve({ boxId: entryPolicy.boxId, methods: [entryState()] }),
    });
    const auth = createTestAuthClient({
      getSession: () => Promise.resolve(browserSession()),
      onSessionChange: (callback) => {
        listener = callback;
        return () => undefined;
      },
    });
    render(
      <MemoryRouter initialEntries={[`/creators/creator-one/boxes/${entryPolicy.boxId}`]}>
        <ApiProvider client={api}>
          <SessionProvider apiClient={api} authClient={auth}>
            <AppRoutes />
          </SessionProvider>
        </ApiProvider>
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: 'Complete requirement' }));
    await user.type(screen.getByLabelText('Instagram username'), '@keep-my-proof');
    let resolveExchange: (response: typeof authSessionResponseFixture) => void = () => {
      throw new Error('Not started');
    };
    const exchange = vi.fn(
      () =>
        new Promise<typeof authSessionResponseFixture>((resolve) => {
          resolveExchange = resolve;
        }),
    );
    api.exchangeSession = exchange;
    act(() => listener(browserSession()));
    expect(screen.getByLabelText('Instagram username')).toHaveValue('@keep-my-proof');
    act(() => resolveExchange(authSessionResponseFixture));
    await waitFor(() => expect(exchange).toHaveBeenCalledOnce());
    expect(screen.getByLabelText('Instagram username')).toHaveValue('@keep-my-proof');
    api.exchangeSession = () => Promise.reject(apiError(403));
    act(() => listener(browserSession()));
    await waitFor(() =>
      expect(screen.queryByLabelText('Instagram username')).not.toBeInTheDocument(),
    );
    api.exchangeSession = () => Promise.resolve(authSessionResponseFixture);
    act(() => listener(browserSession()));
    await user.click(await screen.findByRole('button', { name: 'Complete requirement' }));
    await user.type(screen.getByLabelText('Instagram username'), '@different-account');
    api.exchangeSession = () =>
      Promise.resolve({
        user: { ...authSessionResponseFixture.user, id: '00000000-0000-4000-8000-000000000699' },
      });
    act(() => listener(browserSession('different-synthetic-token')));
    await waitFor(() =>
      expect(screen.queryByLabelText('Instagram username')).not.toBeInTheDocument(),
    );
  });
  it('uploads private proof, checks type/size, and refreshes into pending without duplicate actions', async () => {
    const user = userEvent.setup({ applyAccept: false });
    let pending = false;
    const api = {
      ...proofApi(),
      getEntryState: vi.fn(() =>
        Promise.resolve({
          boxId: entryPolicy.boxId,
          methods: [entryState(pending ? 'pending' : undefined)],
        }),
      ),
      submitEntryClaim: vi.fn(() => {
        pending = true;
        return Promise.resolve({ claim: entryClaim });
      }),
    };
    const view = mount(
      <FanEntryMethods boxId={entryPolicy.boxId} authenticated onApproved={vi.fn()} />,
      api,
    );
    await user.click(await screen.findByRole('button', { name: 'Complete requirement' }));
    expect(screen.getByRole('heading', { name: /Submit proof ·/ })).toHaveFocus();
    const link = screen.getByRole('link', { name: /Open Instagram requirement/ });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText(/Opening the link does not verify completion/)).toBeVisible();
    expect(screen.queryByLabelText('Order/reference number')).not.toBeInTheDocument();
    const file = screen.getByLabelText('Screenshot proof');
    await user.upload(file, new File(['text'], 'bad.txt', { type: 'text/plain' }));
    expect(screen.getByRole('alert')).toHaveTextContent('PNG or JPEG');
    await user.upload(
      file,
      new File([new Uint8Array(5242881)], 'large.png', { type: 'image/png' }),
    );
    expect(screen.getByRole('alert')).toHaveTextContent('too large');
    expect(api.createEntryEvidence).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('Instagram username'), '@synthetic-fan');
    const image = new File(['png'], 'proof.png', { type: 'image/png' });
    await user.upload(file, image);
    await screen.findByText('Screenshot uploaded.');
    expect(api.uploadEntryEvidence).toHaveBeenCalledWith(metadata.id, image);
    await user.click(screen.getByRole('button', { name: 'Submit proof' }));
    await screen.findByText('Awaiting review');
    expect(screen.queryByRole('button', { name: 'Complete requirement' })).not.toBeInTheDocument();
    expect(api.submitEntryClaim).toHaveBeenCalledOnce();
    expect(api.submitEntryClaim).toHaveBeenCalledWith(
      entryPolicy.boxId,
      entryPolicy.id,
      entryClaim.evidence,
      expect.any(String),
    );
    expect(document.body.textContent).not.toContain(metadata.id);
    view.unmount();
    expect(revokePreview).toHaveBeenCalledWith('blob:synthetic-proof');
  });
  it('retries failed uploads and unconfirmed claims with the same evidence and idempotency identity', async () => {
    const user = userEvent.setup();
    const api = proofApi();
    api.uploadEntryEvidence = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue({ evidence: metadata });
    api.submitEntryClaim = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue({ claim: entryClaim });
    const submitted = vi.fn();
    mount(<ClaimForm policy={entryPolicy} onSubmitted={submitted} onCancel={vi.fn()} />, api);
    await user.type(screen.getByLabelText('Instagram username'), '@synthetic-fan');
    await user.upload(
      screen.getByLabelText('Screenshot proof'),
      new File(['png'], 'proof.png', { type: 'image/png' }),
    );
    await user.click(await screen.findByRole('button', { name: 'Retry upload' }));
    await screen.findByText('Screenshot uploaded.');
    expect(api.createEntryEvidence).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'Submit proof' }));
    await user.click(await screen.findByRole('button', { name: 'Retry submission' }));
    expect(vi.mocked(api.submitEntryClaim).mock.calls[1]).toEqual(
      vi.mocked(api.submitEntryClaim).mock.calls[0],
    );
    expect(submitted).toHaveBeenCalledOnce();
  });
  it.each(['pending', 'approved', 'rejected'] as const)(
    'restores %s state on a new browser session',
    async (status) => {
      const api = createTestApiClient({
        getEntryState: () =>
          Promise.resolve({ boxId: entryPolicy.boxId, methods: [entryState(status)] }),
      });
      mount(<FanEntryMethods boxId={entryPolicy.boxId} authenticated onApproved={vi.fn()} />, api);
      if (status === 'pending') await screen.findByText('Awaiting review');
      if (status === 'approved') {
        await screen.findByText('You unlocked 5 Drops.');
        expect(screen.getByText(/Claim limit reached/)).toBeVisible();
      }
      if (status === 'rejected') {
        await screen.findByText('Proof couldn’t be verified');
        expect(screen.getByRole('button', { name: 'Submit corrected proof' })).toBeEnabled();
      }
      expect(
        screen.queryByRole('button', { name: 'Complete requirement' }),
      ).not.toBeInTheDocument();
    },
  );
  it('refreshes existing opening entitlement state when approval arrives', async () => {
    const user = userEvent.setup();
    let status: EntryClaimContract['status'] = 'pending';
    const changed = vi.fn();
    mount(
      <FanEntryMethods boxId={entryPolicy.boxId} authenticated onApproved={changed} />,
      createTestApiClient({
        getEntryState: () =>
          Promise.resolve({ boxId: entryPolicy.boxId, methods: [entryState(status)] }),
      }),
    );
    await screen.findByText('Awaiting review');
    status = 'approved';
    await user.click(screen.getByRole('button', { name: 'Refresh claim status' }));
    await screen.findByText('You unlocked 5 Drops.');
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
  });
});

describe('R2B reviewer inbox', () => {
  const reviewApi = () =>
    createTestApiClient({
      listReviewClaims: vi.fn(() => Promise.resolve({ claims: [entryClaim], nextCursor: null })),
      getReviewClaim: vi.fn(() => Promise.resolve({ claim: entryClaim })),
      getOwnEntryClaim: () => {
        return Promise.reject(apiError(404));
      },
      getReviewEvidence: vi.fn(() => Promise.resolve(new Blob(['png'], { type: 'image/png' }))),
    });
  it.each(['approved', 'rejected'] as const)(
    'confirms %s once, refreshes the terminal record and focuses the result',
    async (status) => {
      const user = userEvent.setup();
      const api = reviewApi();
      let finish: () => void = () => {
        throw new Error('not started');
      };
      api.reviewEntryClaim = vi.fn(
        () =>
          new Promise<{ claim: EntryClaimContract }>((resolve) => {
            finish = () => resolve({ claim: { ...entryClaim, status } });
          }),
      );
      mount(<ClaimsInbox creatorId={entryPolicy.creatorId} boxes={[]} />, api);
      await user.click(await screen.findByRole('button', { name: 'Review claim' }));
      const action = await screen.findByRole('button', {
        name: status === 'approved' ? 'Approve' : 'Reject',
      });
      expect(await screen.findByAltText('Fan’s submitted screenshot proof')).toHaveAttribute(
        'src',
        'blob:synthetic-proof',
      );
      expect(api.getReviewEvidence).toHaveBeenCalledWith(
        entryPolicy.creatorId,
        metadata.id,
        expect.any(AbortSignal),
      );
      await user.dblClick(action);
      expect(api.reviewEntryClaim).toHaveBeenCalledOnce();
      expect(screen.getByRole('button', { name: 'Saving review…' })).toBeDisabled();
      api.getReviewClaim = vi.fn(() => Promise.resolve({ claim: { ...entryClaim, status } }));
      act(() => {
        finish();
      });
      await screen.findByText(
        status === 'approved' ? 'Claim approved · 1 Drop granted' : 'Claim rejected',
      );
      expect(screen.getByRole('heading', { name: 'Review claim' })).toHaveFocus();
      expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Back to inbox' }));
      await user.click(
        screen.getByRole('button', { name: status === 'approved' ? 'Approved' : 'Rejected' }),
      );
      expect(api.listReviewClaims).toHaveBeenLastCalledWith(
        entryPolicy.creatorId,
        status,
        undefined,
        expect.any(AbortSignal),
      );
    },
  );
  it('resolves a concurrent opposite review to the server terminal status', async () => {
    const user = userEvent.setup();
    const api = reviewApi();
    api.reviewEntryClaim = vi.fn(() => {
      api.getReviewClaim = () => Promise.resolve({ claim: { ...entryClaim, status: 'rejected' } });
      return Promise.reject(apiError(409));
    });
    mount(<ClaimsInbox creatorId={entryPolicy.creatorId} boxes={[]} />, api);
    await user.click(await screen.findByRole('button', { name: 'Review claim' }));
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    await screen.findByText('Claim rejected');
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });
  it('shows safe self-review guidance and fails closed if own-claim identity cannot be checked', async () => {
    const user = userEvent.setup();
    const api = reviewApi();
    api.getOwnEntryClaim = () => Promise.resolve({ claim: entryClaim });
    mount(<ClaimsInbox creatorId={entryPolicy.creatorId} boxes={[]} />, api);
    await user.click(await screen.findByRole('button', { name: 'Review claim' }));
    await screen.findByText(/This is your claim/);
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back to inbox' }));
    api.getOwnEntryClaim = () => {
      return Promise.reject(new Error('network'));
    };
    await user.click(screen.getByRole('button', { name: 'Review claim' }));
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });
  it.each(['owner', 'manager', 'editor', 'viewer', 'other'] as const)(
    'limits the %s workspace to its authorized surface',
    async (role) => {
      const api = reviewApi();
      api.listMyWorkspaces = () =>
        Promise.resolve(role === 'other' ? { memberships: [] } : membership(role));
      const auth = createTestAuthClient({ getSession: () => Promise.resolve(browserSession()) });
      render(
        <MemoryRouter initialEntries={[`/studio/${entryPolicy.creatorId}/claims`]}>
          <ApiProvider client={api}>
            <SessionProvider apiClient={api} authClient={auth}>
              <AppRoutes />
            </SessionProvider>
          </ApiProvider>
        </MemoryRouter>,
      );
      if (role === 'owner' || role === 'manager') {
        await screen.findByRole('button', { name: 'Review claim' });
        expect(api.listReviewClaims).toHaveBeenCalled();
      } else {
        await screen.findByRole('heading', {
          name: role === 'other' ? 'Workspace unavailable' : 'Review access required',
        });
        expect(api.listReviewClaims).not.toHaveBeenCalled();
      }
      expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    },
  );
  it('recovers private evidence failure without exposing a public storage URL', async () => {
    const user = userEvent.setup();
    const api = reviewApi();
    api.getReviewEvidence = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
    mount(<ClaimsInbox creatorId={entryPolicy.creatorId} boxes={[]} />, api);
    await user.click(await screen.findByRole('button', { name: 'Review claim' }));
    await user.click(await screen.findByRole('button', { name: 'Retry evidence' }));
    expect(await screen.findByAltText('Fan’s submitted screenshot proof')).toHaveAttribute(
      'src',
      'blob:synthetic-proof',
    );
    expect(
      within(screen.getByRole('region', { name: 'Review claim' })).queryByText(metadata.id),
    ).not.toBeInTheDocument();
  });
});
