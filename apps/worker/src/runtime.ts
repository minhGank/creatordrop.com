export interface WorkerRuntime {
  stop(): Promise<void>;
}

export interface WorkerRuntimeOptions {
  readonly pollIntervalMs: number;
  readonly runBatch: () => Promise<unknown>;
  readonly schedule?: (callback: () => void, milliseconds: number) => NodeJS.Timeout;
  readonly unschedule?: (timer: NodeJS.Timeout) => void;
}

export const startWorkerRuntime = ({
  pollIntervalMs,
  runBatch,
  schedule = setTimeout,
  unschedule = clearTimeout,
}: WorkerRuntimeOptions): WorkerRuntime => {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let active: Promise<void> = Promise.resolve();

  const run = (): void => {
    active = runBatch()
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        if (!stopped) timer = schedule(run, pollIntervalMs);
      });
  };
  run();

  return {
    stop: async () => {
      stopped = true;
      if (timer !== undefined) unschedule(timer);
      await active;
    },
  };
};
