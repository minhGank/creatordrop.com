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

export type ApiEnvironment = Readonly<{
  host: string;
  nodeEnvironment: z.infer<typeof runtimeModeSchema>;
  port: number;
}>;

export type WorkerEnvironment = Readonly<{
  nodeEnvironment: z.infer<typeof runtimeModeSchema>;
  pollIntervalMs: number;
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
