import { z } from 'zod';

const runtimeModeSchema = z.enum(['development', 'test', 'production']);

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

const apiEnvironmentSchema = z.object({
  ...sharedNodeEnvironmentShape,
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
    nodeEnvironment: parsed.NODE_ENV,
    port: parsed.PORT,
    requestBodyLimitBytes: parsed.REQUEST_BODY_LIMIT_BYTES,
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
