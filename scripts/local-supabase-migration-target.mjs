const failClosed = () => {
  throw new Error('Development entitlement grants are restricted to local Supabase PostgreSQL.');
};

export const assertLocalSupabaseMigrationTarget = (connectionString) => {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    failClosed();
  }

  if (
    url.search !== '' ||
    url.hash !== '' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.port !== '54322' ||
    url.pathname !== '/postgres'
  ) {
    failClosed();
  }
};
