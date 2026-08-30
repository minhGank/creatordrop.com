import { describe, expect, it, vi } from 'vitest';

import { startWorkerRuntime } from '../src/runtime.js';

describe('worker runtime', () => {
  it('runs immediately, schedules only after completion, and drains on stop', async () => {
    const timer = Symbol('timer') as unknown as NodeJS.Timeout;
    const schedule = vi.fn(() => timer);
    const unschedule = vi.fn();
    const runBatch = vi.fn(() => Promise.resolve());

    const runtime = startWorkerRuntime({ pollIntervalMs: 500, runBatch, schedule, unschedule });
    await vi.waitFor(() => expect(schedule).toHaveBeenCalledWith(expect.any(Function), 500));
    await runtime.stop();

    expect(runBatch).toHaveBeenCalledOnce();
    expect(unschedule).toHaveBeenCalledWith(timer);
  });
});
