import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app.js';
import { createApiClient } from './api/client.js';
import { getWebEnvironment } from './config/environment.js';
import './styles.css';

const environment = getWebEnvironment();
const rootElement = document.querySelector('#root');

if (rootElement === null) {
  throw new Error('CreatorDrop root element is missing.');
}

const root = createRoot(rootElement);

const bootstrap = async (): Promise<void> => {
  const { createSupabaseBrowserAuthClient } = await import('./auth/auth-client.js');
  const authClient = createSupabaseBrowserAuthClient({
    publishableKey: environment.supabasePublishableKey,
    storage: window.sessionStorage,
    url: environment.supabaseUrl,
  });
  const apiClient = createApiClient({
    baseUrl: environment.apiBaseUrl,
    getAccessToken: () => authClient.getAccessToken(),
    onUnauthorized: () => {
      void authClient.signOut().catch(() => undefined);
    },
  });
  root.render(
    <StrictMode>
      <App
        apiClient={apiClient}
        authClient={authClient}
        testCreditsEnabled={environment.testCreditsEnabled}
      />
    </StrictMode>,
  );
};

void bootstrap().catch(() => {
  root.render(
    <main className="state-card" role="alert">
      CreatorDrop could not start. Check the public web configuration and try again.
    </main>,
  );
});
