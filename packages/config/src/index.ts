import { z } from 'zod';

const runtimeModeSchema = z.enum(['development', 'test', 'production']);
const maximumSignedBigint = 9_223_372_036_854_775_807n;

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

const realtimeWorkerTokenSchema = z.string().regex(/^[A-Za-z0-9._~-]{32,512}$/u);
const localRealtimeWorkerToken = 'local-development-realtime-worker-token-00000001';

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
    REALTIME_WORKER_TOKEN: realtimeWorkerTokenSchema,
    STRIPE_FUNDING_ENABLED: z.enum(['false', 'true']).default('false'),
    STRIPE_SECRET_KEY: z
      .string()
      .regex(/^sk_test_[A-Za-z0-9_]{8,240}$/u)
      .optional(),
    STRIPE_WEBHOOK_BODY_LIMIT_BYTES: z.coerce
      .number()
      .int()
      .min(1_024)
      .max(1_048_576)
      .default(262_144),
    STRIPE_WEBHOOK_SECRET: z
      .string()
      .regex(/^whsec_[A-Za-z0-9_]{8,240}$/u)
      .optional(),
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
    if (environment.STRIPE_FUNDING_ENABLED === 'true') {
      if (environment.NODE_ENV !== 'development' && environment.NODE_ENV !== 'test') {
        context.addIssue({
          code: 'custom',
          message: 'Stripe test-mode funding requires an explicit development or test runtime.',
          path: ['STRIPE_FUNDING_ENABLED'],
        });
      }
      if (environment.STRIPE_SECRET_KEY === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'Stripe funding requires a test-mode API secret.',
          path: ['STRIPE_SECRET_KEY'],
        });
      }
      if (environment.STRIPE_WEBHOOK_SECRET === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'Stripe funding requires a webhook signing secret.',
          path: ['STRIPE_WEBHOOK_SECRET'],
        });
      }
    }
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
    if (
      environment.REALTIME_WORKER_TOKEN === localRealtimeWorkerToken &&
      environment.NODE_ENV !== 'development' &&
      environment.NODE_ENV !== 'test'
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'The local realtime worker token requires an explicit development or test runtime.',
        path: ['REALTIME_WORKER_TOKEN'],
      });
    }
  });

const postgresConnectionStringSchema = z.url().refine(
  (value) => {
    const protocol = new URL(value).protocol;
    return protocol === 'postgres:' || protocol === 'postgresql:';
  },
  { message: 'Expected a postgres:// or postgresql:// connection string.' },
);

const workerEnvironmentSchema = z
  .object({
    NODE_ENV: runtimeModeSchema.optional(),
    WORKER_DATABASE_APPLICATION_NAME: z
      .string()
      .trim()
      .min(1)
      .max(63)
      .default('creatordrop-worker'),
    DATABASE_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5000),
    DATABASE_IDLE_TIMEOUT_MS: z.coerce.number().int().min(100).max(300_000).default(10_000),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
    OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(25),
    OUTBOX_LEASE_MS: z.coerce.number().int().min(5_000).max(300_000).default(30_000),
    OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(8),
    OUTBOX_RETRY_BASE_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
    OUTBOX_RETRY_MAX_MS: z.coerce.number().int().min(100).max(3_600_000).default(60_000),
    REALTIME_PUBLISH_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5_000),
    REALTIME_URL: browserOriginSchema,
    REALTIME_WORKER_TOKEN: realtimeWorkerTokenSchema,
    WORKER_DATABASE_URL: postgresConnectionStringSchema,
    WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1000),
  })
  .superRefine((environment, context) => {
    if (environment.OUTBOX_RETRY_BASE_MS > environment.OUTBOX_RETRY_MAX_MS) {
      context.addIssue({
        code: 'custom',
        message: 'The retry base delay cannot exceed the maximum delay.',
        path: ['OUTBOX_RETRY_BASE_MS'],
      });
    }
    if (environment.REALTIME_PUBLISH_TIMEOUT_MS >= environment.OUTBOX_LEASE_MS) {
      context.addIssue({
        code: 'custom',
        message: 'The realtime publish timeout must be shorter than the outbox lease.',
        path: ['REALTIME_PUBLISH_TIMEOUT_MS'],
      });
    }
    if (
      environment.REALTIME_WORKER_TOKEN === localRealtimeWorkerToken &&
      environment.NODE_ENV !== 'development' &&
      environment.NODE_ENV !== 'test'
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'The local realtime worker token requires an explicit development or test runtime.',
        path: ['REALTIME_WORKER_TOKEN'],
      });
    }
  });

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
  realtimeWorkerToken: string;
  requestBodyLimitBytes: number;
  stripeFundingEnabled: boolean;
  stripeSecretKey: string | null;
  stripeWebhookBodyLimitBytes: number;
  stripeWebhookSecret: string | null;
  testCreditsEnabled: boolean;
  walletMutationRateLimitMax: number;
  walletMutationRateLimitWindowMs: number;
}>;

