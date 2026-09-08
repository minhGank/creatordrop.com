// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { CreatorUsageResponse } from '@creatordrop/contracts';
import { ApiProvider } from '../src/api/api-context.js';
import { AppRoutes } from '../src/app.js';
import { SessionProvider } from '../src/auth/session-context.js';
import { CreatorUsage } from '../src/usage/creator-usage.js';
import { browserSession, createTestApiClient, createTestAuthClient } from './test-clients.js';
import { entryPolicy, membership } from './entry-fixtures.js';

const counts = {
  hostedOpenings: '12',
  creatorEntitlementOpenings: '10',
  universalEntryOpenings: '2',
};
const response: CreatorUsageResponse = {
  usage: {
    asOf: '2026-09-08T12:00:00Z',
    range: { period: 'current_month', start: '2026-09-01T00:00:00Z', end: '2026-09-08T12:00:00Z' },
    totals: {
      lifetime: counts,
      currentMonth: counts,
      previousMonth: counts,
      last30Days: counts,
      selected: counts,
    },
    drops: [{ boxId: entryPolicy.boxId, name: 'Synthetic usage Drop', ...counts }],
    nextCursor: null,
  },
};
const mount = (api = createTestApiClient({ getCreatorUsage: () => Promise.resolve(response) })) =>
  render(
    <ApiProvider client={api}>
      <CreatorUsage creatorId={entryPolicy.creatorId} role="owner" />
    </ApiProvider>,
  );
describe('R4 creator hosted usage UI', () => {
  it('renders accessible metrics and source totals without commercial controls', async () => {
    mount();
    await screen.findByRole('table');
    expect(screen.getByRole('heading', { name: 'Hosted Openings', level: 1 })).toBeVisible();
    for (const text of [
      'Lifetime openings',
      'Previous month',
      'Last 30 days',
      'Creator requirements',
      'Universal Entries',
    ])
      expect(screen.getAllByText(text).length).toBeGreaterThan(0);
    expect(
      within(screen.getByRole('row', { name: 'Synthetic usage Drop 12 10 2' })).getByRole('cell', {
        name: '2',
      }),
    ).toBeVisible();
    expect(screen.getByRole('region', { name: 'Hosted openings by Drop' })).toHaveAttribute(
      'tabindex',
      '0',
    );
    expect(document.body.textContent).not.toMatch(
      /upgrade|subscription|pricing|quota|invoice|billing/iu,
    );
  });
  it('applies UTC inclusive date controls as an exclusive API end and resets pagination', async () => {
    const user = userEvent.setup();
    const read = vi.fn(() =>
      Promise.resolve({ usage: { ...response.usage, nextCursor: entryPolicy.boxId } }),
    );
    mount(createTestApiClient({ getCreatorUsage: read }));
    await user.click(await screen.findByRole('button', { name: 'Next Drops' }));
    await waitFor(() =>
      expect(read.mock.lastCall).toEqual([
        entryPolicy.creatorId,
        expect.objectContaining({ after: entryPolicy.boxId }),
        expect.any(AbortSignal),
      ]),
    );
    await user.selectOptions(screen.getByLabelText('Period'), 'custom');
    fireEvent.change(screen.getByLabelText('From (UTC)'), { target: { value: '2026-08-17' } });
    fireEvent.change(screen.getByLabelText('Through (UTC)'), { target: { value: '2026-09-16' } });
    await user.click(screen.getByRole('button', { name: 'Apply range' }));
    await waitFor(() =>
      expect(read.mock.lastCall).toEqual([
        entryPolicy.creatorId,
        {
          period: 'custom',
          limit: '25',
          start: '2026-08-17T00:00:00.000Z',
          end: '2026-09-17T00:00:00.000Z',
        },
        expect.any(AbortSignal),
      ]),
    );
    await user.selectOptions(screen.getByLabelText('Period'), 'lifetime');
    await user.click(screen.getByRole('button', { name: 'Apply range' }));
    await waitFor(() =>
      expect(read.mock.lastCall).toEqual([
        entryPolicy.creatorId,
        { period: 'lifetime', limit: '25' },
        expect.any(AbortSignal),
      ]),
    );
  });
  it('refreshes from the server and ignores a stale response after creator navigation', async () => {
    let finish: (value: CreatorUsageResponse) => void = () => {
      throw new Error('Missing pending request.');
    };
    const pending = new Promise<CreatorUsageResponse>((resolve) => {
      finish = resolve;
    });
    const read = vi
      .fn()
      .mockImplementationOnce(() => pending)
      .mockResolvedValue({ usage: { ...response.usage, drops: [] } });
    const api = createTestApiClient({ getCreatorUsage: read });
    const view = mount(api);
    view.rerender(
      <ApiProvider client={api}>
        <CreatorUsage creatorId={entryPolicy.methodId} role="owner" />
      </ApiProvider>,
    );
    await screen.findByText('No hosted openings in this range.');
    await act(async () => {
      finish(response);
      await pending;
    });
    expect(screen.queryByText('Synthetic usage Drop')).not.toBeInTheDocument();
    fireEvent.focus(window);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(3));
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Refresh usage' }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(4));
  });
  it('shows a retryable error without stale counts', async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error('Synthetic connection failure'))
      .mockResolvedValue(response);
    mount(createTestApiClient({ getCreatorUsage: read }));
    await screen.findByRole('alert');
    expect(screen.queryByText('Lifetime openings')).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('Lifetime openings');
  });
  it.each(['owner', 'manager', 'editor', 'viewer', 'other', 'anonymous'] as const)(
    'scopes the %s studio route',
    async (role) => {
      const read = vi.fn(() => Promise.resolve(response));
      const boxes = vi.fn(() => Promise.resolve({ boxes: [] }));
      const api = createTestApiClient({
        getCreatorUsage: read,
        listWorkspaceBoxes: boxes,
        listMyWorkspaces: () =>
          Promise.resolve(
            role === 'other' || role === 'anonymous' ? { memberships: [] } : membership(role),
          ),
      });
      const auth = createTestAuthClient({
        getSession: () => Promise.resolve(role === 'anonymous' ? null : browserSession()),
      });
      render(
        <MemoryRouter initialEntries={[`/studio/${entryPolicy.creatorId}/usage`]}>
          <ApiProvider client={api}>
            <SessionProvider apiClient={api} authClient={auth}>
              <AppRoutes />
            </SessionProvider>
          </ApiProvider>
        </MemoryRouter>,
      );
      if (role === 'owner' || role === 'manager') {
        await screen.findByRole('table');
        expect(screen.getByRole('link', { name: 'Usage' })).toBeVisible();
      } else {
        await screen.findByRole('heading', {
          name:
            role === 'other'
              ? 'Workspace unavailable'
              : role === 'anonymous'
                ? /sign in/iu
                : 'Usage access required',
        });
        expect(read).not.toHaveBeenCalled();
      }
      expect(boxes).not.toHaveBeenCalled();
    },
  );
});
