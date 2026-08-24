import { z } from 'zod';

const runtimeModeSchema = z.enum(['development', 'test', 'production']);
const maximumSignedBigint = 9_223_372_036_854_775_807n;

const sharedNodeEnvironmentShape = {
  NODE_ENV: runtimeModeSchema.default('development'),
} as const;

const httpUrlSchema = z.url().refine(
  (value) => {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  },
  { message: 'Expected an http:// or https:// URL.' },
);

const browserOriginSchema = httpUrlSchema.refine(
  (value) => {
    const url = new URL(value);
    return url.pathname === '/' && url.search === '' && url.hash === '';
  },
  { message: 'Expected an origin without a path, query, or fragment.' },
);

const apiEnvironmentSchema = z
  .object({
    NODE_ENV: runtimeModeSchema.optional(),
    AUTH_JWT_AUDIENCE: z.string().trim().min(1).max(255).default('authenticated'),
    AUTH_JWT_ISSUER: httpUrlSchema,
    AUTH_JWKS_URL: httpUrlSchema,
    AUTH_PROVIDER: z.string().trim().min(1).max(64).default('supabase'),
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(10_000).default(20),
    AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).max(86_400_000).default(60_000),
    CORS_ALLOWED_ORIGINS: z
      .string()
      .transform((value) => value.split(',').map((origin) => origin.trim()))
      .pipe(z.array(browserOriginSchema).min(1))
      .refine((origins) => new Set(origins).size === origins.length, {
        message: 'CORS origins must be unique.',
      }),
    CREATOR_MUTATION_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(10_000).default(60),
    CREATOR_MUTATION_RATE_LIMIT_WINDOW_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(86_400_000)
      .default(60_000),
    HOST: z.string().trim().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    REQUEST_BODY_LIMIT_BYTES: z.coerce.number().int().min(1_024).max(1_048_576).default(32_768),
    WALLET_MUTATION_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(10_000).default(20),
    WALLET_MUTATION_RATE_LIMIT_WINDOW_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(86_400_000)
      .default(60_000),
    WALLET_TEST_CREDITS_ENABLED: z.enum(['false', 'true']).default('false'),
  })
  .superRefine((environment, context) => {
    if (
      environment.WALLET_TEST_CREDITS_ENABLED === 'true' &&
      environment.NODE_ENV !== 'development' &&
      environment.NODE_ENV !== 'test'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Test credits require an explicit development or test runtime.',
        path: ['WALLET_TEST_CREDITS_ENABLED'],
      });
    }
  });

const workerEnvironmentSchema = z.object({
  ...sharedNodeEnvironmentShape,
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1000),
});

const postgresConnectionStringSchema = z.url().refine(
  (value) => {
    const protocol = new URL(value).protocol;
    return protocol === 'postgres:' || protocol === 'postgresql:';
  },
  { message: 'Expected a postgres:// or postgresql:// connection string.' },
);

const databaseEnvironmentSchema = z.object({
  DATABASE_APPLICATION_NAME: z.string().trim().min(1).max(63).default('creatordrop'),
  DATABASE_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5000),
  DATABASE_IDLE_TIMEOUT_MS: z.coerce.number().int().min(100).max(300_000).default(10_000),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  DATABASE_URL: postgresConnectionStringSchema,
});

const migrationEnvironmentSchema = z.object({
  DATABASE_MIGRATION_URL: postgresConnectionStringSchema,
});

const rngKeyHexSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const reservedRngKeyVersions = new Set(['__proto__', 'constructor', 'prototype']);
const rngKeyVersionSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u)
  .refine((value) => !reservedRngKeyVersions.has(value.toLowerCase()));
const localRngKeyVersionPattern = /^local[-_.]?dev(?:$|[-_.])/iu;
const publicExampleRngKey = '0'.repeat(64);
const rngHistoricalKeyEntrySchema = z
  .object({ key: rngKeyHexSchema, version: rngKeyVersionSchema })
  .strict();
