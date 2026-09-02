import { lazy, Suspense } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';

import type { CreatorDropApiClient } from './api/client.js';
import { ApiProvider } from './api/api-context.js';
import { usePrefersReducedMotion } from './accessibility/use-prefers-reduced-motion.js';
import type { BrowserAuthClient } from './auth/auth-client.js';
import { SessionProvider } from './auth/session-context.js';
import { AppLayout } from './components/app-layout.js';
import { LoadingState } from './components/page-states.js';

const AccountPage = lazy(async () => ({
  default: (await import('./pages/account-page.js')).AccountPage,
}));
const AuthPage = lazy(async () => ({ default: (await import('./pages/auth-page.js')).AuthPage }));
const BoxDetailPage = lazy(async () => ({
  default: (await import('./pages/box-detail-page.js')).BoxDetailPage,
}));
const CreatorDetailPage = lazy(async () => ({
  default: (await import('./pages/creator-detail-page.js')).CreatorDetailPage,
}));
const CreatorListPage = lazy(async () => ({
  default: (await import('./pages/creator-list-page.js')).CreatorListPage,
}));
const HomePage = lazy(async () => ({ default: (await import('./pages/home-page.js')).HomePage }));
const NotFoundPage = lazy(async () => ({
  default: (await import('./pages/not-found-page.js')).NotFoundPage,
}));

export const AppRoutes = () => {
  const reducedMotion = usePrefersReducedMotion();
  return (
    <div data-reduced-motion={reducedMotion ? 'true' : 'false'}>
      <AppLayout>
        <Suspense fallback={<LoadingState label="Loading page" />}>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/auth" element={<AuthPage />} />
            <Route path="/account" element={<AccountPage />} />
            <Route path="/creators" element={<CreatorListPage />} />
            <Route path="/creators/:customSlug" element={<CreatorDetailPage />} />
            <Route path="/creators/:customSlug/boxes/:boxId" element={<BoxDetailPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </Suspense>
      </AppLayout>
    </div>
  );
};

export const App = ({
  apiClient,
  authClient,
}: {
  readonly apiClient: CreatorDropApiClient;
  readonly authClient: BrowserAuthClient;
}) => (
  <BrowserRouter>
    <ApiProvider client={apiClient}>
      <SessionProvider apiClient={apiClient} authClient={authClient}>
        <AppRoutes />
      </SessionProvider>
    </ApiProvider>
  </BrowserRouter>
);