export type WorkerEnvironment = Readonly<{
  batchSize: number;
  database: DatabaseEnvironment;
  leaseMs: number;
  maxAttempts: number;
  nodeEnvironment: z.infer<typeof runtimeModeSchema>;
  pollIntervalMs: number;
  publishTimeoutMs: number;
  realtimeUrl: string;
  realtimeWorkerToken: string;
  retryBaseMs: number;
  retryMaxMs: number;
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
    realtimeWorkerToken: parsed.REALTIME_WORKER_TOKEN,
    requestBodyLimitBytes: parsed.REQUEST_BODY_LIMIT_BYTES,
    stripeFundingEnabled: parsed.STRIPE_FUNDING_ENABLED === 'true',
    stripeSecretKey: parsed.STRIPE_SECRET_KEY ?? null,
    stripeWebhookBodyLimitBytes: parsed.STRIPE_WEBHOOK_BODY_LIMIT_BYTES,
    stripeWebhookSecret: parsed.STRIPE_WEBHOOK_SECRET ?? null,
    testCreditsEnabled: parsed.WALLET_TEST_CREDITS_ENABLED === 'true',
    walletMutationRateLimitMax: parsed.WALLET_MUTATION_RATE_LIMIT_MAX,
    walletMutationRateLimitWindowMs: parsed.WALLET_MUTATION_RATE_LIMIT_WINDOW_MS,
  };
};

export const parseWorkerEnvironment = (input: NodeJS.ProcessEnv): WorkerEnvironment => {
  const parsed = workerEnvironmentSchema.parse(input);

  return {
    batchSize: parsed.OUTBOX_BATCH_SIZE,
    database: {
      applicationName: parsed.WORKER_DATABASE_APPLICATION_NAME,
      connectionString: parsed.WORKER_DATABASE_URL,
      connectionTimeoutMs: parsed.DATABASE_CONNECTION_TIMEOUT_MS,
      idleTimeoutMs: parsed.DATABASE_IDLE_TIMEOUT_MS,
      maxConnections: parsed.DATABASE_POOL_MAX,
    },
    leaseMs: parsed.OUTBOX_LEASE_MS,
    maxAttempts: parsed.OUTBOX_MAX_ATTEMPTS,
    nodeEnvironment: parsed.NODE_ENV ?? 'development',
    pollIntervalMs: parsed.WORKER_POLL_INTERVAL_MS,
    publishTimeoutMs: parsed.REALTIME_PUBLISH_TIMEOUT_MS,
    realtimeUrl: parsed.REALTIME_URL,
    realtimeWorkerToken: parsed.REALTIME_WORKER_TOKEN,
    retryBaseMs: parsed.OUTBOX_RETRY_BASE_MS,
    retryMaxMs: parsed.OUTBOX_RETRY_MAX_MS,
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
