import { describe, expect, it, vi } from 'vitest';

import { startWorkerRuntime } from '../src/runtime.js';

describe('worker runtime', () => {
  it('starts and stops the infrastructure-only lifecycle', () => {
    const timer = Symbol('timer') as unknown as NodeJS.Timeout;
    const schedule = vi.fn(() => timer);
    const unschedule = vi.fn();

    const runtime = startWorkerRuntime({ pollIntervalMs: 500, schedule, unschedule });
    runtime.stop();

    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 500);
    expect(unschedule).toHaveBeenCalledWith(timer);
  });
});