const rngHistoricalKeysSchema = z
  .string()
  .default('[]')
  .transform((value, context): unknown => {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      context.addIssue({
        code: 'custom',
        message: 'Expected a JSON array of historical RNG keys.',
      });
      return z.NEVER;
    }
  })
  .pipe(z.array(rngHistoricalKeyEntrySchema).max(128))
  .superRefine((entries, context) => {
    const versions = entries.map(({ version }) => version);
    if (new Set(versions).size !== versions.length) {
      context.addIssue({ code: 'custom', message: 'Historical RNG key versions must be unique.' });
    }
    const keys = entries.map(({ key }) => key);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({ code: 'custom', message: 'Historical RNG key material must be unique.' });
    }
  });

const rngEnvironmentSchema = z
  .object({
    NODE_ENV: runtimeModeSchema.optional(),
    RNG_FAIRNESS_MUTATION_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(10_000).default(20),
    RNG_FAIRNESS_MUTATION_RATE_LIMIT_WINDOW_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(86_400_000)
      .default(60_000),
    RNG_HISTORICAL_MASTER_KEYS: rngHistoricalKeysSchema,
    RNG_MASTER_KEY: rngKeyHexSchema,
    RNG_MASTER_KEY_VERSION: rngKeyVersionSchema,
    RNG_MAX_OPENINGS_PER_SEED: z
      .string()
      .regex(/^[1-9][0-9]*$/u)
      .default('1000')
      .transform((value) => BigInt(value))
      .refine((value) => value <= maximumSignedBigint),
    RNG_MAX_SEED_AGE_MS: z.coerce.number().int().min(60_000).max(2_592_000_000).default(86_400_000),
  })
  .superRefine((value, context) => {
    if (
      value.RNG_HISTORICAL_MASTER_KEYS.some(
        ({ version }) => version === value.RNG_MASTER_KEY_VERSION,
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'The active RNG key version must not also be a historical key.',
        path: ['RNG_HISTORICAL_MASTER_KEYS'],
      });
    }
    const historicalKeyMaterials = value.RNG_HISTORICAL_MASTER_KEYS.map(({ key }) => key);
    if (historicalKeyMaterials.includes(value.RNG_MASTER_KEY)) {
      context.addIssue({
        code: 'custom',
        message: 'Every RNG key version must use distinct key material.',
        path: ['RNG_HISTORICAL_MASTER_KEYS'],
      });
    }
    if (value.NODE_ENV === 'development' || value.NODE_ENV === 'test') return;

    if (value.RNG_MASTER_KEY === publicExampleRngKey) {
      context.addIssue({
        code: 'custom',
        message: 'Production RNG encryption cannot use the public example key.',
        path: ['RNG_MASTER_KEY'],
      });
    }
    if (localRngKeyVersionPattern.test(value.RNG_MASTER_KEY_VERSION)) {
      context.addIssue({
        code: 'custom',
        message: 'Production RNG encryption cannot use a local-development key version.',
        path: ['RNG_MASTER_KEY_VERSION'],
      });
    }
    for (const { key, version } of value.RNG_HISTORICAL_MASTER_KEYS) {
      if (key === publicExampleRngKey || localRngKeyVersionPattern.test(version)) {
        context.addIssue({
          code: 'custom',
          message: 'Production historical RNG keys cannot contain local example material.',
          path: ['RNG_HISTORICAL_MASTER_KEYS'],
        });
        break;
      }
    }
  });

export type ApiEnvironment = Readonly<{
  authAudience: string;
  authIssuer: string;
  authJwksUrl: string;
  authProvider: string;
  authRateLimitMax: number;
  authRateLimitWindowMs: number;
  corsAllowedOrigins: readonly string[];
  creatorMutationRateLimitMax: number;
  creatorMutationRateLimitWindowMs: number;
  host: string;
  nodeEnvironment: z.infer<typeof runtimeModeSchema>;
  port: number;
  requestBodyLimitBytes: number;
  testCreditsEnabled: boolean;
  walletMutationRateLimitMax: number;
  walletMutationRateLimitWindowMs: number;
}>;

export type WorkerEnvironment = Readonly<{
  nodeEnvironment: z.infer<typeof runtimeModeSchema>;
  pollIntervalMs: number;
}>;

export type DatabaseEnvironment = Readonly<{
  applicationName: string;
  connectionString: string;
  connectionTimeoutMs: number;
  idleTimeoutMs: number;
  maxConnections: number;
}>;

