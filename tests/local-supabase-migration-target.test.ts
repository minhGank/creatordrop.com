import { describe, expect, it } from 'vitest';

import { assertLocalSupabaseMigrationTarget } from '../scripts/local-supabase-migration-target.mjs';

describe('local Supabase migration target validation', () => {
  it.each([
    'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
    'postgresql://postgres:postgres@localhost:54322/postgres',
    'postgresql://postgres:postgres@[::1]:54322/postgres',
  ])('accepts the explicit local Supabase target %s', (connectionString) => {
    expect(() => assertLocalSupabaseMigrationTarget(connectionString)).not.toThrow();
  });

  it.each([
    'postgresql://postgres:postgres@localhost:54322/postgres?host=db.example.com',
    'postgresql://postgres:postgres@localhost:54322/postgres?port=5432',
    'postgresql://postgres:postgres@localhost:54322/postgres?dbname=production',
    'postgresql://postgres:postgres@localhost:54322/postgres?options=-c%20role%3Dcreatordrop_app',
    'postgresql://postgres:postgres@localhost:54322/postgres#production',
    'postgresql://postgres:postgres@db.example.com:54322/postgres',
    'postgresql://postgres:postgres@localhost:5432/postgres',
    'postgresql://postgres:postgres@localhost:54322/production',
  ])('rejects a noncanonical or overridable target without echoing it', (connectionString) => {
    let message = '';
    try {
      assertLocalSupabaseMigrationTarget(connectionString);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe(
      'Development entitlement grants are restricted to local Supabase PostgreSQL.',
    );
    expect(message).not.toContain(connectionString);
    expect(message).not.toContain('postgres:postgres');
  });
});
