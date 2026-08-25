import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildOpenCodeContainerContribution, upstreamBaseUrlFromModel } from './opencode.js';
import type { ProviderContainerContext } from './provider-container-registry.js';

const TEST_ROOT = '/tmp/nanoclaw-opencode-provider-test';

afterEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

function context(overrides: Partial<ProviderContainerContext> = {}): ProviderContainerContext {
  return {
    provider: 'opencode',
    model: 'deepseek/deepseek-v4-flash',
    sessionDir: path.join(TEST_ROOT, 'session'),
    agentGroupId: 'group-1',
    groupDir: path.join(TEST_ROOT, 'group'),
    selectedSkills: [],
    hostEnv: {
      OPENCODE_PROVIDER: 'host-provider',
      OPENCODE_MODEL: 'host-model',
      OPENCODE_SMALL_MODEL: 'host-small-model',
      NO_PROXY: 'example.internal',
    },
    ...overrides,
  };
}

describe('buildOpenCodeContainerContribution', () => {
  it('uses the persisted model and its upstream provider, not host OPENCODE settings', () => {
    const contribution = buildOpenCodeContainerContribution(context());

    expect(contribution.env).toMatchObject({
      XDG_DATA_HOME: '/opencode-xdg',
      OPENCODE_PROVIDER: 'deepseek',
      OPENCODE_MODEL: 'deepseek/deepseek-v4-flash',
      OPENCODE_BASE_URL: 'https://api.deepseek.com',
    });
    expect(contribution.env).not.toHaveProperty('OPENCODE_SMALL_MODEL');
    expect(contribution.env?.NO_PROXY).toContain('example.internal');
    expect(contribution.env?.NO_PROXY).toContain('127.0.0.1');
    expect(contribution.mounts).toEqual([
      { hostPath: path.join(TEST_ROOT, 'session', 'opencode-xdg'), containerPath: '/opencode-xdg', readonly: false },
    ]);
  });

  it('uses anthropic as the upstream fallback when no persisted model is set', () => {
    const contribution = buildOpenCodeContainerContribution(context({ model: undefined }));

    expect(contribution.env).toMatchObject({ OPENCODE_PROVIDER: 'anthropic' });
    expect(contribution.env).not.toHaveProperty('OPENCODE_MODEL');
    expect(contribution.env).not.toHaveProperty('OPENCODE_BASE_URL');
  });

  it('maps each fixed benchmark provider to its exact upstream endpoint', () => {
    expect(upstreamBaseUrlFromModel('volcengine-plan/kimi-k2.6')).toBe('https://ark.cn-beijing.volces.com/api/coding/v3');
    expect(upstreamBaseUrlFromModel('glm/glm-5-turbo')).toBe('https://open.bigmodel.cn/api/coding/paas/v4');
    expect(upstreamBaseUrlFromModel('deepseek/deepseek-v4-flash')).toBe('https://api.deepseek.com');
    expect(upstreamBaseUrlFromModel('bailian-compatible/qwen3.6-plus')).toBe('https://coding.dashscope.aliyuncs.com/v1');
  });
});
