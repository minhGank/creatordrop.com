import { z } from 'zod';

const runtimeModeSchema = z.enum(['development', 'test', 'production']);

const sharedNodeEnvironmentShape = {
  NODE_ENV: runtimeModeSchema.default('development'),
} as const;

const apiEnvironmentSchema = z.object({
  ...sharedNodeEnvironmentShape,
  HOST: z.string().trim().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
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
  host: string;
  nodeEnvironment: z.infer<typeof runtimeModeSchema>;
  port: number;
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
    host: parsed.HOST,
    nodeEnvironment: parsed.NODE_ENV,
    port: parsed.PORT,
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
