export interface WorkerRuntime {
  stop(): void;
}

export interface WorkerRuntimeOptions {
  readonly pollIntervalMs: number;
  readonly schedule?: (callback: () => void, milliseconds: number) => NodeJS.Timeout;
  readonly unschedule?: (timer: NodeJS.Timeout) => void;
}

export const startWorkerRuntime = ({
  pollIntervalMs,
  schedule = setInterval,
  unschedule = clearInterval,
}: WorkerRuntimeOptions): WorkerRuntime => {
  const timer = schedule(() => undefined, pollIntervalMs);

  return {
    stop: () => unschedule(timer),
  };
};
