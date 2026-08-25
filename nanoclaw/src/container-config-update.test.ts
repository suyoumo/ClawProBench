import { describe, expect, it, vi } from 'vitest';

import { updateContainerConfigThenRestart } from './container-config-update.js';

describe('updateContainerConfigThenRestart', () => {
  it('persists updates before restarting the agent group', () => {
    const calls: string[] = [];
    const update = vi.fn(() => calls.push('update'));
    const restart = vi.fn(() => {
      calls.push('restart');
      return 2;
    });

    const restarted = updateContainerConfigThenRestart(
      'group-1',
      { provider: 'opencode', model: 'deepseek/deepseek-v4-flash' },
      { update, restart },
    );

    expect(restarted).toBe(2);
    expect(calls).toEqual(['update', 'restart']);
    expect(update).toHaveBeenCalledWith('group-1', {
      provider: 'opencode',
      model: 'deepseek/deepseek-v4-flash',
    });
    expect(restart).toHaveBeenCalledWith('group-1', 'container config updated');
  });

  it('does not restart when persistence fails', () => {
    const update = vi.fn(() => {
      throw new Error('disk full');
    });
    const restart = vi.fn();

    expect(() =>
      updateContainerConfigThenRestart('group-1', { model: 'glm/glm-5-turbo' }, { update, restart }),
    ).toThrow('disk full');
    expect(restart).not.toHaveBeenCalled();
  });
});
