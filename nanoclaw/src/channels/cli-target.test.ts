import { describe, expect, it } from 'vitest';

import { requireUniqueCliTarget } from './cli-target.js';

describe('requireUniqueCliTarget', () => {
  it('fails closed when cli/local has no target', () => {
    expect(() => requireUniqueCliTarget([])).toThrow(/not wired/i);
  });

  it('returns the sole target unchanged', () => {
    const target = { agent_group_id: 'benchmark-agent' };

    expect(requireUniqueCliTarget([target])).toBe(target);
  });

  it('fails closed when cli/local has multiple targets', () => {
    expect(() => requireUniqueCliTarget(['first', 'second'])).toThrow(/ambiguous: 2/i);
  });
});
