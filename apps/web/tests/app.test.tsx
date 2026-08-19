import { describe, expect, it } from 'vitest';

import { App } from '../src/app.js';

describe('web application shell', () => {
  it('contains no product UI in Phase 1', () => {
    expect(App()).toBeNull();
  });
});