export type MigrationEnvironment = Readonly<{
  connectionString: string;
}>;

export type RngEnvironment = Readonly<{
  fairnessMutationRateLimitMax: number;
  fairnessMutationRateLimitWindowMs: number;
  historicalMasterKeys: Readonly<Record<string, string>>;
  masterKeyHex: string;
  masterKeyVersion: string;
  maxOpeningsPerSeed: bigint;
  maxSeedAgeMs: number;
}>;

export const parseApiEnvironment = (input: NodeJS.ProcessEnv): ApiEnvironment => {
  const parsed = apiEnvironmentSchema.parse(input);

  return {
    authAudience: parsed.AUTH_JWT_AUDIENCE,
    authIssuer: parsed.AUTH_JWT_ISSUER,
    authJwksUrl: parsed.AUTH_JWKS_URL,
    authProvider: parsed.AUTH_PROVIDER,
    authRateLimitMax: parsed.AUTH_RATE_LIMIT_MAX,
    authRateLimitWindowMs: parsed.AUTH_RATE_LIMIT_WINDOW_MS,
    corsAllowedOrigins: parsed.CORS_ALLOWED_ORIGINS,
    creatorMutationRateLimitMax: parsed.CREATOR_MUTATION_RATE_LIMIT_MAX,
    creatorMutationRateLimitWindowMs: parsed.CREATOR_MUTATION_RATE_LIMIT_WINDOW_MS,
    host: parsed.HOST,
    nodeEnvironment: parsed.NODE_ENV ?? 'development',
    port: parsed.PORT,
    requestBodyLimitBytes: parsed.REQUEST_BODY_LIMIT_BYTES,
    testCreditsEnabled: parsed.WALLET_TEST_CREDITS_ENABLED === 'true',
    walletMutationRateLimitMax: parsed.WALLET_MUTATION_RATE_LIMIT_MAX,
    walletMutationRateLimitWindowMs: parsed.WALLET_MUTATION_RATE_LIMIT_WINDOW_MS,
  };
};

export const parseWorkerEnvironment = (input: NodeJS.ProcessEnv): WorkerEnvironment => {
  const parsed = workerEnvironmentSchema.parse(input);

  return {
    nodeEnvironment: parsed.NODE_ENV,
    pollIntervalMs: parsed.WORKER_POLL_INTERVAL_MS,
  };
};

export const parseDatabaseEnvironment = (input: NodeJS.ProcessEnv): DatabaseEnvironment => {
  const parsed = databaseEnvironmentSchema.parse(input);

  return {
    applicationName: parsed.DATABASE_APPLICATION_NAME,
    connectionString: parsed.DATABASE_URL,
    connectionTimeoutMs: parsed.DATABASE_CONNECTION_TIMEOUT_MS,
    idleTimeoutMs: parsed.DATABASE_IDLE_TIMEOUT_MS,
    maxConnections: parsed.DATABASE_POOL_MAX,
  };
};

export const parseMigrationEnvironment = (input: NodeJS.ProcessEnv): MigrationEnvironment => {
  const parsed = migrationEnvironmentSchema.parse(input);

  return { connectionString: parsed.DATABASE_MIGRATION_URL };
};

export const parseRngEnvironment = (input: NodeJS.ProcessEnv): RngEnvironment => {
  const parsed = rngEnvironmentSchema.parse(input);

  return {
    fairnessMutationRateLimitMax: parsed.RNG_FAIRNESS_MUTATION_RATE_LIMIT_MAX,
    fairnessMutationRateLimitWindowMs: parsed.RNG_FAIRNESS_MUTATION_RATE_LIMIT_WINDOW_MS,
    historicalMasterKeys: Object.fromEntries(
      parsed.RNG_HISTORICAL_MASTER_KEYS.map(({ key, version }) => [version, key]),
    ),
    masterKeyHex: parsed.RNG_MASTER_KEY,
    masterKeyVersion: parsed.RNG_MASTER_KEY_VERSION,
    maxOpeningsPerSeed: parsed.RNG_MAX_OPENINGS_PER_SEED,
    maxSeedAgeMs: parsed.RNG_MAX_SEED_AGE_MS,
  };
};
